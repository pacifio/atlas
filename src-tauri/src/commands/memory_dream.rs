//! The dream pass in the app (memory plan M4): when to dream, the model
//! call, keeping the proposals, and applying one the user accepted.
//!
//! - **When.** Setting `memoryDreams` on, sharing on, a model route (the same
//!   route and consent as extraction), the last dream, or the last attempt
//!   at one that failed, at least [`DREAM_EVERY_MS`] old, and at least one
//!   handoff note since the last dream. The first dream reads the newest
//!   notes whatever their age.
//! - **What it sends.** The handoff notes (with what the recorded session
//!   did, minus any tool output) and the active and candidate memories, all
//!   cleaned and redacted by `atlas_memory::dream`. Never a transcript.
//! - **What it writes.** One `dreams` row and a pending proposal per
//!   surviving operation. Never memory: an accepted proposal is re-checked
//!   and applied through the ordinary write paths, with source `dream`.

use std::sync::Arc;
use std::time::Duration;

use atlas_memory::dream::{self, DreamInput, DreamMemory, DreamOp};
use atlas_memory::record::{self, EntryKind, NewEntry, RecordStore, State};
use tauri::{AppHandle, Manager};

use super::memory_capture::CaptureReader;
use super::memory_extract::{ExtractionModel, Route};
use super::shared_memory::{store_for, SharedMemoryStore};

/// A scope dreams at most this often.
pub const DREAM_EVERY_MS: i64 = 20 * 3600 * 1000;
/// Ceiling on the model call.
const DREAM_TIMEOUT: Duration = Duration::from_secs(60);
/// The provenance of every entry an accepted proposal writes.
pub const DREAM_SOURCE: &str = "dream";
const DAY_MS: i64 = 24 * 3600 * 1000;

/// One dream for `cwd` if it is due. Returns the dream id, or `None` when it
/// was not due, not allowed, or there was nothing new to read.
pub async fn dream_if_due(app: &AppHandle, cwd: &str, now: i64) -> Result<Option<i64>, String> {
    let enabled = super::project_settings::effective_settings_for(app, std::path::Path::new(cwd))
        .is_some_and(|settings| settings.memory_dreams);
    if !enabled {
        return Ok(None);
    }
    let Some(extractor) = app.try_state::<Arc<super::memory_extract::Extractor>>() else {
        return Ok(None);
    };
    let sharing = app.state::<super::memory_sharing::MemorySharingState>();
    let Some(route) = extractor.route(&sharing, cwd) else {
        return Ok(None);
    };
    let memory = app.state::<SharedMemoryStore>().inner().clone();
    let reader = CaptureReader {
        transcripts_dir: app
            .try_state::<Arc<super::agent_transcript::TranscriptState>>()
            .map(|t| t.config_dir().to_path_buf()),
    };
    dream(
        memory,
        extractor.model(),
        route,
        reader,
        cwd.to_string(),
        now,
    )
    .await
}

/// Dream for `cwd` now if it is due, through `model` on `route`.
pub async fn dream(
    memory: SharedMemoryStore,
    model: Arc<dyn ExtractionModel>,
    route: Route,
    reader: CaptureReader,
    cwd: String,
    now: i64,
) -> Result<Option<i64>, String> {
    let (c, r) = (cwd.clone(), reader);
    let prepared = tokio::task::spawn_blocking(move || prepare(&r, &c, now))
        .await
        .map_err(|e| e.to_string())??;
    let Some((input, episodes_to)) = prepared else {
        return Ok(None);
    };
    let prompt = dream::build_prompt(&input);
    let answer =
        match tokio::time::timeout(DREAM_TIMEOUT, model.complete(route.clone(), prompt)).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(e)) => return Err(format!("dream not run: {e}")),
            Err(_) => {
                return Err(format!(
                    "dream not run: no answer in {}s",
                    DREAM_TIMEOUT.as_secs()
                ))
            }
        };
    let (kept, dropped) = dream::validate(dream::parse_ops(&answer), &input);
    // The revision each memory was at when the prompt was built: an entry
    // that moved during the model call is then obsolete at accept.
    let seen: std::collections::BTreeMap<i64, i64> =
        input.memories.iter().map(|m| (m.id, m.revision)).collect();
    let model_name = match &route {
        Route::Gateway => "gateway".to_string(),
        Route::Byok { provider, model } => format!("{provider}/{model}"),
    };
    let id = tokio::task::spawn_blocking(move || {
        let store = store_for(&cwd)?;
        let id = store
            .record_dream(now, &model_name, episodes_to, &kept, &dropped, &seen)
            .map_err(|e| format!("{e:#}"))?;
        if !kept.is_empty() {
            memory.announce(&store, &[]);
        }
        Ok::<_, String>(id)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(id))
}

/// What a due dream reads, and the newest episode end in it; `None` when it
/// is not due or nothing new happened. Blocking.
fn prepare(
    reader: &CaptureReader,
    cwd: &str,
    now: i64,
) -> Result<Option<(DreamInput, i64)>, String> {
    let store = store_for(cwd)?;
    let e = |e: anyhow::Error| format!("{e:#}");
    let last = store.last_dream().map_err(e)?;
    // An attempt that failed or timed out counts: its prompt was sent.
    let attempted = store.last_dream_attempt().map_err(e)?;
    if last
        .map(|(at, _)| at)
        .max(attempted)
        .is_some_and(|at| now - at < DREAM_EVERY_MS)
    {
        return Ok(None);
    }
    let mut episodes = match last {
        // The first dream seeds memory from the recent sessions.
        None => store.recent_episodes(dream::MAX_EPISODES).map_err(e)?,
        Some((_, to)) => store.episodes_since(to, dream::MAX_EPISODES).map_err(e)?,
    };
    let Some(episodes_to) = episodes.iter().map(|n| n.ended_at).max() else {
        return Ok(None);
    };
    // What each recorded session did, without any tool output.
    let stores = reader.stores(cwd);
    for note in &mut episodes {
        if let Some(found) = stores.find(&note.session) {
            note.apply_facts(super::memory_capture::session_facts(&found).for_dream());
        }
        // The title is the user's opening prompt, not something the session did.
        note.title = None;
    }
    let memories = dream_memories(&store, now).map_err(e)?;
    // Noted before the model is called, so a failing route is not asked
    // again on every health pass.
    store.record_dream_attempt(now).map_err(e)?;
    Ok(Some((DreamInput { episodes, memories }, episodes_to)))
}

/// The active and candidate entries a dream sees, by id, at most
/// [`dream::MAX_MEMORIES`], each with whether it is protected and what its
/// citations say.
fn dream_memories(store: &RecordStore, now: i64) -> anyhow::Result<Vec<DreamMemory>> {
    let mut entries = store.durable_active()?;
    entries.extend(store.list_state(State::Candidate, 200)?);
    entries.sort_by_key(|e| e.id);
    entries.dedup_by_key(|e| e.id);
    entries.truncate(dream::MAX_MEMORIES);
    let files = atlas_memory::citation::FileResolver::new(store.root());
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        let validity = {
            let each: Vec<atlas_memory::citation::Validity> = e
                .citations()
                .iter()
                .map(|c| atlas_memory::citation::validate(c, &files).0)
                .collect();
            atlas_memory::citation::overall(&each).map(|v| v.as_str().to_string())
        };
        let protected = e.kind == EntryKind::Preference || store.last_written_by_user(e.id)?;
        out.push(DreamMemory {
            id: e.id,
            revision: e.rev,
            kind: e.kind.as_str().to_string(),
            content: e.content,
            state: e.state.as_str().to_string(),
            uses: i64::from(e.uses),
            last_used_days: (now - e.last_used_at.unwrap_or(e.updated_at)).max(0) / DAY_MS,
            validity,
            protected,
        });
    }
    Ok(out)
}

/// Apply proposal `id` the user accepted, after checking it still fits the
/// record: every entry it names is live (and not protected) and at the
/// revision it was at when the dream was recorded. Returns the proposal's
/// new status: `accepted`, or `obsolete` when the check failed and nothing
/// was written.
pub fn accept(memory: &SharedMemoryStore, cwd: &str, id: i64) -> Result<&'static str, String> {
    let store = store_for(cwd)?;
    let e = |e: anyhow::Error| format!("{e:#}");
    let Some(proposal) = store.proposal(id).map_err(e)? else {
        return Err(format!("no dream proposal {id}"));
    };
    if proposal.status != record::PROPOSAL_PENDING {
        return Err(format!("proposal {id} is already {}", proposal.status));
    }
    // Claimed first, so a second accept (a double click) never applies it
    // again.
    if !store.claim_proposal(id).map_err(e)? {
        return Err(format!("proposal {id} is already being accepted"));
    }
    let status = match apply(memory, &store, cwd, proposal) {
        Ok(status) => status,
        Err(err) => {
            // Back to pending, so it can be accepted again.
            store
                .set_proposal_status(id, record::PROPOSAL_PENDING)
                .map_err(e)?;
            return Err(err);
        }
    };
    store.set_proposal_status(id, status).map_err(e)?;
    Ok(status)
}

/// Apply a claimed `proposal` if it still fits the record: `accepted`, or
/// `obsolete` when it no longer does and nothing was written.
fn apply(
    memory: &SharedMemoryStore,
    store: &RecordStore,
    cwd: &str,
    proposal: record::DreamProposal,
) -> Result<&'static str, String> {
    let e = |e: anyhow::Error| format!("{e:#}");
    if !still_fits(store, &proposal).map_err(e)? {
        return Ok("obsolete");
    }
    let now = memory.now();
    match proposal.op {
        DreamOp::Add {
            kind,
            content,
            sessions,
            ..
        } => {
            let kind = EntryKind::parse(&kind).ok_or_else(|| format!("unknown kind `{kind}`"))?;
            // Attributed to the session it was learned in.
            let session = sessions.first().cloned().unwrap_or_default();
            let agent = store
                .episode_of(&session)
                .map_err(e)?
                .map(|n| n.agent)
                .unwrap_or_default();
            store
                .remember(
                    NewEntry {
                        kind,
                        key: String::new(),
                        content,
                        source: DREAM_SOURCE.to_string(),
                        agent,
                        session_id: session,
                        confidence: record::PROMOTED_CONFIDENCE,
                        at: now,
                    },
                    now,
                )
                .map_err(e)?;
            memory.announce(store, &[kind.as_str()]);
        }
        DreamOp::Merge { keep, drop, .. } => {
            memory.merge(cwd, keep, &drop)?;
        }
        DreamOp::Archive { id: entry, .. } => {
            memory.archive(cwd, &[entry])?;
        }
        DreamOp::Rewrite {
            id: entry,
            revision,
            content,
            ..
        } => {
            // The wording only: a candidate stays a candidate, and an entry
            // written since the check is left alone.
            let Some(edited) = store
                .edit_guarded(entry, &content, DREAM_SOURCE, now, revision)
                .map_err(e)?
            else {
                return Ok("obsolete");
            };
            memory.announce(store, &[edited.kind.as_str()]);
        }
        DreamOp::Link { a, b, rel, .. } => {
            // `link` stores a `contradicts` pair as (min, max), the order
            // resolving the conflict unlinks.
            store.link(a, b, &rel, now, DREAM_SOURCE).map_err(e)?;
            memory.announce(store, &[]);
        }
    }
    Ok("accepted")
}

/// Whether `proposal` still applies to the record as it is now.
fn still_fits(store: &RecordStore, proposal: &record::DreamProposal) -> anyhow::Result<bool> {
    let op = &proposal.op;
    for id in op.ids() {
        let Some(entry) = store.peek(id)? else {
            return Ok(false);
        };
        if entry.state == State::Archived {
            return Ok(false);
        }
        // Rewritten, replaced or judged since the dream.
        if proposal.revs.get(&id).is_some_and(|rev| *rev != entry.rev) {
            return Ok(false);
        }
        let touches = !matches!(op, DreamOp::Link { .. })
            && !matches!(op, DreamOp::Merge { keep, .. } if *keep == id);
        if touches && (entry.kind == EntryKind::Preference || store.last_written_by_user(id)?) {
            return Ok(false);
        }
        if let DreamOp::Rewrite { revision, .. } = op {
            if entry.rev != *revision {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Dismiss proposal `id`: kept, never applied.
pub fn dismiss(cwd: &str, id: i64) -> Result<(), String> {
    store_for(cwd)?
        .set_proposal_status(id, "dismissed")
        .map_err(|e| format!("{e:#}"))
}

/// Accept a nightly-review proposal from the Review tab. Returns its new
/// status: `accepted`, or `obsolete` when memory moved on since.
#[tauri::command]
pub async fn memory_dream_accept(
    project_path: String,
    id: i64,
    store: tauri::State<'_, SharedMemoryStore>,
) -> Result<String, String> {
    let memory = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        accept(&memory, &project_path, id).map(str::to_string)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Dismiss a nightly-review proposal from the Review tab.
#[tauri::command]
pub async fn memory_dream_dismiss(project_path: String, id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || dismiss(&project_path, id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use parking_lot::Mutex;

    use super::*;
    use crate::commands::memory_extract::Completion;
    use crate::commands::memory_pack::test_support::scratch_project;
    use crate::commands::shared_memory::Writer;
    use atlas_memory::handoff::HandoffNote;
    use atlas_memory::record::Entry;

    /// A model that answers `answer` and keeps every prompt it was sent.
    struct Fake {
        answer: Result<String, String>,
        prompts: Mutex<Vec<String>>,
        calls: AtomicUsize,
    }

    impl Fake {
        fn new(answer: &str) -> Arc<Self> {
            Self::answering(Ok(answer.to_string()))
        }

        /// A model whose every call fails.
        fn failing() -> Arc<Self> {
            Self::answering(Err("gateway unavailable".to_string()))
        }

        fn answering(answer: Result<String, String>) -> Arc<Self> {
            Arc::new(Self {
                answer,
                prompts: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            })
        }
    }

    impl ExtractionModel for Fake {
        fn signed_in(&self) -> bool {
            true
        }

        fn complete(&self, _route: Route, prompt: String) -> Completion<'_> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.prompts.lock().push(prompt);
            let answer = self.answer.clone();
            Box::pin(async move { answer })
        }
    }

    /// A note whose plan is `decision`: a decision itself reaches the dream
    /// only while an active entry holds it.
    fn note(session: &str, ended_at: i64, decision: &str) -> HandoffNote {
        HandoffNote {
            session: session.into(),
            agent: "claude-code".into(),
            ended_at,
            plan: Some(decision.into()),
            decisions: vec![decision.into()],
            ..Default::default()
        }
    }

    /// The single pending proposal `answer` leaves after one dream.
    async fn propose(memory: &SharedMemoryStore, p: &str, answer: &str) -> i64 {
        store_for(p)
            .unwrap()
            .record_episode(&note("s-a", 900, "Use EdDSA"))
            .unwrap();
        run(memory, &Fake::new(answer), p, 1_000)
            .await
            .expect("dreamed");
        let pending = store_for(p)
            .unwrap()
            .dream_proposals(record::PROPOSAL_PENDING)
            .unwrap();
        assert_eq!(pending.len(), 1, "the op survived validation");
        pending[0].0
    }

    fn decision(memory: &SharedMemoryStore, p: &str, content: &str, key: &str) -> Entry {
        let writer = Writer {
            agent: "codex".into(),
            session_id: "s-z".into(),
        };
        memory
            .remember(p, &writer, EntryKind::Decision, content, key, None, &[])
            .unwrap()
            .entry
    }

    async fn run(memory: &SharedMemoryStore, fake: &Arc<Fake>, p: &str, now: i64) -> Option<i64> {
        dream(
            memory.clone(),
            fake.clone(),
            Route::Gateway,
            CaptureReader::default(),
            p.to_string(),
            now,
        )
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dream_runs_at_most_once_a_day_and_only_after_new_work() {
        let p = scratch_project("dream-due");
        let memory = SharedMemoryStore::new();
        let fake = Fake::new("{\"ops\":[]}");
        let store = store_for(&p).unwrap();
        assert_eq!(
            run(&memory, &fake, &p, 1_000).await,
            None,
            "nothing to read"
        );
        store
            .record_episode(&note("s-a", 900, "Use EdDSA"))
            .unwrap();
        assert!(run(&memory, &fake, &p, 1_000).await.is_some());
        assert_eq!(run(&memory, &fake, &p, 2_000).await, None, "under a day");
        let later = 1_000 + DREAM_EVERY_MS + 1;
        assert_eq!(run(&memory, &fake, &p, later).await, None, "no new session");
        store
            .record_episode(&note("s-b", later - 10, "Use Postgres"))
            .unwrap();
        assert!(run(&memory, &fake, &p, later).await.is_some());
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        let second = fake.prompts.lock()[1].clone();
        assert!(second.contains("Use Postgres") && !second.contains("Use EdDSA"));
        let _ = std::fs::remove_dir_all(&p);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn accepting_an_add_writes_an_entry_sourced_to_its_session() {
        let p = scratch_project("dream-add");
        let memory = SharedMemoryStore::new();
        let fake = Fake::new(
            "{\"ops\":[{\"op\":\"add\",\"kind\":\"failure\",\"content\":\"ring 0.16 can't parse PKCS#8 v2\",\"sessions\":[\"s-a\"],\"why\":\"seen twice\"}]}",
        );
        let store = store_for(&p).unwrap();
        store
            .record_episode(&note("s-a", 900, "Use EdDSA"))
            .unwrap();
        run(&memory, &fake, &p, 1_000).await.expect("dreamed");
        let pending = store.dream_proposals(record::PROPOSAL_PENDING).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(accept(&memory, &p, pending[0].0).unwrap(), "accepted");
        let added = memory
            .list_entries(&p, Some(EntryKind::Failure))
            .into_iter()
            .find(|e| e.content.contains("PKCS#8"))
            .expect("written");
        assert_eq!(added.source, DREAM_SOURCE);
        let sources = store.sources_for(&[added.id]).unwrap();
        assert_eq!(sources[&added.id][0].session, "s-a");
        assert!(accept(&memory, &p, pending[0].0).is_err(), "only once");
        let _ = std::fs::remove_dir_all(&p);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_rewrite_whose_entry_moved_on_is_obsolete() {
        let p = scratch_project("dream-obsolete");
        let memory = SharedMemoryStore::new();
        let writer = Writer {
            agent: "codex".into(),
            session_id: "s-z".into(),
        };
        let entry = memory
            .remember(
                &p,
                &writer,
                EntryKind::Decision,
                "Sign JWTs with EdDSA because ring supports it",
                "auth.alg",
                None,
                &[],
            )
            .unwrap()
            .entry;
        let answer = format!(
            "{{\"ops\":[{{\"op\":\"rewrite\",\"id\":{},\"revision\":{},\"content\":\"Sign JWTs with EdDSA; ring 0.17 supports it\",\"why\":\"clearer\"}}]}}",
            entry.id, entry.rev
        );
        let fake = Fake::new(&answer);
        let store = store_for(&p).unwrap();
        store
            .record_episode(&note("s-a", 900, "Use EdDSA"))
            .unwrap();
        run(&memory, &fake, &p, 1_000).await.expect("dreamed");
        let pending = store.dream_proposals(record::PROPOSAL_PENDING).unwrap();
        assert_eq!(pending.len(), 1, "the rewrite survived validation");
        // The same session writes the entry again: its revision moves on.
        memory
            .remember(
                &p,
                &writer,
                EntryKind::Decision,
                "Sign JWTs with EdDSA (ring 0.17)",
                "auth.alg",
                None,
                &[],
            )
            .unwrap();
        assert_eq!(accept(&memory, &p, pending[0].0).unwrap(), "obsolete");
        assert_eq!(
            memory.get_entry(&p, entry.id).unwrap().unwrap().content,
            "Sign JWTs with EdDSA (ring 0.17)"
        );
        let _ = std::fs::remove_dir_all(&p);
    }

    /// The dream sees what a recorded session tried and failed, never what
    /// the failing tool printed.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_dream_sees_what_sessions_did_but_no_tool_output() {
        use crate::commands::memory_capture::test_support::Recording;
        let p = scratch_project("dream-facts");
        let memory = SharedMemoryStore::new();
        let fake = Fake::new("{\"ops\":[]}");
        let mut rec = Recording::open_turn(&p, "s-a", "claude-code", "Move auth to EdDSA");
        rec.fail("cargo test -p auth", "error: secret-token-xyz");
        rec.close_turn();
        drop(rec);
        store_for(&p)
            .unwrap()
            .record_episode(&note("s-a", 900, "Use EdDSA"))
            .unwrap();
        run(&memory, &fake, &p, 1_000).await.expect("dreamed");
        let prompt = fake.prompts.lock()[0].clone();
        assert!(prompt.contains("cargo test -p auth"), "{prompt}");
        assert!(!prompt.contains("secret-token-xyz"), "{prompt}");
        assert!(!prompt.contains("Move auth to EdDSA"), "no opening prompt");
        let _ = std::fs::remove_dir_all(&p);
    }

    /// A dream whose model call fails still sent its prompt: it is not
    /// tried again until the next dream is due.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_dream_waits_a_day_before_trying_again() {
        let p = scratch_project("dream-retry");
        let memory = SharedMemoryStore::new();
        let fake = Fake::failing();
        store_for(&p)
            .unwrap()
            .record_episode(&note("s-a", 900, "Use EdDSA"))
            .unwrap();
        let attempt = |now| {
            dream(
                memory.clone(),
                fake.clone(),
                Route::Gateway,
                CaptureReader::default(),
                p.clone(),
                now,
            )
        };
        assert!(attempt(1_000).await.is_err());
        assert_eq!(attempt(2_000).await, Ok(None), "not on the next pass");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert!(attempt(1_000 + DREAM_EVERY_MS).await.is_err());
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        let _ = std::fs::remove_dir_all(&p);
    }

    /// Accepting a new wording changes only the wording: a candidate stays a
    /// candidate, with its confidence and its session.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_rewrite_keeps_a_candidate_a_candidate() {
        let p = scratch_project("dream-rewrite-candidate");
        let memory = SharedMemoryStore::new();
        let store = store_for(&p).unwrap();
        let entry = store
            .remember(
                NewEntry {
                    kind: EntryKind::Decision,
                    key: String::new(),
                    content: "always force-push".into(),
                    source: "import".into(),
                    agent: "codex".into(),
                    session_id: "s-z".into(),
                    confidence: record::CANDIDATE_CONFIDENCE,
                    at: 500,
                },
                500,
            )
            .unwrap()
            .entry;
        assert_eq!(entry.state, State::Candidate);
        let answer = format!(
            "{{\"ops\":[{{\"op\":\"rewrite\",\"id\":{},\"revision\":{},\"content\":\"Always force-push feature branches\",\"why\":\"clearer\"}}]}}",
            entry.id, entry.rev
        );
        let id = propose(&memory, &p, &answer).await;
        assert_eq!(accept(&memory, &p, id).unwrap(), "accepted");
        let after = store.peek(entry.id).unwrap().unwrap();
        assert_eq!(after.content, "Always force-push feature branches");
        assert_eq!(after.state, State::Candidate);
        assert_eq!(after.confidence, record::CANDIDATE_CONFIDENCE);
        assert_eq!(after.session_id, "s-z");
        let _ = std::fs::remove_dir_all(&p);
    }

    /// An archive proposal made before the entry was rewritten does not
    /// archive the new text.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_archive_whose_entry_was_rewritten_since_is_obsolete() {
        let p = scratch_project("dream-archive-moved");
        let memory = SharedMemoryStore::new();
        let entry = decision(&memory, &p, "PR #412 is in review", "pr.state");
        let answer = format!(
            "{{\"ops\":[{{\"op\":\"archive\",\"id\":{},\"reason\":\"transient\",\"why\":\"done\"}}]}}",
            entry.id
        );
        let id = propose(&memory, &p, &answer).await;
        decision(&memory, &p, "Auth uses EdDSA", "pr.state");
        assert_eq!(accept(&memory, &p, id).unwrap(), "obsolete");
        let after = memory.get_entry(&p, entry.id).unwrap().unwrap();
        assert_eq!(
            (after.content.as_str(), after.state),
            ("Auth uses EdDSA", State::Active)
        );
        let _ = std::fs::remove_dir_all(&p);
    }

    /// A `contradicts` link the model names high id first is stored as
    /// (min, max), so resolving the conflict removes it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_contradicts_link_is_stored_low_id_first() {
        let p = scratch_project("dream-link-order");
        let memory = SharedMemoryStore::new();
        let low = decision(&memory, &p, "Deploy to Fly", "deploy.host").id;
        let high = decision(&memory, &p, "Deploy to Render", "deploy.target").id;
        let answer = format!(
            "{{\"ops\":[{{\"op\":\"link\",\"a\":{high},\"b\":{low},\"rel\":\"contradicts\",\"why\":\"two hosts\"}}]}}"
        );
        let id = propose(&memory, &p, &answer).await;
        assert_eq!(accept(&memory, &p, id).unwrap(), "accepted");
        let store = store_for(&p).unwrap();
        assert_eq!(
            store.links(record::LINK_CONTRADICTS).unwrap(),
            vec![(low, high)]
        );
        let _ = std::fs::remove_dir_all(&p);
    }

    /// A proposal another accept has claimed is not applied a second time;
    /// one whose apply failed goes back to pending.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_claimed_proposal_is_not_applied_twice() {
        let p = scratch_project("dream-claim");
        let memory = SharedMemoryStore::new();
        let entry = decision(&memory, &p, "PR #412 is in review", "pr.state");
        let answer = format!(
            "{{\"ops\":[{{\"op\":\"archive\",\"id\":{},\"reason\":\"transient\",\"why\":\"done\"}}]}}",
            entry.id
        );
        let id = propose(&memory, &p, &answer).await;
        let store = store_for(&p).unwrap();
        assert!(store.claim_proposal(id).unwrap(), "the first accept");
        assert!(accept(&memory, &p, id).is_err(), "the second accept");
        assert_eq!(
            store.peek(entry.id).unwrap().unwrap().state,
            State::Active,
            "the second accept wrote nothing"
        );
        store
            .set_proposal_status(id, record::PROPOSAL_PENDING)
            .unwrap();
        assert_eq!(accept(&memory, &p, id).unwrap(), "accepted");
        assert_eq!(
            store.peek(entry.id).unwrap().unwrap().state,
            State::Archived
        );
        let _ = std::fs::remove_dir_all(&p);
    }

    /// An op still pending from an earlier dream is not proposed again.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_repeated_proposal_is_kept_once() {
        let p = scratch_project("dream-repeat");
        let memory = SharedMemoryStore::new();
        let entry = decision(&memory, &p, "PR #412 is in review", "pr.state");
        let answer = format!(
            "{{\"ops\":[{{\"op\":\"archive\",\"id\":{},\"reason\":\"transient\",\"why\":\"done\"}}]}}",
            entry.id
        );
        propose(&memory, &p, &answer).await;
        let store = store_for(&p).unwrap();
        let later = 1_000 + DREAM_EVERY_MS;
        store
            .record_episode(&note("s-b", later - 10, "Use Postgres"))
            .unwrap();
        run(&memory, &Fake::new(&answer), &p, later)
            .await
            .expect("dreamed");
        assert_eq!(
            store
                .dream_proposals(record::PROPOSAL_PENDING)
                .unwrap()
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(&p);
    }
}
