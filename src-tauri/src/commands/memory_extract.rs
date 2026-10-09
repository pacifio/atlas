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
use std::time::{Duration, Instant};

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

/// How long after a session's end a turn job from it still counts as that
/// session's last turn (the two are queued from different threads, so the
/// end can be handled a moment before its last turn).
const LATE_TURN_WINDOW: Duration = Duration::from_secs(120);

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
    /// Sessions whose end was handled, and when. A turn job that arrives
    /// shortly after its session's end (the two come from different threads)
    /// runs as the end pass instead of waiting for an end that already
    /// happened.
    ended: Mutex<HashMap<String, Instant>>,
}

impl Extractor {
    pub fn new(memory: SharedMemoryStore, model: Arc<dyn ExtractionModel>) -> Self {
        Self {
            memory,
            model,
            turns: Mutex::new(HashMap::new()),
            ended: Mutex::new(HashMap::new()),
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
        // The end was handled before this turn's job: this is the session's
        // last word, so run it as the end pass and keep nothing for an end
        // that already happened.
        let late = self
            .ended
            .lock()
            .remove(&writer.session_id)
            .is_some_and(|at| at.elapsed() < LATE_TURN_WINDOW);
        if late {
            self.turns.lock().remove(&writer.session_id);
            return self
                .run(route, cwd, writer, &turns, Trigger::SessionEnd)
                .await;
        }
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
        // Marked first, so a turn job still in flight is recognised as late
        // even when this returns early. Marks older than the window are
        // dropped here, so a session resumed later is not mistaken for late.
        {
            let mut ended = self.ended.lock();
            ended.retain(|_, at| at.elapsed() < LATE_TURN_WINDOW);
            ended.insert(writer.session_id.clone(), Instant::now());
        }
        let Some(turns) = self.turns.lock().remove(&writer.session_id) else {
            return 0;
        };
        let Some(route) = self.route(sharing, cwd) else {
            return 0;
        };
        self.run(route, cwd, writer, &turns, Trigger::SessionEnd)
            .await
    }

    /// Whether this process holds `session_id`'s turns for its end pass
    /// (a turn of it finished here since it last started).
    pub fn holds_turns(&self, session_id: &str) -> bool {
        self.turns.lock().contains_key(session_id)
    }

    /// The end pass of a session whose turns this process does not hold,
    /// over its persisted conversation (`turns`, see [`persisted_turns`]).
    ///
    /// The end pass normally runs over the turns the turn-finished passes
    /// kept in memory. Those are gone when the app quits, and quitting is how
    /// most sessions end: the end is recorded on the way out and its pass, a
    /// model call, is cut off with the process. A session too short for the
    /// turn gates then contributes nothing, ever. This pass makes up for it,
    /// for an end that ran without turns and for every recent session the
    /// health pass finds that is no longer live. The persisted counters make
    /// it run once: nothing new since the last pass, no model call.
    pub async fn catch_up(
        &self,
        sharing: &MemorySharingState,
        cwd: &str,
        writer: &Writer,
        turns: Vec<TranscriptTurn>,
    ) -> usize {
        if self.holds_turns(&writer.session_id) {
            return 0; // live here: its own end pass covers it
        }
        let Some(route) = self.route(sharing, cwd) else {
            return 0;
        };
        // A long session is read in prompt-sized passes from where the last
        // pass stopped, not in one pass that would see only its tail; at
        // most CATCH_UP_PASSES now, the next job carries on.
        let mut recorded = 0;
        for _ in 0..CATCH_UP_PASSES {
            let (ran, stored) = self
                .run_pass(
                    route.clone(),
                    cwd,
                    writer,
                    &turns,
                    Trigger::SessionEnd,
                    Some(CATCH_UP_CHUNK_CHARS),
                )
                .await;
            recorded += stored;
            if !ran {
                break;
            }
        }
        recorded
    }

    /// The model a pass in `cwd` would ask, or `None` when no pass runs there
    /// (sharing off, the reserved local mode, no account and no BYOK choice).
    /// The model passes ask (the dream pass asks it too, with the same
    /// consent).
    pub fn model(&self) -> Arc<dyn ExtractionModel> {
        self.model.clone()
    }

    /// The route a pass for `cwd` takes: `None` when sharing is off or no
    /// model is configured.
    pub(crate) fn route(&self, sharing: &MemorySharingState, cwd: &str) -> Option<Route> {
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
        self.run_pass(route, cwd, writer, turns, trigger, None)
            .await
            .1
    }

    /// One pass; `(whether it ran, entries recorded)`. With `chunk`, the
    /// pass reads only the turns from where the last one stopped up to about
    /// `chunk` characters of text ([`chunk_end`]), so the next pass can read
    /// on from there.
    async fn run_pass(
        &self,
        route: Route,
        cwd: &str,
        writer: &Writer,
        turns: &[TranscriptTurn],
        trigger: Trigger,
        chunk: Option<usize>,
    ) -> (bool, usize) {
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
                return (false, 0);
            }
        };
        let passes_before = state.extraction_count;
        // A chunked pass reads turns whose outside reads are known per turn
        // (the recorder's), and its prompt holds only the chunk: whether it
        // read outside content is the chunk's. An unchunked pass judges the
        // whole conversation.
        let start = state.last_extracted_turn_index.min(turns.len());
        let (turns, judged) = match chunk {
            Some(chars) => {
                let end = chunk_end(turns, start, chars);
                (&turns[..end], &turns[start..end])
            }
            None => (turns, turns),
        };
        let external = judged.iter().any(|t| t.external);

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
                // Warn, not debug: a pass that keeps failing (the gateway
                // unreachable, no model for the org) is otherwise invisible,
                // and memory silently stops growing.
                tracing::warn!(target: "atlas::shared_memory", "extraction pass failed: {e:#}");
                return (false, 0);
            }
        };
        if state.extraction_count == passes_before {
            return (false, 0); // no pass ran (the gates are not met yet): nothing to save
        }

        // Persist the counters and land the entries (SQLite writes: off the
        // async runtime).
        let (memory, cwd, writer) = (self.memory.clone(), cwd.to_string(), writer.clone());
        let recorded = tokio::task::spawn_blocking(move || {
            if let Err(e) = state.save(&memory_dir, &writer.session_id) {
                tracing::warn!(target: "atlas::shared_memory", "extraction state not saved: {e:#}");
            }
            let mut recorded = 0;
            for entry in found {
                // A pass over a session that read outside content proposes,
                // it does not decide: its entries are candidates (M0, 12c).
                let confidence = if external {
                    entry.confidence.min(atlas_memory::record::CANDIDATE_CONFIDENCE)
                } else {
                    entry.confidence
                };
                match memory.record_extracted(&cwd, &writer, entry.kind, &entry.content, confidence) {
                    Ok(_) => recorded += 1,
                    Err(e) => tracing::warn!(target: "atlas::shared_memory", "extracted entry not recorded: {e}"),
                }
            }
            recorded
        })
        .await;
        (true, recorded.unwrap_or(0))
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
            external: m.tool_calls.iter().any(is_external),
        })
        .collect()
}

/// How far back the health pass looks for sessions whose end pass never ran.
pub const CATCH_UP_WINDOW_MS: i64 = 14 * 24 * 3600 * 1000;
/// At most this many sessions per health pass.
pub const CATCH_UP_MAX: usize = 30;
/// At most this many passes over one session per catch-up job.
pub const CATCH_UP_PASSES: usize = 3;
/// About how much text one catch-up pass reads: the prompt's own cap
/// (`atlas_memory::extract`), which keeps only the newest text beyond it.
const CATCH_UP_CHUNK_CHARS: usize = 6000;

/// Where a pass that starts at turn `start` and reads about `chars`
/// characters of text ends (exclusive): past at least one assistant turn
/// with text, so an end pass over it is due, and never short of `start + 1`.
fn chunk_end(turns: &[TranscriptTurn], start: usize, chars: usize) -> usize {
    let start = start.min(turns.len());
    let (mut used, mut answered) = (0usize, false);
    for (i, turn) in turns.iter().enumerate().skip(start) {
        let len = turn.text.trim().len();
        if used + len > chars && answered {
            return i;
        }
        used += len;
        answered |= turn.role == "assistant" && len > 0;
    }
    turns.len()
}

/// A session must have been idle this long before a catch-up pass reads it:
/// one still running — in another Atlas process on the same data directory
/// (a dev build beside the installed app), or a terminal agent — is read once
/// it pauses, not mid-run on every scan.
pub const CATCH_UP_IDLE_MS: i64 = 15 * 60 * 1000;

/// Of `candidates` (each session with its last activity), the ones a
/// catch-up pass looks at: active within [`CATCH_UP_WINDOW_MS`] of `now`,
/// idle for [`CATCH_UP_IDLE_MS`], not `live` in this process, newest first,
/// at most [`CATCH_UP_MAX`]. Whether one has anything new is the extractor's
/// call (its persisted counters).
fn pick_catch_up(
    candidates: Vec<(Writer, i64)>,
    now: i64,
    live: &dyn Fn(&str) -> bool,
) -> Vec<Writer> {
    let window = (now - CATCH_UP_WINDOW_MS)..=(now - CATCH_UP_IDLE_MS);
    let mut rows: Vec<_> = candidates
        .into_iter()
        .filter(|(w, at)| !w.agent.is_empty() && window.contains(at) && !live(&w.session_id))
        .collect();
    rows.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.session_id.cmp(&b.0.session_id))
    });
    rows.into_iter()
        .take(CATCH_UP_MAX)
        .map(|(w, _)| w)
        .collect()
}

/// The sessions of `store` a catch-up pass looks at ([`pick_catch_up`]). A
/// session's last activity is the newest of its start, its end and its
/// events in the log, so one still running in another process is left
/// alone however long ago it started.
pub fn catch_up_sessions(
    store: &atlas_memory::record::RecordStore,
    now: i64,
    live: &dyn Fn(&str) -> bool,
) -> Vec<Writer> {
    let last_event = store
        .last_event_by_session(now - CATCH_UP_WINDOW_MS)
        .unwrap_or_default();
    let candidates = store
        .sessions()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|s| {
            let at = [
                s.started_at,
                s.ended_at,
                last_event.get(&s.session_id).copied(),
            ]
            .into_iter()
            .flatten()
            .max()?;
            Some((
                Writer {
                    agent: s.agent,
                    session_id: s.session_id,
                },
                at,
            ))
        })
        .collect();
    pick_catch_up(candidates, now, live)
}

/// The recorded sessions (any agent; the imported terminal ones only when
/// `reach` admits them, see `MemorySharingState::extraction_reach`) a
/// catch-up pass looks at ([`pick_catch_up`]), by their recorded activity.
pub fn recorded_catch_up_sessions(
    stores: &super::memory_capture::ScopeStores,
    reach: super::memory_capture::Reach,
    now: i64,
    live: &dyn Fn(&str) -> bool,
) -> Vec<Writer> {
    pick_catch_up(stores.session_activity(reach), now, live)
}

/// The recorded and the hosted candidates as one list, each session once
/// (the recorder's spelling of its agent wins), at most [`CATCH_UP_MAX`].
pub fn merge_catch_up(recorded: Vec<Writer>, hosted: Vec<Writer>) -> Vec<Writer> {
    let mut seen = std::collections::HashSet::new();
    recorded
        .into_iter()
        .chain(hosted)
        .filter(|w| seen.insert(w.session_id.clone()))
        .take(CATCH_UP_MAX)
        .collect()
}

/// A session's conversation as Atlas persisted it, for an end pass that runs
/// after the live turns are gone; `None` when Atlas recorded none.
///
/// The capture recorder is read first ([`recorded_turns`]): it holds every
/// agent's sessions, including the terminal ones its importer read off disk,
/// which Atlas never hosted and so has no other record of. Those are read
/// only when `reach` admits them (`MemorySharingState::extraction_reach`);
/// otherwise such a session has no conversation here at all. Atlas's own
/// transcript (`agent_transcript`) is the fallback, looked up under `cwd`,
/// then in every project directory (the session may have run in a worktree
/// or a subdirectory of the scope). It keeps text, not tool calls, so
/// whether that session read outside content is unknown, and the pass is
/// treated as having read some: its entries are candidates (M0).
pub fn persisted_turns(
    config_dir: &std::path::Path,
    cwd: &str,
    session_id: &str,
    reader: &super::memory_capture::CaptureReader,
    reach: super::memory_capture::Reach,
) -> Option<Vec<TranscriptTurn>> {
    use super::agent_transcript as transcripts;
    let stores = reader.stores(cwd);
    let found = stores.find_within(session_id, reach);
    if let Some(turns) = found.as_ref().map(recorded_turns).filter(|t| !t.is_empty()) {
        return Some(turns);
    }
    let stored = transcripts::read(config_dir, cwd, session_id).or_else(|| {
        let name = format!("{}.json", transcripts::sanitize_id(session_id));
        std::fs::read_dir(config_dir.join("agent-transcripts"))
            .ok()?
            .flatten()
            .find_map(|dir| transcripts::read_file(&dir.path().join(&name)))
    })?;
    let external = match &found {
        Some(found) => found
            .store
            .tool_calls_for_session(&found.session.id)
            .unwrap_or_default()
            .iter()
            .any(recorded_call_is_external),
        None => true,
    };
    let mut turns: Vec<TranscriptTurn> = stored
        .messages
        .iter()
        .map(|m| TranscriptTurn {
            role: m.role.clone(),
            text: atlas_agent_transcript::strip_injected_context(&m.content),
            tool_calls: 0,
            external: false,
        })
        .collect();
    for turn in &mut turns {
        turn.external = external;
    }
    Some(turns)
}

/// A recorded session's conversation as the extractor reads it: its text
/// messages in order (thinking and tool rows left out), Atlas's injected
/// blocks stripped. A turn's tool calls are counted on its last assistant
/// message, and every message of a turn that made an outside call (a fetch,
/// a third-party MCP tool) is marked external.
pub fn recorded_turns(found: &super::memory_capture::Recorded<'_>) -> Vec<TranscriptTurn> {
    use atlas_checkpoint::{Mode, Role};
    let messages = found
        .store
        .messages_for_session(&found.session.id)
        .unwrap_or_default();
    let calls = found
        .store
        .tool_calls_for_session(&found.session.id)
        .unwrap_or_default();
    let mut per_turn: HashMap<i64, (usize, bool)> = HashMap::new();
    for call in &calls {
        let slot = per_turn.entry(call.turn_seq).or_default();
        slot.0 += 1;
        slot.1 |= recorded_call_is_external(call);
    }
    let mut turns: Vec<(i64, TranscriptTurn)> = messages
        .iter()
        .filter(|m| m.mode == Mode::Text)
        .filter_map(|m| {
            let body = found
                .store
                .message_body(m)
                .unwrap_or_else(|_| m.preview.clone());
            let text = atlas_agent_transcript::strip_injected_context(&body);
            if text.trim().is_empty() {
                return None;
            }
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::System => "system",
            };
            Some((
                m.turn_seq,
                TranscriptTurn {
                    role: role.to_string(),
                    text,
                    tool_calls: 0,
                    external: per_turn.get(&m.turn_seq).is_some_and(|t| t.1),
                },
            ))
        })
        .collect();
    // Each turn's calls, on its last assistant message.
    let mut counted: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (turn_seq, turn) in turns.iter_mut().rev() {
        if turn.role == "assistant" && counted.insert(*turn_seq) {
            turn.tool_calls = per_turn.get(turn_seq).map_or(0, |t| t.0);
        }
    }
    turns.into_iter().map(|(_, t)| t).collect()
}

/// Whether a recorded call read outside content ([`is_external`]).
fn recorded_call_is_external(call: &atlas_checkpoint::ToolCall) -> bool {
    call.tool_name == atlas_checkpoint::tools::ToolName::Fetch
        || is_external_parts(
            call.tool_name.as_str(),
            call.title.as_deref(),
            call.kind.as_deref(),
        )
}

/// Atlas's own tool servers: their results are not outside content.
const OWN_SERVERS: [&str; 4] = ["atlas_memory", "atlas_code", "atlas_ui", "atlas_org"];

/// Whether a tool call brought outside content into the session: a web fetch
/// or search, or an MCP tool of a server other than Atlas's own. MCP calls
/// are spelled `mcp__<server>__<tool>` by ACP agents and `<server>.<tool>` by
/// the native agent, in the tool name or the title.
fn is_external(call: &atlas_agent_wire::ToolCall) -> bool {
    is_external_parts(&call.tool_name, call.title.as_deref(), call.kind.as_deref())
}

/// [`is_external`] over a call's name, title and ACP kind.
fn is_external_parts(tool_name: &str, title: Option<&str>, kind: Option<&str>) -> bool {
    if kind == Some("fetch") {
        return true;
    }
    // The native agent's MCP calls carry kind `other`. A shell command, read
    // or edit whose title starts with a dotted word (`python3.12 -m pytest`,
    // `Cargo.toml`) is not one.
    let dotted = !matches!(
        kind,
        Some("execute" | "read" | "edit" | "search" | "delete" | "move")
    );
    let mut names = std::iter::once(tool_name).chain(title);
    names.any(|name| {
        let lower = name.to_ascii_lowercase();
        let first = lower
            .split(|c: char| c.is_whitespace() || matches!(c, '(' | ':' | '[' | '<'))
            .next()
            .unwrap_or("");
        ["web_search", "websearch", "web_fetch", "webfetch"]
            .iter()
            .any(|w| first.contains(w))
            || mcp_server(first, dotted).is_some_and(|server| !OWN_SERVERS.contains(&server))
    })
}

/// The server half of an MCP call's name (see [`is_external`]); `None` for
/// anything else. The `<server>.<tool>` form is read only when `dotted`, and
/// never from a token with a `/` in it or an all-digit tool half, so a file
/// path or a version (`python3.12`) is never read as a call.
fn mcp_server(token: &str, dotted: bool) -> Option<&str> {
    if let Some(rest) = token.strip_prefix("mcp__") {
        return rest.split_once("__").map(|(server, _)| server);
    }
    if !dotted || token.contains('/') {
        return None;
    }
    let ident = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    let (server, tool) = token.split_once('.')?;
    (ident(server) && ident(tool) && !tool.bytes().all(|b| b.is_ascii_digit())).then_some(server)
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
async fn gateway_completion(app: &AppHandle, prompt: String) -> Result<String, String> {
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
    use crate::commands::memory_capture::Reach;
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
                external: false,
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

    /// The end of a session can be handled before its last turn's job (they
    /// come from two threads). That turn still gets an end pass, and its
    /// turns are not kept forever for an end that already happened.
    #[tokio::test]
    async fn a_turn_after_its_session_ended_runs_as_the_end_pass() {
        let h = harness("late-turn", true);
        assert_eq!(
            h.extractor
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            0
        );
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert_eq!(
            recorded, 4,
            "below the turn gate, but an end pass needs only new assistant text"
        );
        assert!(
            !h.extractor.turns.lock().contains_key("sess-1"),
            "not kept after its end"
        );
    }

    #[tokio::test]
    async fn a_pass_over_a_session_that_fetched_the_web_stores_candidates() {
        let h = harness("external", true);
        let mut turns = session(26);
        turns[10].external = true;
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), turns)
            .await;
        assert!(recorded > 0);
        let entries = h.memory.entries(&h.project);
        assert!(
            entries
                .iter()
                .all(|e| e.confidence <= atlas_memory::record::CANDIDATE_CONFIDENCE),
            "{entries:?}"
        );
    }

    /// Most sessions end at quit: the end is recorded on the way out and its
    /// pass is cut off with the process, so the turns kept for it are gone.
    /// A short session (below the turn gates) then left nothing, and memory
    /// stopped growing. The catch-up pass runs it later over the persisted
    /// conversation, once.
    #[tokio::test]
    async fn a_session_whose_end_pass_was_lost_is_caught_up_once() {
        let h = harness("catch-up", true);
        // A short session: below the turn gates, its end pass never ran.
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert_eq!(recorded, 0);
        // The app quit: the turns held for the end pass die with it.
        let restarted = Extractor::new(h.memory.clone(), h.model.clone());
        assert_eq!(
            restarted
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            0,
            "no turns held: the plain end pass has nothing to send"
        );
        assert!(!restarted.holds_turns("sess-1"));

        let recorded = restarted
            .catch_up(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert_eq!(recorded, 4);
        let decisions = h.memory.list_entries(&h.project, Some(EntryKind::Decision));
        assert_eq!(decisions.len(), 1);
        assert_eq!(
            decisions[0].state,
            atlas_memory::record::State::Active,
            "briefed, not a candidate"
        );
        assert_eq!(h.model.calls().len(), 1);

        // Nothing new since: the next health pass asks nothing.
        restarted
            .catch_up(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert_eq!(h.model.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_session_whose_turns_are_held_here_is_not_caught_up() {
        let h = harness("catch-up-live", true);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert!(h.extractor.holds_turns("sess-1"));
        let recorded = h
            .extractor
            .catch_up(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert_eq!(recorded, 0);
        assert!(h.model.calls().is_empty());
    }

    /// The persisted conversation is text only; whether the session read
    /// outside content comes from the recorder, and is assumed when the
    /// recorder never saw the session.
    #[test]
    fn the_persisted_conversation_is_read_and_unknown_tools_count_as_outside() {
        let config =
            std::env::temp_dir().join(format!("atlas-extract-cfg-{}", uuid::Uuid::new_v4()));
        let cwd = "/nowhere/project";
        let dir = super::super::agent_transcript::dir_for(&config, cwd);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("sess-9.json"),
            serde_json::json!({
                "id": "sess-9", "plugin_id": "claude-acp", "cwd": cwd,
                "created_at": "", "updated_at": "",
                "messages": [
                    {"role": "user", "content": "use bun", "timestamp": ""},
                    {"role": "assistant", "content": "Done.", "timestamp": ""}
                ]
            })
            .to_string(),
        )
        .unwrap();
        let reader = super::super::memory_capture::CaptureReader::default();
        let turns = persisted_turns(&config, cwd, "sess-9", &reader, Reach::Hosted).unwrap();
        assert_eq!(
            turns
                .iter()
                .map(|t| (t.role.as_str(), t.text.as_str()))
                .collect::<Vec<_>>(),
            [("user", "use bun"), ("assistant", "Done.")]
        );
        assert!(
            turns.iter().any(|t| t.external),
            "no recorder: outside content assumed"
        );
        // Found from another project directory too (a worktree's session).
        let turns =
            persisted_turns(&config, "/elsewhere", "sess-9", &reader, Reach::Hosted).unwrap();
        assert_eq!(turns.len(), 2);
        assert!(persisted_turns(&config, cwd, "missing", &reader, Reach::Hosted).is_none());
        let _ = std::fs::remove_dir_all(&config);
    }

    /// Record a session the way the terminal-gap importer files one: under
    /// `external_jsonl`, every user entry opening a turn.
    fn import_terminal_session(
        project: &str,
        native_id: &str,
        entries: &[(atlas_checkpoint::Role, &str)],
        tool: Option<(atlas_checkpoint::tools::ToolName, &str)>,
    ) {
        use atlas_checkpoint::model::ProjectMode;
        use atlas_checkpoint::{Capture, Mode, Role, SessionKey, Source, Store, TurnContent};
        let mut store = Store::open(atlas_checkpoint::atlas_dir(project)).unwrap();
        let mut capture = Capture::new(&mut store, ProjectMode::Local);
        let key = SessionKey {
            workspace_id: project.to_string(),
            source: Source::ExternalJsonl,
            native_session_id: native_id.into(),
        };
        let (mut turn, mut row) = (0i64, String::new());
        for (i, (role, body)) in entries.iter().enumerate() {
            if *role == Role::User {
                turn += 1;
                row = capture
                    .record_prompt(&key, body, turn, Some("claude-code"), None, Some(project))
                    .unwrap();
            } else {
                capture
                    .record_turn(
                        &row,
                        TurnContent {
                            turn_seq: turn,
                            native_message_id: Some(format!("{native_id}-{i}")),
                            role: *role,
                            mode: Mode::Text,
                            body: body.to_string(),
                            created_at: None,
                        },
                    )
                    .unwrap();
            }
        }
        if let Some((name, kind)) = tool {
            capture
                .record_tool_call(
                    &row,
                    atlas_checkpoint::ToolCallContent {
                        turn_seq: turn,
                        native_call_id: Some("call-1"),
                        tool_name: name,
                        title: None,
                        kind: Some(kind),
                        status: atlas_checkpoint::ToolStatus::Completed,
                        locations: &serde_json::json!([]),
                        arguments: None,
                        result: None,
                    },
                )
                .unwrap();
        }
    }

    /// Most work runs in terminal sessions Atlas never hosts: the recorder
    /// imports their transcripts, and that is the only conversation Atlas
    /// has of them. Their end pass reads it.
    #[test]
    fn a_terminal_sessions_conversation_is_read_from_the_recorder() {
        use atlas_checkpoint::tools::ToolName;
        use atlas_checkpoint::Role;
        let project = super::super::memory_pack::test_support::scratch_project("terminal");
        let config = std::path::PathBuf::from(
            super::super::memory_pack::test_support::scratch_project("no-transcripts"),
        );
        import_terminal_session(
            &project,
            "cli-1",
            &[
                (Role::User, "use bun, never npm"),
                (Role::Assistant, "Noted: bun it is."),
                (Role::User, "and run the gates"),
                (Role::Assistant, "Lint, format and typecheck are green."),
            ],
            Some((ToolName::Bash, "execute")),
        );
        let reader = super::super::memory_capture::CaptureReader::default();
        let turns = persisted_turns(&config, &project, "cli-1", &reader, Reach::WithImported)
            .expect("recorded");
        assert_eq!(
            turns
                .iter()
                .map(|t| (t.role.as_str(), t.text.as_str()))
                .collect::<Vec<_>>(),
            [
                ("user", "use bun, never npm"),
                ("assistant", "Noted: bun it is."),
                ("user", "and run the gates"),
                ("assistant", "Lint, format and typecheck are green."),
            ]
        );
        assert_eq!(turns.iter().map(|t| t.tool_calls).sum::<usize>(), 1);
        assert!(
            !turns.iter().any(|t| t.external),
            "a shell call is not outside content"
        );

        // A web fetch in it makes its entries candidates.
        import_terminal_session(
            &project,
            "cli-2",
            &[
                (Role::User, "read the docs"),
                (Role::Assistant, "Read them."),
            ],
            Some((ToolName::Fetch, "fetch")),
        );
        let turns =
            persisted_turns(&config, &project, "cli-2", &reader, Reach::WithImported).unwrap();
        assert!(turns.iter().any(|t| t.external));

        // And the scan finds both, newest first, and not a live one.
        let since = chrono::Utc::now().timestamp_millis() - 60_000;
        let found: Vec<(String, String)> = reader
            .stores(&project)
            .recent_sessions(since, i64::MAX)
            .into_iter()
            .filter(|w| w.session_id != "live")
            .map(|w| (w.agent, w.session_id))
            .collect();
        assert_eq!(
            found,
            [
                ("claude-code".to_string(), "cli-2".to_string()),
                ("claude-code".to_string(), "cli-1".to_string())
            ]
        );
        assert!(
            reader
                .stores(&project)
                .recent_sessions(since, since)
                .is_empty(),
            "a session active after the idle cutoff is still running"
        );
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&config);
    }

    /// A terminal session the recorder imported from outside Atlas is read
    /// for extraction, and so sent to the model, only once the user turned
    /// `fromExternalSessions` on: with it off the catch-up scan never lists
    /// it and its conversation is never read.
    #[tokio::test]
    async fn an_imported_session_is_extracted_only_when_the_user_allows_it() {
        use atlas_checkpoint::Role;
        let h = harness("imported-gate", true);
        let config = std::path::PathBuf::from(
            super::super::memory_pack::test_support::scratch_project("imported-gate-cfg"),
        );
        import_terminal_session(
            &h.project,
            "cli-ext",
            &[
                (Role::User, "we decided to use bun, never npm"),
                (Role::Assistant, "Noted: bun it is."),
                (Role::User, "and the ledger stays on Postgres"),
                (Role::Assistant, "Kept it on Postgres."),
            ],
            None,
        );
        let reader = super::super::memory_capture::CaptureReader::default();
        let later = chrono::Utc::now().timestamp_millis() + CATCH_UP_IDLE_MS + 60_000;
        let scan = |reach| -> Vec<String> {
            recorded_catch_up_sessions(&reader.stores(&h.project), reach, later, &|_| false)
                .into_iter()
                .map(|w| w.session_id)
                .collect()
        };
        let imported = Writer {
            agent: "claude-code".into(),
            session_id: "cli-ext".into(),
        };

        // Off (the default): not listed, not read, nothing sent.
        let reach = h.sharing.extraction_reach(&h.project);
        assert_eq!(reach, Reach::Hosted);
        assert!(scan(reach).is_empty(), "an imported session is not scanned");
        assert!(persisted_turns(&config, &h.project, "cli-ext", &reader, reach).is_none());
        assert!(h.model.calls().is_empty());

        // On: listed, read and extracted.
        h.sharing
            .set_from_external_sessions(&h.project, true)
            .unwrap();
        let reach = h.sharing.extraction_reach(&h.project);
        assert_eq!(reach, Reach::WithImported);
        assert_eq!(scan(reach), ["cli-ext"]);
        let turns = persisted_turns(&config, &h.project, "cli-ext", &reader, reach)
            .expect("the imported conversation is read");
        assert_eq!(turns.len(), 4);
        let recorded = h
            .extractor
            .catch_up(&h.sharing, &h.project, &imported, turns)
            .await;
        assert!(recorded > 0);
        assert_eq!(h.model.calls().len(), 1);
        let _ = std::fs::remove_dir_all(&config);
    }

    /// A long session caught up later is read in prompt-sized passes, not
    /// one pass over its tail, at most [`CATCH_UP_PASSES`] per job; the
    /// next job carries on where the last stopped.
    #[tokio::test]
    async fn a_long_session_is_caught_up_in_prompt_sized_passes() {
        let h = harness("catch-up-long", true);
        // Turn 3 fetched the web: only the pass that reads it proposes.
        let long: Vec<TranscriptTurn> = (0..200)
            .map(|i| TranscriptTurn {
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                text: format!("turn {i} {}", "x".repeat(300)),
                tool_calls: 0,
                external: i == 3,
            })
            .collect();
        h.extractor
            .catch_up(&h.sharing, &h.project, &writer(), long.clone())
            .await;
        assert_eq!(h.model.calls().len(), CATCH_UP_PASSES);
        let decision = h
            .memory
            .list_entries(&h.project, Some(EntryKind::Decision))
            .pop()
            .unwrap();
        assert_eq!(
            decision.state,
            atlas_memory::record::State::Active,
            "a later pass that read no outside content confirms what the first only proposed"
        );
        h.extractor
            .catch_up(&h.sharing, &h.project, &writer(), long.clone())
            .await;
        let after_two = h.model.calls().len();
        assert_eq!(after_two, 2 * CATCH_UP_PASSES);
        // Drained: 200 turns of ~310 chars is ~62k chars, ~11 passes.
        for _ in 0..5 {
            h.extractor
                .catch_up(&h.sharing, &h.project, &writer(), long.clone())
                .await;
        }
        let total = h.model.calls().len();
        assert!((10..=13).contains(&total), "{total} passes");
        h.extractor
            .catch_up(&h.sharing, &h.project, &writer(), long)
            .await;
        assert_eq!(h.model.calls().len(), total, "nothing new: no call");
    }

    #[test]
    fn catch_up_looks_at_recent_sessions_that_are_not_live() {
        let root =
            std::env::temp_dir().join(format!("atlas-extract-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = atlas_memory::record::open_scope(&root).unwrap();
        let day = 24 * 3600 * 1000;
        let now = 100 * day;
        store
            .session_started("old", "codex-acp", now - 30 * day)
            .unwrap();
        store
            .session_started("ended", "claude-acp", now - 3 * day)
            .unwrap();
        store
            .session_ended("ended", "claude-acp", now - 2 * day)
            .unwrap();
        store
            .session_started("open", "claude-acp", now - day)
            .unwrap();
        store
            .session_started("live", "claude-acp", now - day / 2)
            .unwrap();
        let got: Vec<String> = catch_up_sessions(&store, now, &|id| id == "live")
            .into_iter()
            .map(|w| w.session_id)
            .collect();
        assert_eq!(got, ["open", "ended"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A session not live here may be live in another Atlas process on the
    /// same data directory: one that started, or did anything, within the
    /// idle cutoff is left for a later scan.
    #[test]
    fn catch_up_leaves_a_session_active_elsewhere_alone() {
        let root = tempfile::TempDir::new().unwrap();
        let store = atlas_memory::record::open_scope(root.path()).unwrap();
        let minute = 60 * 1000;
        let now = 1_000 * 24 * 60 * minute;
        store
            .session_started("just-started", "claude-acp", now - 5 * minute)
            .unwrap();
        store
            .session_started("busy", "codex-acp", now - 120 * minute)
            .unwrap();
        store
            .append_event(
                atlas_memory::record::NewEvent {
                    agent: "codex-acp".into(),
                    session_id: "busy".into(),
                    kind: atlas_memory::record::EventKind::FileChanged,
                    key: "src/a.rs".into(),
                    payload: serde_json::json!({}),
                },
                now - 2 * minute,
            )
            .unwrap();
        store
            .session_started("paused", "codex-acp", now - 60 * minute)
            .unwrap();
        let got: Vec<String> = catch_up_sessions(&store, now, &|_| false)
            .into_iter()
            .map(|w| w.session_id)
            .collect();
        assert_eq!(got, ["paused"]);
    }

    #[test]
    fn outside_content_is_a_web_call_or_a_third_party_mcp_tool() {
        let call =
            |name: &str, title: Option<&str>, kind: Option<&str>| atlas_agent_wire::ToolCall {
                id: "c".into(),
                tool_name: name.into(),
                title: title.map(str::to_string),
                kind: kind.map(str::to_string),
                status: atlas_agent_wire::ToolCallStatus::Completed,
                arguments: serde_json::json!({}),
                result: None,
                locations: vec![],
                raw_output: None,
                content_blocks: vec![],
            };
        assert!(is_external(&call("WebFetch", None, Some("fetch"))));
        assert!(is_external(&call("WebSearch", None, None)));
        assert!(is_external(&call("mcp__acme__deploy", None, None)));
        assert!(is_external(&call(
            "tool",
            Some("github.search_issues"),
            None
        )));
        assert!(!is_external(&call(
            "mcp__atlas_memory__memory_search",
            None,
            None
        )));
        assert!(!is_external(&call("atlas_code.grep", None, None)));
        assert!(!is_external(&call(
            "Edit src/foo.rs",
            Some("Edit src/foo.rs"),
            Some("edit")
        )));
        assert!(!is_external(&call(
            "Read",
            Some("Read /repo/README.md"),
            Some("read")
        )));
        // A dotted first word of a command or a bare file name is no MCP call.
        assert!(!is_external(&call(
            "python3.12 -m pytest",
            Some("python3.12 -m pytest"),
            Some("execute")
        )));
        assert!(!is_external(&call("python3.12 -m pytest", None, None)));
        assert!(!is_external(&call(
            "Cargo.toml",
            Some("Cargo.toml"),
            Some("read")
        )));
        assert!(is_external(&call(
            "github.search_issues",
            None,
            Some("other")
        )));
    }
}
