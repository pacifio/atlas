//! What a session pulls from the record: the session-start briefing
//! (`memory_briefing`) and what other sessions recorded since it last looked
//! (`memory_changes`).
//!
//! - **The briefing** is working memory (the active plan, then files changed
//!   newest first) and the **durable index**: each durable kind's best entries
//!   up to its display cap, ranked by [`score`] — recency with a two-week
//!   half-life, use count and confidence — and admitted best first across
//!   kinds within [`INDEX_MAX_ENTRIES`] and [`INDEX_MAX_CHARS`] of content. An
//!   index line carries a capped `content`; `memory_get` has the rest.
//! - **Changes** are the entries other sessions wrote or edited after the
//!   session's last look, newest first, a page of at most
//!   [`CHANGES_MAX_PER_KIND`] of each kind (`more` asks for the next). The
//!   session's own writes are left out: it made them.
//! - **The clock** ([`SessionClocks`]) is the newest `updated_at` a session
//!   has seen, kept per session id from its briefing or last changes call and
//!   dropped when the session ends. Storage is unbounded; only what one read
//!   ranks is bounded ([`RANK_POOL`]).
//!
//! Ranking and admission are pure over entries so they are testable without
//! a store; the two `read_*` functions are the only ones that touch SQLite
//! (blocking — callers run them off the async runtime).

use std::collections::{HashMap, HashSet};

use atlas_memory::citation::{Citation, Validity};
use atlas_memory::record::{Entry, EntryKind, Origin, RecordStore, Source, State};
use parking_lot::Mutex;
use serde_json::{json, Value};

/// The index never carries more entries than this.
pub(super) const INDEX_MAX_ENTRIES: usize = 200;
/// The index's content budget, index lines summed.
pub(super) const INDEX_MAX_CHARS: usize = 8_000;
/// One index line's content cap — an index names what exists, the entry
/// itself is a `memory_get` away.
pub(super) const INDEX_ENTRY_MAX_CHARS: usize = 160;
/// The active plan's content cap in a briefing.
const PLAN_MAX_CHARS: usize = 2_000;
/// The briefing's preferences: at most this many, newest first ...
const PREFERENCES_MAX: usize = 30;
/// ... within this many characters of content, the oldest dropped first.
const PREFERENCES_MAX_CHARS: usize = 2_000;
/// One preference line's content cap.
const PREFERENCE_MAX_CHARS: usize = 300;
/// How many sources an index line carries (the newest); `memory_get` and
/// `memory_history` show them all.
pub(super) const INDEX_SOURCES: usize = 2;
/// How many entries of one kind a changes call carries.
pub(super) const CHANGES_MAX_PER_KIND: usize = 8;
/// Recency half-life for ranking: two weeks.
const HALF_LIFE_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// How many entries of one kind are read before ranking or filtering.
const RANK_POOL: usize = 5_000;
/// The durable kinds, in the order the index groups them.
pub(super) const DURABLE_KINDS: [EntryKind; 4] = [
    EntryKind::Decision,
    EntryKind::Fact,
    EntryKind::Failure,
    EntryKind::Architecture,
];

// ── Clocks ───────────────────────────────────────────────────────────────────

/// Each session's "last looked" clock: the newest `updated_at` it has seen
/// through `memory_briefing` or `memory_changes`. Keyed by session id.
///
/// Deliberately still only the clock (ADR-0010 defines it as exactly that).
/// Whether a session read memory *at all* is a different question with a
/// different answer, and lives in [`SessionReads`].
#[derive(Default)]
pub struct SessionClocks(Mutex<HashMap<String, i64>>);

impl SessionClocks {
    /// When `session_id` last looked; `None` before its first briefing or
    /// changes call.
    pub fn last_look(&self, session_id: &str) -> Option<i64> {
        self.0.lock().get(session_id).copied()
    }

    /// Record that `session_id` has now seen everything up to `at`. Monotonic.
    pub fn looked(&self, session_id: &str, at: i64) {
        let mut clocks = self.0.lock();
        let clock = clocks.entry(session_id.to_string()).or_insert(at);
        if at > *clock {
            *clock = at;
        }
    }

    /// Drop `session_id`'s clock (its session ended).
    pub fn forget(&self, session_id: &str) {
        self.0.lock().remove(session_id);
    }
}

/// Which sessions have read shared memory.
///
/// Separate from [`SessionClocks`] because it answers a different question.
/// The clock moves only on a briefing or a changes call, so a session that
/// answered perfectly well from `memory_search` has no clock at all — and
/// reading "never looked" off the clock would accuse an agent of ignoring
/// memory it had just used. Every read counts here, and writes do not:
/// recording a fact is not looking at what was already there.
#[derive(Default)]
pub struct SessionReads {
    read: Mutex<HashSet<String>>,
}

impl SessionReads {
    /// Record that `session_id` read memory, by whichever tool.
    pub fn read(&self, session_id: &str) {
        self.read.lock().insert(session_id.to_string());
    }

    /// Whether `session_id` has read memory at all. Asserted by the tests
    /// that pin "writing is not reading"; nothing in the app asks any more.
    #[cfg(test)]
    pub fn has_read(&self, session_id: &str) -> bool {
        self.read.lock().contains(session_id)
    }

    /// Drop what is remembered about `session_id` (its session ended).
    #[cfg(test)]
    pub fn forget(&self, session_id: &str) {
        self.read.lock().remove(session_id);
    }
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/// An entry's index rank: recency (two-week half-life, from its last use or
/// write, whichever is later) + ln(1 + use count) + confidence.
pub(super) fn score(e: &Entry, now: i64) -> f64 {
    let last = e.last_used_at.unwrap_or(0).max(e.updated_at);
    let age = now.saturating_sub(last).max(0) as f64;
    0.5f64.powf(age / HALF_LIFE_MS) + (1.0 + f64::from(e.uses)).ln() + e.confidence
}

/// The index over `entries` (any mix of kinds; working memory is ignored):
/// each durable kind's best entries up to its display cap, then, best first
/// across kinds, as many as fit [`INDEX_MAX_ENTRIES`] and
/// [`INDEX_MAX_CHARS`]. Returned grouped by kind in [`DURABLE_KINDS`] order,
/// best first within a kind.
pub(super) fn rank_index(entries: &[Entry], now: i64) -> Vec<Entry> {
    let mut pool: Vec<(f64, &Entry)> = Vec::new();
    for kind in DURABLE_KINDS {
        let mut of_kind: Vec<(f64, &Entry)> = entries
            .iter()
            .filter(|e| e.kind == kind)
            // Only active entries are briefed: a candidate is unconfirmed, an
            // archived entry is out of briefings by definition.
            .filter(|e| e.state == State::Active)
            .map(|e| (score(e, now), e))
            .collect();
        of_kind.sort_by(|a, b| b.0.total_cmp(&a.0));
        of_kind.truncate(kind.cap());
        pool.extend(of_kind);
    }
    pool.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut chars = 0usize;
    let mut admitted: Vec<Vec<&Entry>> = vec![Vec::new(); DURABLE_KINDS.len()];
    let mut count = 0usize;
    for (_, e) in pool {
        let Some(slot) = DURABLE_KINDS.iter().position(|k| *k == e.kind) else {
            continue;
        };
        let cost = one_line(&e.content, INDEX_ENTRY_MAX_CHARS).chars().count();
        if count + 1 > INDEX_MAX_ENTRIES || chars + cost > INDEX_MAX_CHARS {
            continue;
        }
        count += 1;
        chars += cost;
        admitted[slot].push(e);
    }
    admitted.into_iter().flatten().cloned().collect()
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// What a session-start briefing carries from the record.
#[derive(Debug, Default)]
pub(super) struct Briefing {
    pub plan: Option<Entry>,
    /// How the user wants things done: briefed first, newest first, never
    /// ranked by recency (a preference does not age).
    pub preferences: Vec<Entry>,
    /// Newest first.
    pub files_changed: Vec<Entry>,
    /// Grouped by kind, best first within a kind.
    pub index: Vec<Entry>,
    /// The newest `updated_at` read: what the session has now seen.
    pub synced_to: i64,
    /// Active durable entries left out because their evidence is stale.
    pub stale_hidden: usize,
    /// What the evidence of the durable entries said (M3).
    pub checked: Checked,
}

/// Entries' evidence, checked now (M3, ADR-0018): code citations, and for an
/// uncited decision, fact or architecture note the commits that carried its
/// writing turn's work. Citations, when present, decide alone.
#[derive(Debug, Default)]
pub(super) struct Checked {
    pub cites: HashMap<i64, (Validity, Vec<Citation>)>,
    pub work: HashMap<i64, crate::commands::memory_capture::WorkCheck>,
    /// The memories each one is linked as contradicting (M4).
    pub conflicts: HashMap<i64, Vec<i64>>,
}

impl Checked {
    pub fn validity(&self, id: i64) -> Option<Validity> {
        match self.cites.get(&id) {
            Some((v, _)) => Some(*v),
            None => self.work.get(&id).and_then(|w| w.validity),
        }
    }

    pub fn is_stale(&self, id: i64) -> bool {
        self.validity(id) == Some(Validity::Stale)
    }
}

/// The briefing, from the record. `check` judges the durable pool's evidence;
/// an active entry it finds stale is left out of the index and counted.
/// Blocking (SQLite, and the files `check` reads).
pub(super) fn read_briefing(
    store: &RecordStore,
    now: i64,
    check: &dyn Fn(&[Entry]) -> Checked,
) -> anyhow::Result<Briefing> {
    let plan = store
        .list(EntryKind::Plan, 1, Origin::Any)?
        .pop()
        .filter(is_active_plan);
    // Only this scope's files, newest first: rows recorded before capture
    // kept to the scope can name another checkout, `/tmp` or `~/.claude`.
    let dirs = store.scope_dirs();
    let mut files_changed = store.list(EntryKind::FileChanged, RANK_POOL, Origin::Any)?;
    files_changed.reverse();
    files_changed.retain(|e| atlas_memory::record::path_in_dirs(&e.key, &dirs));
    files_changed.truncate(EntryKind::FileChanged.cap());
    let mut durable = Vec::new();
    for kind in DURABLE_KINDS {
        durable.extend(store.list(kind, RANK_POOL, Origin::Any)?);
    }
    let preferences =
        brief_preferences(store.list(EntryKind::Preference, RANK_POOL, Origin::Any)?);
    let synced_to = plan
        .iter()
        .chain(&files_changed)
        .chain(&durable)
        .chain(&preferences)
        .map(|e| e.updated_at)
        .max()
        .unwrap_or(0);
    let active: Vec<Entry> = durable
        .into_iter()
        .filter(|e| e.state == State::Active)
        .collect();
    let checked = check(&active);
    let (stale, fresh): (Vec<Entry>, Vec<Entry>) =
        active.into_iter().partition(|e| checked.is_stale(e.id));
    Ok(Briefing {
        plan,
        preferences,
        files_changed,
        index: rank_index(&fresh, now),
        synced_to,
        stale_hidden: stale.len(),
        checked,
    })
}

/// Whether a stored plan is still the active one: its status says so, and
/// not every item of it is done. Capture keeps only the newest plan, so a
/// later session's plan has already replaced an older one; what is left to
/// catch is a plan that ran to completion and was never cleared (capture
/// used to log every plan as `active`, finished or not).
pub(super) fn is_active_plan(plan: &Entry) -> bool {
    (plan.status.is_empty() || plan.status == "active")
        && !atlas_memory::handoff::plan_is_finished(&plan.content)
}

/// The handoff a briefing for session `own` carries: what the previous
/// session of any agent left, with its recorded facts read now (its commits
/// may have landed after it ended) and only this scope's files.
///
/// Memory's own note ([`RecordStore::last_episode`]) covers the sessions
/// Atlas hosted. The capture recorder also holds the terminal sessions its
/// importer read off disk, which memory never saw start or end; when one of
/// those did work after memory's newest note, it is the previous session,
/// and its note is built from the recorder (and whatever memory logged for
/// it). Blocking (SQLite, git).
pub(super) fn read_handoff(
    store: &RecordStore,
    own: &str,
    stores: &crate::commands::memory_capture::ScopeStores,
) -> Option<atlas_memory::handoff::HandoffNote> {
    /// How many newer recorded sessions are tried, newest first.
    const TRIED: usize = 5;
    let mut note = store.last_episode(own).ok().flatten();
    let since = note
        .as_ref()
        .map_or(i64::MIN, |n| n.ended_at.saturating_add(1));
    let known = note.as_ref().map(|n| n.session.clone()).unwrap_or_default();
    let newer = stores
        .recent_sessions(since, i64::MAX)
        .into_iter()
        .filter(|w| w.session_id != own && w.session_id != known)
        .take(TRIED);
    for writer in newer {
        let Some(found) = stores.find(&writer.session_id) else {
            continue;
        };
        let session = &found.session;
        let ended_at = session
            .last_activity_at
            .unwrap_or(session.updated_at)
            .timestamp_millis();
        let Ok(mut built) = atlas_memory::handoff::build_handoff(
            store,
            &writer.session_id,
            &writer.agent,
            ended_at,
        ) else {
            continue;
        };
        built.started_at = built
            .started_at
            .or(Some(session.started_at.timestamp_millis()));
        let facts = crate::commands::memory_capture::session_facts(&found);
        let worth = !built.is_empty() || !facts.is_empty();
        built.apply_facts(facts);
        if worth {
            note = Some(built);
            break;
        }
    }
    let mut note = note?;
    if note.session != own {
        if let Some(found) = stores.find(&note.session) {
            note.apply_facts(crate::commands::memory_capture::session_facts(&found));
        }
    }
    let dirs = store.scope_dirs();
    note.files.retain(|f| {
        atlas_memory::record::path_in_dirs(f.strip_suffix(" (deleted)").unwrap_or(f), &dirs)
    });
    Some(note)
}

/// The preferences a briefing leads with, from the stored ones (oldest
/// first): the active ones, newest first, at most [`PREFERENCES_MAX`] and
/// [`PREFERENCES_MAX_CHARS`] of content, the oldest dropped first.
pub(super) fn brief_preferences(stored: Vec<Entry>) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut chars = 0usize;
    for e in stored
        .into_iter()
        .rev()
        .filter(|e| e.state == State::Active)
    {
        let cost = one_line(&e.content, PREFERENCE_MAX_CHARS).chars().count();
        if out.len() == PREFERENCES_MAX || chars + cost > PREFERENCES_MAX_CHARS {
            break;
        }
        chars += cost;
        out.push(e);
    }
    out
}

/// What other sessions recorded since a session last looked.
#[derive(Debug, Default)]
pub(super) struct Changes {
    pub since: i64,
    pub synced_to: i64,
    /// Newest first. At most [`CHANGES_MAX_PER_KIND`] of each kind per call;
    /// `more` says there is another page.
    pub entries: Vec<Entry>,
    pub more: bool,
    /// Ids other sessions forgot within this page's clock, oldest first.
    pub forgotten: Vec<i64>,
}

/// Entries written or edited after `since` by sessions other than
/// `own_session`, one page of them. Blocking (SQLite).
pub(super) fn read_changes(
    store: &RecordStore,
    since: i64,
    own_session: &str,
) -> anyhow::Result<Changes> {
    let mut groups = Vec::new();
    for kind in EntryKind::ALL {
        // One more than a page: enough to know whether this kind overflows.
        groups.push(store.changed_since(kind, since, own_session, CHANGES_MAX_PER_KIND + 1)?);
    }
    let pool_max = store.max_updated_at()?;
    let (entries, synced_to, more) = page_changes(groups, CHANGES_MAX_PER_KIND, pool_max, since);
    // Forgets after the last look, by other sessions. Within this page's
    // clock only: a forget newer than a page's cutoff arrives with that page.
    let forgotten: Vec<(i64, i64)> = store.forgotten_since(since, own_session)?;
    let synced_to = if more {
        synced_to
    } else {
        forgotten
            .iter()
            .map(|(_, at)| *at)
            .fold(synced_to, i64::max)
    };
    let forgotten = forgotten
        .into_iter()
        .filter(|(_, at)| *at <= synced_to)
        .map(|(id, _)| id)
        .collect();
    Ok(Changes {
        since,
        synced_to,
        entries,
        more,
        forgotten,
    })
}

/// One page from per-kind groups of pending entries (each oldest first).
///
/// Without overflow every pending entry is returned and the clock moves to
/// `pool_max` (past the reader's own writes too). With overflow, the clock
/// stops just before the oldest entry a full kind left out: every entry older
/// than that is returned, everything at or after it waits for the next call.
/// Nothing is skipped and nothing is returned twice. If that would return
/// nothing (more than a page shares one instant), the whole instant is
/// returned and the clock moves to it.
pub(super) fn page_changes(
    groups: Vec<Vec<Entry>>,
    per_kind: usize,
    pool_max: i64,
    since: i64,
) -> (Vec<Entry>, i64, bool) {
    let cutoff = groups
        .iter()
        .filter(|g| g.len() > per_kind)
        .map(|g| g[per_kind].updated_at)
        .min();
    let mut pending: Vec<Entry> = groups.into_iter().flatten().collect();
    let (mut out, synced, more) = match cutoff {
        None => (pending, pool_max.max(since), false),
        Some(cut) => {
            let before: Vec<Entry> = pending
                .iter()
                .filter(|e| e.updated_at < cut)
                .cloned()
                .collect();
            if before.is_empty() {
                let first = pending.iter().map(|e| e.updated_at).min().unwrap_or(since);
                pending.retain(|e| e.updated_at == first);
                (pending, first, true)
            } else {
                (before, cut - 1, true)
            }
        }
    };
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
    (out, synced, more)
}

// ── Wire shapes ──────────────────────────────────────────────────────────────

/// Who a memory is from: the agent that wrote it, else its source
/// (`import:memdir`, `user`, `extractor`, …).
pub(super) fn provenance(e: &Entry) -> &str {
    if e.agent.trim().is_empty() {
        &e.source
    } else {
        &e.agent
    }
}

/// One entry as every tool returns it.
pub(super) fn entry_json(e: &Entry) -> Value {
    let mut value = json!({
        "id": e.id,
        "kind": e.kind.as_str(),
        "key": e.key,
        "content": e.content,
        "by": provenance(e),
        "source": e.source,
        "confidence": e.confidence,
        "updatedAt": e.updated_at,
        "uses": e.uses,
        "revision": e.rev,
        "state": e.state.as_str(),
        "added": added(e.created_at),
    });
    if e.kind == EntryKind::Plan && !e.status.is_empty() {
        value["status"] = json!(e.status);
    }
    if e.is_candidate() {
        value["candidate"] = json!(true);
    }
    value
}

/// Attach the memories it contradicts (`conflicts`), and what an entry's
/// evidence says now: `validity` and the citations
/// as found now when it cites code; otherwise the `commits` that carried its
/// writing turn's work and, when they decided it, `validity` with
/// `validityFrom: "commits"`.
pub(super) fn with_evidence(value: &mut Value, id: i64, checked: &Checked) {
    if let Some(others) = checked.conflicts.get(&id) {
        value["conflicts"] = json!(others);
    }
    if let Some((validity, cites)) = checked.cites.get(&id) {
        value["validity"] = json!(validity.as_str());
        value["citations"] = json!(cites
            .iter()
            .map(|c| {
                let mut v = json!({
                    "path": c.path,
                    "lines": format!("{}-{}", c.start_line, c.end_line),
                });
                if let Some(symbol) = &c.symbol {
                    v["symbol"] = json!(symbol);
                }
                v
            })
            .collect::<Vec<_>>());
        return;
    }
    let Some(work) = checked.work.get(&id) else {
        return;
    };
    if !work.commits.is_empty() {
        value["commits"] = json!(work.commits);
    }
    if let Some(validity) = work.validity {
        value["validity"] = json!(validity.as_str());
        value["validityFrom"] = json!("commits");
    }
}

/// The UTC date an entry was first saved, `YYYY-MM-DD`.
fn added(created_at: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(created_at).map(|d| d.format("%Y-%m-%d").to_string())
}

/// Attach provenance to an entry object: the `keep` newest of its sources
/// (0 = all), as `atlas-session:<agent>/<session>`, `atlas-user`, or the
/// writer's raw source.
pub(super) fn with_sources(value: &mut Value, sources: &[Source], keep: usize) {
    let uris: Vec<String> = sources
        .iter()
        .map(atlas_memory::record::source_uri)
        .collect();
    let start = if keep == 0 {
        0
    } else {
        uris.len().saturating_sub(keep)
    };
    value["sources"] = json!(uris[start..]);
}

/// One entry as the index lists it: `content` capped at `max_chars`, with
/// `truncated: true` when it was, so the agent knows `memory_get` has more.
fn capped_json(e: &Entry, max_chars: usize) -> Value {
    let flat = one_line(&e.content, max_chars);
    let truncated = flat.ends_with('…') && e.content.chars().count() > max_chars;
    let mut value = json!({
        "id": e.id,
        "kind": e.kind.as_str(),
        "content": flat,
        "by": provenance(e),
        "confidence": e.confidence,
        "updatedAt": e.updated_at,
        "added": added(e.created_at),
    });
    if truncated {
        value["truncated"] = json!(true);
    }
    value
}

/// The `memory_briefing` result, before the first-look extras are added.
/// Each index line and preference carries its newest sources from `sources`.
pub(super) fn briefing_json(b: &Briefing, sources: &HashMap<i64, Vec<Source>>) -> Value {
    let line = |e: &Entry, max: usize| {
        let mut v = capped_json(e, max);
        with_sources(
            &mut v,
            sources.get(&e.id).map_or(&[][..], Vec::as_slice),
            INDEX_SOURCES,
        );
        with_evidence(&mut v, e.id, &b.checked);
        v
    };
    let plan = b.plan.as_ref().map(|p| {
        let content = truncate_chars(p.content.trim(), PLAN_MAX_CHARS);
        let mut value = json!({
            "id": p.id,
            "content": content,
            "status": p.status,
            "by": provenance(p),
            "updatedAt": p.updated_at,
        });
        if p.content.trim().chars().count() > PLAN_MAX_CHARS {
            value["truncated"] = json!(true);
        }
        value
    });
    let files: Vec<Value> = b
        .files_changed
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "path": c.key,
                "summary": one_line(&c.content, INDEX_ENTRY_MAX_CHARS),
                "by": provenance(c),
                "updatedAt": c.updated_at,
            })
        })
        .collect();
    let mut index = serde_json::Map::new();
    for kind in DURABLE_KINDS {
        let of_kind: Vec<Value> = b
            .index
            .iter()
            .filter(|e| e.kind == kind)
            .map(|e| line(e, INDEX_ENTRY_MAX_CHARS))
            .collect();
        if !of_kind.is_empty() {
            index.insert(kind.as_str().to_string(), Value::Array(of_kind));
        }
    }
    let preferences: Vec<Value> = b
        .preferences
        .iter()
        .map(|e| line(e, PREFERENCE_MAX_CHARS))
        .collect();
    let mut value = json!({
        "plan": plan,
        "preferences": preferences,
        "filesChanged": files,
        "index": index,
        "syncedTo": b.synced_to,
    });
    if b.stale_hidden > 0 {
        value["staleHidden"] = json!(b.stale_hidden);
    }
    value
}

/// The `memory_changes` result, each entry with all its sources.
pub(super) fn changes_json(c: &Changes, sources: &HashMap<i64, Vec<Source>>) -> Value {
    json!({
        "since": c.since,
        "syncedTo": c.synced_to,
        "more": c.more,
        "forgotten": c.forgotten,
        "entries": c.entries.iter().map(|e| {
            let mut v = entry_json(e);
            with_sources(&mut v, sources.get(&e.id).map_or(&[][..], Vec::as_slice), 0);
            v
        }).collect::<Vec<_>>(),
    })
}

/// Whitespace collapsed to single spaces, capped at `max` chars with `…`.
fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&flat, max)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod briefing_tests {
    use super::*;
    use atlas_memory::record::{open_scope, NewEntry};

    fn remember(store: &RecordStore, i: i64, session: &str) {
        store
            .remember(
                NewEntry {
                    kind: EntryKind::Decision,
                    key: format!("k{i}"),
                    content: format!("Decision number {i}"),
                    source: "codex".into(),
                    agent: "codex".into(),
                    session_id: session.into(),
                    confidence: 1.0,
                    at: 1_000 + i,
                },
                1_000 + i,
            )
            .unwrap();
    }

    fn entry(id: i64, content: &str, confidence: f64, updated_at: i64) -> Entry {
        Entry {
            id,
            kind: EntryKind::Fact,
            key: String::new(),
            content: content.into(),
            status: String::new(),
            source: "x".into(),
            agent: "x".into(),
            session_id: "s".into(),
            confidence,
            created_at: updated_at,
            updated_at,
            last_used_at: None,
            uses: 0,
            content_hash: String::new(),
            seq: None,
            // State follows confidence, as every write through the store sets it.
            state: if confidence < atlas_memory::record::TRUSTED_CONFIDENCE {
                State::Candidate
            } else {
                State::Active
            },
            ..Default::default()
        }
    }

    /// Twelve decisions from another session between two looks: the reader
    /// gets all twelve across calls, none twice, and `more` says when to
    /// call again.
    #[test]
    fn changes_page_through_every_entry_without_skipping() {
        let root = std::env::temp_dir().join(format!("atlas-changes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = open_scope(&root).unwrap();
        for i in 0..12 {
            remember(&store, i, "s-other");
        }
        remember(&store, 99, "s-mine"); // own write: never returned
        let mut since = 0;
        let mut seen: Vec<String> = Vec::new();
        for _ in 0..5 {
            let c = read_changes(&store, since, "s-mine").unwrap();
            seen.extend(c.entries.iter().map(|e| e.content.clone()));
            assert!(c.synced_to >= since, "the clock never goes back");
            since = c.synced_to;
            if !c.more {
                break;
            }
        }
        let mut unique = seen.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 12, "{seen:?}");
        assert_eq!(seen.len(), 12, "nothing returned twice: {seen:?}");
        assert!(!seen.iter().any(|c| c.contains("99")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_active_entries_are_briefed() {
        let make = |id: i64, state: State| Entry {
            state,
            ..entry(id, &format!("f{id}"), 1.0, 1)
        };
        let index = rank_index(
            &[
                make(1, State::Archived),
                make(2, State::Candidate),
                make(3, State::Active),
            ],
            2,
        );
        assert_eq!(index.iter().map(|e| e.id).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn preferences_lead_newest_first_within_their_budget() {
        let pref = |id: i64, content: &str| Entry {
            kind: EntryKind::Preference,
            ..entry(id, content, 1.0, id)
        };
        let mut stored: Vec<Entry> = (1..=40).map(|i| pref(i, &format!("pref {i}"))).collect();
        stored[39].state = State::Archived;
        let got = brief_preferences(stored);
        assert_eq!(got.len(), PREFERENCES_MAX);
        assert_eq!(got[0].id, 39, "newest active first");
    }

    #[test]
    fn candidates_stay_out_of_the_briefing_index() {
        let index = rank_index(
            &[
                entry(1, "always force-push", 0.3, 1),
                entry(2, "API is REST", 1.0, 1),
            ],
            2,
        );
        assert_eq!(index.iter().map(|e| e.id).collect::<Vec<_>>(), vec![2]);
        assert_eq!(
            entry_json(&entry(1, "x", 0.3, 1))["candidate"],
            serde_json::json!(true)
        );
        assert!(entry_json(&entry(2, "y", 1.0, 1))
            .get("candidate")
            .is_none());
    }

    fn log(
        store: &RecordStore,
        kind: atlas_memory::record::EventKind,
        key: &str,
        payload: Value,
        ts: i64,
    ) {
        store
            .append_event(
                atlas_memory::record::NewEvent {
                    agent: "claude-acp".into(),
                    session_id: "s-old".into(),
                    kind,
                    key: key.into(),
                    payload,
                },
                ts,
            )
            .unwrap();
    }

    fn scope(label: &str) -> (std::path::PathBuf, std::sync::Arc<RecordStore>) {
        let root =
            std::env::temp_dir().join(format!("atlas-brief-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = open_scope(&root).unwrap();
        (root, store)
    }

    /// A plan whose every item is done is not the active plan, even when it
    /// was stored as `active` (the live store's August plan was).
    #[test]
    fn a_finished_plan_is_not_briefed_as_active() {
        use atlas_memory::record::EventKind;
        let (root, store) = scope("plan");
        log(
            &store,
            EventKind::PlanSet,
            "plan",
            json!({"text": "- [completed] Create branch for issue #177\n- [completed] Commit, push, open PR", "status": "active"}),
            1,
        );
        let b = read_briefing(&store, 2, &|_| Checked::default()).unwrap();
        assert!(b.plan.is_none(), "{:?}", b.plan);

        log(
            &store,
            EventKind::PlanSet,
            "plan",
            json!({"text": "- [completed] Read auth\n- [in_progress] Move to EdDSA", "status": "active"}),
            3,
        );
        let b = read_briefing(&store, 4, &|_| Checked::default()).unwrap();
        assert!(b.plan.unwrap().content.contains("Move to EdDSA"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Files changed in another checkout, `/tmp` or `~/.claude` are not this
    /// project's, however they got into its store.
    #[test]
    fn the_briefing_lists_only_files_under_the_project_root() {
        use atlas_memory::record::EventKind;
        let (root, store) = scope("files");
        let inside = root
            .canonicalize()
            .unwrap()
            .join("src/main.rs")
            .to_string_lossy()
            .into_owned();
        for (i, path) in [
            inside.as_str(),
            "/Users/someone/Developer/atlas/src/App.tsx",
            "/tmp/homebrew-cask-pr/Casks/a/atlas-ai.rb",
            "/Users/someone/.claude/plans/plan.md",
        ]
        .into_iter()
        .enumerate()
        {
            log(
                &store,
                EventKind::FileChanged,
                path,
                json!({"path": path, "summary": "Edit"}),
                i as i64 + 1,
            );
        }
        let b = read_briefing(&store, 10, &|_| Checked::default()).unwrap();
        let paths: Vec<&str> = b.files_changed.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(paths, [inside.as_str()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The previous session was a terminal one Atlas never hosted: memory
    /// has no note of it, the recorder has its work. The briefing hands
    /// that on; a note memory stored later wins.
    #[test]
    fn a_terminal_session_the_recorder_saw_is_handed_off() {
        use crate::commands::memory_capture::test_support::Recording;
        use crate::commands::memory_capture::CaptureReader;
        let (root, store) = scope("handoff-recorded");
        let project = root.to_string_lossy().into_owned();
        assert!(read_handoff(&store, "own", &CaptureReader::default().stores(&project)).is_none());

        let mut rec = Recording::open_turn(&project, "cli-1", "claude-code", "move auth to EdDSA");
        rec.write("src/auth.rs", b"pub fn sign() {}\n");
        rec.close_turn();
        drop(rec);
        let stores = CaptureReader::default().stores(&project);
        let note = read_handoff(&store, "own", &stores).expect("a handoff");
        assert_eq!(note.session, "cli-1");
        assert_eq!(note.agent, "claude-code");
        assert_eq!(note.files, ["src/auth.rs"]);
        assert_eq!(note.title.as_deref(), Some("move auth to EdDSA"));
        // A session is not handed its own work.
        assert!(read_handoff(&store, "cli-1", &stores).is_none());

        // A note memory stored after it is the previous session.
        store
            .record_episode(&atlas_memory::handoff::HandoffNote {
                session: "s-later".into(),
                agent: "codex-acp".into(),
                ended_at: chrono::Utc::now().timestamp_millis() + 60_000,
                decisions: vec!["Keep WAL mode".into()],
                ..Default::default()
            })
            .unwrap();
        let note = read_handoff(&store, "own", &stores).unwrap();
        assert_eq!(note.session, "s-later");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// More than a page's worth sharing one timestamp is returned whole,
    /// rather than looping forever on an unmovable clock.
    #[test]
    fn a_burst_at_one_instant_is_not_a_livelock() {
        let group: Vec<Entry> = (1..=10)
            .map(|id| entry(id, &format!("f{id}"), 1.0, 5))
            .collect();
        let (out, synced, _) = page_changes(vec![group], 8, 5, 0);
        assert_eq!(out.len(), 10);
        assert_eq!(synced, 5);
    }
}
