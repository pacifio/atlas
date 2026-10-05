//! The extractor's app side: which model a pass asks, and where its entries
//! land.
//!
//! `atlas_memory::extract` owns the gates, the prompt and the parser. This
//! module decides, per pass:
//!
//! - **whether it runs** — only while sharing is on for the project;
//! - **which model** ([`route_for`], from the summariser preference file):
//!   `provider` → the user's BYOK provider and model; `local` → nothing yet (the
//!   slot stays reserved); anything else — `gateway`, the default `raw`, a file
//!   that does not exist — → the Atlas gateway, when the user is signed in. Not
//!   signed in and no BYOK provider chosen means no pass, silently;
//! - **where the entries go** — [`SharedMemoryStore::record_extracted`]: source
//!   `extractor`, the model's confidence, redaction and dedup in the record,
//!   an event in the log (the Shared tab shows it) and a memory-changed
//!   announcement. The retrieval index is nudged afterwards by the caller.
//!
//! The model is behind [`ExtractionModel`] so tests drive every path with a
//! fake; [`AppExtractionModel`] is the real one (the gateway over the account
//! token, or the BYOK one-shot completion the handoff summariser uses).
//!
//! It runs at turn finished (gated) and once at session end. The session's
//! turns are gone from the host by the time its end is reported, so each
//! turn-finished pass keeps the latest turns it saw for the end pass to use.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use atlas_memory::extract::{self, Trigger};
use atlas_memory::TranscriptTurn;
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use super::memory_sharing::{MemorySharingState, SummarizerPref};
use super::shared_memory::{SharedMemoryStore, Writer};

/// Ceiling on one extraction call — generous (a pass sends up to 6000 chars
/// and asks for structured output), but a hung call must not park the
/// background queue.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(60);

/// Which model one pass asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The Atlas gateway, over the signed-in account.
    Gateway,
    /// The user's own provider key (the summariser preference's `provider`).
    Byok { provider: String, model: String },
}

/// The model a pass asks, from the project's summariser preference and whether
/// the user is signed in. `None` = no pass.
pub fn route_for(pref: &SummarizerPref, signed_in: bool) -> Option<Route> {
    match pref.mode.as_str() {
        "provider" => (!pref.provider.is_empty() && !pref.model.is_empty()).then(|| Route::Byok {
            provider: pref.provider.clone(),
            model: pref.model.clone(),
        }),
        // Reserved: an on-device model is a future mode, and choosing it must
        // not send the transcript anywhere in the meantime.
        "local" => None,
        _ => signed_in.then_some(Route::Gateway),
    }
}

/// A model call in flight.
pub type Completion<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// The model the extractor asks. Injected so tests are deterministic.
pub trait ExtractionModel: Send + Sync {
    /// Whether an Atlas account is signed in (the gateway is usable).
    fn signed_in(&self) -> bool;
    /// One completion of `prompt` on `route`.
    fn complete(&self, route: Route, prompt: String) -> Completion<'_>;
}

/// Runs extraction passes and lands their entries in shared memory.
pub struct Extractor {
    memory: SharedMemoryStore,
    model: Arc<dyn ExtractionModel>,
    /// Each live session's latest turns, for its end-of-session pass.
    turns: Mutex<HashMap<String, Vec<TranscriptTurn>>>,
}

impl Extractor {
    pub fn new(memory: SharedMemoryStore, model: Arc<dyn ExtractionModel>) -> Self {
        Self {
            memory,
            model,
            turns: Mutex::new(HashMap::new()),
        }
    }

    /// A turn of `writer`'s session in `cwd` finished with `turns` as its
    /// conversation so far: extract when the gates are met. Returns how many
    /// entries were recorded.
    pub async fn turn_finished(
        &self,
        sharing: &MemorySharingState,
        cwd: &str,
        writer: &Writer,
        turns: Vec<TranscriptTurn>,
    ) -> usize {
        // Only a session that could have a pass keeps its turns for the end
        // one: nothing is held for a project with sharing off or no model.
        let Some(route) = self.route(sharing, cwd) else {
            self.turns.lock().remove(&writer.session_id);
            return 0;
        };
        self.turns
            .lock()
            .insert(writer.session_id.clone(), turns.clone());
        self.run(route, cwd, writer, &turns, Trigger::TurnFinished)
            .await
    }

    /// `writer`'s session in `cwd` ended: one last pass over whatever arrived
    /// since the previous one. At most once per session. Returns how many
    /// entries were recorded.
    pub async fn session_ended(
        &self,
        sharing: &MemorySharingState,
        cwd: &str,
        writer: &Writer,
    ) -> usize {
        let Some(turns) = self.turns.lock().remove(&writer.session_id) else {
            return 0;
        };
        let Some(route) = self.route(sharing, cwd) else {
            return 0;
        };
        self.run(route, cwd, writer, &turns, Trigger::SessionEnd)
            .await
    }

    /// The model a pass in `cwd` would ask, or `None` when no pass runs there
    /// (sharing off, the reserved local mode, no account and no BYOK choice).
    fn route(&self, sharing: &MemorySharingState, cwd: &str) -> Option<Route> {
        if !sharing.is_enabled(cwd) {
            return None;
        }
        route_for(&sharing.summarizer_pref(cwd), self.model.signed_in())
    }

    async fn run(
        &self,
        route: Route,
        cwd: &str,
        writer: &Writer,
        turns: &[TranscriptTurn],
        trigger: Trigger,
    ) -> usize {
        // The gate counters, from the scope's memory directory (git lookup
        // and file reads: off the async runtime).
        let loaded = {
            let (cwd, session) = (cwd.to_string(), writer.session_id.clone());
            tokio::task::spawn_blocking(move || {
                let store = super::shared_memory::store_for(&cwd)?;
                let dir = atlas_memory::record::memory_dir(store.root());
                let state = atlas_memory::ExtractState::load(&dir, &session);
                Ok::<_, String>((dir, state))
            })
            .await
        };
        let (memory_dir, mut state) = match loaded.map_err(|e| e.to_string()).and_then(|r| r) {
            Ok(loaded) => loaded,
            Err(e) => {
                tracing::debug!(target: "atlas::shared_memory", "extraction skipped: {e}");
                return 0;
            }
        };
        let passes_before = state.extraction_count;

        let model = self.model.clone();
        let found = extract::extract(turns, &mut state, trigger, |prompt| async move {
            match tokio::time::timeout(EXTRACT_TIMEOUT, model.complete(route, prompt)).await {
                Ok(result) => result.map_err(|e| anyhow::anyhow!(e)),
                Err(_) => Err(anyhow::anyhow!(
                    "timed out after {}s",
                    EXTRACT_TIMEOUT.as_secs()
                )),
            }
        })
        .await;
        let found = match found {
            Ok(found) => found,
            Err(e) => {
                tracing::debug!(target: "atlas::shared_memory", "extraction pass failed: {e:#}");
                return 0;
            }
        };
        if state.extraction_count == passes_before {
            return 0; // no pass ran (the gates are not met yet): nothing to save
        }

        // Persist the counters and land the entries (SQLite writes: off the
        // async runtime).
        let (memory, cwd, writer) = (self.memory.clone(), cwd.to_string(), writer.clone());
        tokio::task::spawn_blocking(move || {
            if let Err(e) = state.save(&memory_dir, &writer.session_id) {
                tracing::debug!(target: "atlas::shared_memory", "extraction state not saved: {e:#}");
            }
            let mut recorded = 0;
            for entry in found {
                match memory.record_extracted(&cwd, &writer, entry.kind, &entry.content, entry.confidence) {
                    Ok(_) => recorded += 1,
                    Err(e) => tracing::debug!(target: "atlas::shared_memory", "extracted entry not recorded: {e}"),
                }
            }
            recorded
        })
        .await
        .unwrap_or(0)
    }
}

/// A session's conversation as the extractor reads it: one neutral turn per
/// message (the `AgentHost` snapshot already normalises every agent), with
/// Atlas's own injected blocks stripped so memory is never re-extracted from
/// memory.
pub fn transcript_turns(messages: &[atlas_agent_wire::Message]) -> Vec<TranscriptTurn> {
    use atlas_agent_wire::MessageRole;
    messages
        .iter()
        .map(|m| TranscriptTurn {
            role: match m.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::System => "system",
            }
            .to_string(),
            text: atlas_agent_transcript::strip_injected_context(&m.content),
            tool_calls: m.tool_calls.len(),
        })
        .collect()
}

// ── The real model ───────────────────────────────────────────────────────────

/// The app's models: the Atlas gateway over the signed-in account, or the
/// user's BYOK provider.
pub struct AppExtractionModel {
    app: AppHandle,
}

impl AppExtractionModel {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ExtractionModel for AppExtractionModel {
    fn signed_in(&self) -> bool {
        self.app
            .try_state::<super::auth::AuthState>()
            .is_some_and(|auth| {
                matches!(
                    auth.core().snapshot(),
                    crate::auth::AuthSnapshot::SignedIn { .. }
                )
            })
    }

    fn complete(&self, route: Route, prompt: String) -> Completion<'_> {
        Box::pin(async move {
            match route {
                Route::Byok { provider, model } => {
                    super::memory_summarize::run_completion(&self.app, prompt, &provider, &model)
                        .await
                }
                Route::Gateway => gateway_completion(&self.app, prompt).await,
            }
        })
    }
}

/// One non-streamed chat completion on the gateway, on the model the gateway
/// lists first for this account (the native agent's default).
pub(crate) async fn gateway_completion(app: &AppHandle, prompt: String) -> Result<String, String> {
    use atlas_native_agent::engine::catalog_cache::{project, resolve};
    use atlas_native_agent::engine::config::GATEWAY_BASE_URL;
    use atlas_native_agent::engine::{EngineHome, GatewayCatalogueFetcher, SystemClock};

    let core = app
        .try_state::<super::auth::AuthState>()
        .ok_or("auth is not ready")?
        .core();
    let org = match core.snapshot() {
        crate::auth::AuthSnapshot::SignedIn { active_org_id, .. } => active_org_id,
        _ => return Err("not signed in".into()),
    };
    let token = core
        .mint_access_token()
        .await
        .map_err(|e| format!("no account token: {e:?}"))?;

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let home = EngineHome::under_config_dir(&config_dir);
    let fetcher = GatewayCatalogueFetcher::registered(GATEWAY_BASE_URL);
    let catalogue = resolve(home.path(), &fetcher, &SystemClock, false)
        .await
        .map_err(|e| e.to_string())?;
    let model = project(catalogue.cache())
        .ok_or("the gateway lists no model this account may use")?
        .default_model;

    let url = format!(
        "{}/chat/completions",
        GATEWAY_BASE_URL.trim_end_matches('/')
    );
    let mut request = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&token)
        .timeout(EXTRACT_TIMEOUT)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false,
        }));
    // Bill the org the user is working in, as every gateway request does.
    if let Some(org) = org {
        request = request.header("atlas-org", org);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("the gateway answered {status}"));
    }
    completion_text(&body).ok_or_else(|| "the gateway's answer had no message".into())
}

/// The assistant text of a chat-completions response body.
fn completion_text(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(str::to_string)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared_memory::MemoryChanged;
    use atlas_memory::record::EntryKind;

    const CANNED: &str = r#"{"entries":[
        {"kind":"decision","content":"Sign JWTs with RS256","confidence":0.9},
        {"kind":"fact","content":"The API speaks JSON over REST","confidence":0.85},
        {"kind":"failure","content":"HS256 needs a shared secret; avoid it","confidence":0.7},
        {"kind":"architecture","content":"Server components render the todo list","confidence":0.6}
    ]}"#;

    /// A fake gateway / provider: answers every call with [`CANNED`] and
    /// records which route each call took.
    struct FakeModel {
        signed_in: bool,
        calls: Mutex<Vec<Route>>,
    }

    impl FakeModel {
        fn new(signed_in: bool) -> Arc<Self> {
            Arc::new(Self {
                signed_in,
                calls: Mutex::new(Vec::new()),
            })
        }
        fn calls(&self) -> Vec<Route> {
            self.calls.lock().clone()
        }
    }

    impl ExtractionModel for FakeModel {
        fn signed_in(&self) -> bool {
            self.signed_in
        }
        fn complete(&self, route: Route, _prompt: String) -> Completion<'_> {
            self.calls.lock().push(route);
            Box::pin(async { Ok(CANNED.to_string()) })
        }
    }

    struct Harness {
        memory: SharedMemoryStore,
        sharing: MemorySharingState,
        model: Arc<FakeModel>,
        extractor: Extractor,
        project: String,
        heard: Arc<Mutex<Vec<MemoryChanged>>>,
    }

    fn harness(label: &str, signed_in: bool) -> Harness {
        let dir =
            std::env::temp_dir().join(format!("atlas-extract-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let memory = SharedMemoryStore::new();
        let heard = Arc::new(Mutex::new(Vec::new()));
        memory.on_change({
            let heard = heard.clone();
            Arc::new(move |c: &MemoryChanged| heard.lock().push(c.clone()))
        });
        let model = FakeModel::new(signed_in);
        Harness {
            extractor: Extractor::new(memory.clone(), model.clone()),
            memory,
            sharing: MemorySharingState::new(),
            model,
            project: dir.to_string_lossy().into_owned(),
            heard,
        }
    }

    fn writer() -> Writer {
        Writer {
            agent: "claude-code".into(),
            session_id: "sess-1".into(),
        }
    }

    /// A session of `n` turns, alternating user and assistant.
    fn session(n: usize) -> Vec<TranscriptTurn> {
        (0..n)
            .map(|i| TranscriptTurn {
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                text: format!("turn {i}"),
                tool_calls: 0,
            })
            .collect()
    }

    fn set_pref(project: &str, mode: &str, provider: &str, model: &str) {
        crate::commands::memory_sharing::memory_summarizer_set(
            project.to_string(),
            SummarizerPref {
                mode: mode.into(),
                provider: provider.into(),
                model: model.into(),
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_long_session_without_byok_yields_entries_through_the_gateway() {
        let h = harness("gateway", true);
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;

        assert_eq!(recorded, 4);
        assert_eq!(h.model.calls(), vec![Route::Gateway]);
        // The Shared tab's state shows them.
        let state = h.memory.get_state(&h.project);
        assert_eq!(state.decisions.len(), 1);
        assert_eq!(state.decisions[0].text, "Sign JWTs with RS256");
        assert_eq!(state.facts[0].text, "The API speaks JSON over REST");
        assert_eq!(state.failures.len(), 1);
        assert_eq!(state.architecture.len(), 1);
        // And each write was announced.
        let kinds: Vec<Vec<String>> = h.heard.lock().iter().map(|c| c.kinds.clone()).collect();
        assert_eq!(
            kinds,
            [
                vec!["decision"],
                vec!["fact"],
                vec!["failure"],
                vec!["architecture"]
            ]
        );
    }

    #[tokio::test]
    async fn extracted_entries_carry_the_models_confidence_and_extractor_provenance() {
        let h = harness("provenance", true);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;

        let entries = h.memory.list_entries(&h.project, None);
        let by_kind = |k: EntryKind| entries.iter().find(|e| e.kind == k).unwrap();
        assert!(entries.iter().all(|e| e.source == "extractor"
            && e.agent == "claude-code"
            && e.session_id == "sess-1"));
        assert_eq!(by_kind(EntryKind::Decision).confidence, 0.9);
        assert_eq!(by_kind(EntryKind::Fact).confidence, 0.85);
        assert_eq!(by_kind(EntryKind::Failure).confidence, 0.7);
        assert_eq!(by_kind(EntryKind::Architecture).confidence, 0.6);
        // The event log (the Shared tab's events table) shows them too.
        assert_eq!(h.memory.list_events(&h.project).len(), 4);
    }

    #[tokio::test]
    async fn the_summariser_set_to_provider_uses_the_byok_path() {
        let h = harness("byok", true);
        set_pref(&h.project, "provider", "anthropic", "claude-haiku");
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;

        assert_eq!(
            h.model.calls(),
            vec![Route::Byok {
                provider: "anthropic".into(),
                model: "claude-haiku".into()
            }]
        );
        assert_eq!(h.memory.get_state(&h.project).decisions.len(), 1);
    }

    #[tokio::test]
    async fn extraction_waits_for_the_gates_then_runs_once_at_session_end() {
        let h = harness("gates", true);
        for n in [2, 6, 10, 14] {
            h.extractor
                .turn_finished(&h.sharing, &h.project, &writer(), session(n))
                .await;
        }
        assert!(h.model.calls().is_empty(), "no pass before twenty turns");
        assert!(h.memory.get_state(&h.project).decisions.is_empty());

        assert_eq!(
            h.extractor
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            4
        );
        assert_eq!(h.model.calls().len(), 1, "one pass at session end");
        assert_eq!(h.memory.get_state(&h.project).decisions.len(), 1);

        assert_eq!(
            h.extractor
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            0
        );
        assert_eq!(h.model.calls().len(), 1, "a session ends once");
    }

    #[tokio::test]
    async fn after_a_gated_pass_the_end_pass_only_runs_on_new_turns() {
        let h = harness("end-after", true);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        assert_eq!(h.model.calls().len(), 1);
        // Nothing new since that pass: the end has nothing to ask about.
        h.extractor
            .session_ended(&h.sharing, &h.project, &writer())
            .await;
        assert_eq!(h.model.calls().len(), 1);
    }

    #[tokio::test]
    async fn not_signed_in_without_byok_extraction_does_not_run() {
        let h = harness("signed-out", false);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        h.extractor
            .session_ended(&h.sharing, &h.project, &writer())
            .await;
        assert!(h.model.calls().is_empty());
        assert!(h.heard.lock().is_empty());
    }

    #[tokio::test]
    async fn sharing_off_or_the_reserved_local_mode_runs_nothing() {
        let h = harness("local", true);
        set_pref(&h.project, "local", "", "");
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        assert!(h.model.calls().is_empty());

        let h = harness("off", true);
        let atlas = std::path::Path::new(&h.project).join(".atlas");
        std::fs::create_dir_all(&atlas).unwrap();
        std::fs::write(atlas.join("memory-sharing.json"), r#"{"enabled":false}"#).unwrap();
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        assert!(h.model.calls().is_empty());
    }

    #[test]
    fn routes_follow_the_summariser_preference() {
        let pref = |mode: &str, provider: &str, model: &str| SummarizerPref {
            mode: mode.into(),
            provider: provider.into(),
            model: model.into(),
        };
        assert_eq!(
            route_for(&SummarizerPref::default(), true),
            Some(Route::Gateway)
        );
        assert_eq!(
            route_for(&pref("gateway", "", ""), true),
            Some(Route::Gateway)
        );
        assert_eq!(route_for(&SummarizerPref::default(), false), None);
        assert_eq!(
            route_for(&pref("provider", "openai", "gpt"), false),
            Some(Route::Byok {
                provider: "openai".into(),
                model: "gpt".into()
            })
        );
        assert_eq!(
            route_for(&pref("provider", "", ""), true),
            None,
            "provider chosen but not configured"
        );
        assert_eq!(route_for(&pref("local", "", ""), true), None);
    }

    #[test]
    fn the_gateway_answer_is_read_from_the_first_choice() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"entries\":[]}"}}]}"#;
        assert_eq!(completion_text(body).as_deref(), Some(r#"{"entries":[]}"#));
        assert_eq!(completion_text("{}"), None);
    }
}
