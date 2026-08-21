//! Backend certification suite for the ACP registry-only port.
//!
//! Drives the SAME seams production uses — nothing is mocked below the prompt:
//!
//!   `RegistryStore` (install/uninstall/spec synthesis)
//!     → `AgentManager` (spawn / new_session / send / cancel / set_mode /
//!        set_config_option / load_session — the exact API the Tauri commands call)
//!     → the `DeltaSink` + `subscribe()` broadcast bus (what `BroadcastMiddleware`
//!        and the window event channel consume)
//!     → `atlas_checkpoint::Capture` fed from that delta stream (what
//!        `CaptureMiddleware` does in the host) and read back via `timeline`.
//!
//! Coverage, per the certification brief:
//!   basic tool calls · plan mode · mode/model/config switching · cancel mid-turn
//!   + follow-up + session/load resume · streaming granularity · delta broadcast
//!   + wire ordering · sessions.db transcription · N agents × 10 tmp projects ·
//!   install/uninstall stress.
//!
//! ```bash
//! OPENAI_API_KEY=… GOOGLE_API_KEY=… \
//!   cargo run --manifest-path crates/atlas-agents/Cargo.toml --example backend_suite
//! AGENTS="claude-acp,opencode" PHASES="matrix,timeline" … # scope it
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use atlas_agents::{
    AgentId, AgentManager, DeltaSink, PermissionDecision, SessionDelta, SessionDeltaEnvelope,
    SessionKey,
};
use atlas_checkpoint::capture::{Capture, SessionKey as CaptureKey, ToolCallContent, TurnContent};
use atlas_checkpoint::model::{Mode, Role, Source, ToolStatus, WorkspaceMode};
use atlas_checkpoint::Store;
use atlas_checkpoint::timeline;
use atlas_registry::RegistryStore;

/// The 10 most-installed agents to certify: the three the brief names plus
/// seven by popularity, spread across npx and per-platform-binary
/// distributions. `DEEP` are the ones whose auth can complete non-interactively
/// on this machine (local CLI creds, free tiers, or the provided API keys) and
/// therefore run real turns; the rest still certify install → spawn →
/// initialize → advertisement.
const AGENTS: &[&str] = &[
    "claude-acp",
    "codex-acp",
    "opencode",
    "gemini",
    "github-copilot-cli",
    "cursor",
    "cline",
    "kilo",
    "qwen-code",
    "goose",
];
const DEEP: &[&str] = &[
    "claude-acp",
    "codex-acp",
    "opencode",
    "gemini",
    "github-copilot-cli",
    "cursor",
    "cline",
];

const TURN_TIMEOUT: Duration = Duration::from_secs(240);
const STEP_TIMEOUT: Duration = Duration::from_secs(45);

// ── Recording sink: the DeltaSink seam BroadcastMiddleware occupies ─────────

#[derive(Default)]
struct Recorder {
    all: StdMutex<Vec<SessionDeltaEnvelope>>,
}

impl DeltaSink for Recorder {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.all.lock().unwrap().push(envelope);
    }
}

impl Recorder {
    fn for_session(&self, session_id: &str) -> Vec<SessionDelta> {
        self.all
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.delta.clone())
            .collect()
    }
}

// ── Per-agent result matrix ─────────────────────────────────────────────────

#[derive(Default, Clone)]
struct AgentReport {
    install: Option<Result<String, String>>,
    spawn: Option<Result<String, String>>,
    modes: usize,
    config_options: usize,
    turn_tool_call: Option<Result<String, String>>,
    streaming_chunks: Option<usize>,
    set_mode: Option<Result<String, String>>,
    set_config: Option<Result<String, String>>,
    plan_seen: bool,
    cancel_follow_up: Option<Result<String, String>>,
    resume: Option<Result<String, String>>,
    broadcast_order: Option<Result<String, String>>,
}

fn mark(r: &Option<Result<String, String>>) -> String {
    match r {
        None => "—".into(),
        Some(Ok(s)) => format!("ok {}", s.chars().take(26).collect::<String>()),
        Some(Err(e)) => format!("FAIL {}", e.chars().take(40).collect::<String>()),
    }
}

// ── Delta-stream helpers ────────────────────────────────────────────────────

/// Await deltas for one session until `until` returns Some, driving the
/// permission auto-responder the whole time (a suite that never answers
/// permission prompts deadlocks on the first guarded tool call).
///
/// Takes the receiver by `&mut` so callers subscribe BEFORE the action that
/// produces deltas — subscribing after `send` races the first chunks (the
/// broadcast bus has no replay), which surfaced in run 1 as truncated
/// follow-up text and clipped concurrency tokens.
async fn drive<T>(
    manager: &AgentManager,
    rx: &mut tokio::sync::broadcast::Receiver<atlas_agents::SessionDeltaEnvelope>,
    key: &SessionKey,
    timeout: Duration,
    mut until: impl FnMut(&SessionDelta) -> Option<T>,
) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "timed out".to_string())?;
        let env = match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(env)) => env,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => return Err(format!("bus closed: {e}")),
            Err(_) => return Err("timed out".into()),
        };
        if env.session_id != key.session_id {
            continue;
        }
        if let SessionDelta::PermissionRequest {
            request_id,
            options,
            ..
        } = &env.delta
        {
            // Auto-approve with the first offered option — the same round-trip
            // the permission card drives.
            let option_id = options
                .as_array()
                .and_then(|a| a.first())
                .and_then(|o| o.get("optionId").or_else(|| o.get("option_id")))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let decision = match option_id {
                Some(option_id) => PermissionDecision::Selected { option_id },
                None => PermissionDecision::Cancelled,
            };
            let _ = manager.respond_permission(
                key.agent_id,
                &key.session_id,
                *request_id,
                decision,
            );
        }
        if let Some(v) = until(&env.delta) {
            return Ok(v);
        }
    }
}

/// Run one turn to a terminal delta, collecting assistant text + tool-call and
/// plan sightings on the way.
struct TurnOutcome {
    stop: Result<String, String>,
    text: String,
    text_chunks: usize,
    tool_calls: Vec<serde_json::Value>,
    plan_seen: bool,
    assistant_message_id: Option<String>,
}

async fn run_turn(
    manager: &AgentManager,
    key: &SessionKey,
    prompt: &str,
    timeout: Duration,
) -> TurnOutcome {
    let mut out = TurnOutcome {
        stop: Err("no terminal delta".into()),
        text: String::new(),
        text_chunks: 0,
        tool_calls: Vec::new(),
        plan_seen: false,
        assistant_message_id: None,
    };
    let mut rx = manager.subscribe();
    if let Err(e) = manager.send(key, prompt.to_string()) {
        out.stop = Err(format!("send: {e}"));
        return out;
    }
    let text = StdMutex::new((String::new(), 0usize));
    let tools: StdMutex<Vec<serde_json::Value>> = StdMutex::new(Vec::new());
    let plan = StdMutex::new(false);
    let msg_id: StdMutex<Option<String>> = StdMutex::new(None);
    let stop = drive(manager, &mut rx, key, timeout, |d| match d {
        SessionDelta::MessageAppended { message } => {
            let v = serde_json::to_value(message).unwrap_or_default();
            if v.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                *msg_id.lock().unwrap() = v
                    .get("id")
                    .and_then(|i| i.as_str())
                    .map(str::to_string);
                // The FIRST chunk of an assistant message rides INSIDE this
                // delta as `message.content`; only continuations arrive as
                // `TextChunk` (apply.rs::append_text_chunk). Missing this is
                // how run 1/2 saw "ESSION_0_OK" and empty one-chunk replies.
                if let Some(seed) = v.get("content").and_then(|c| c.as_str()) {
                    if !seed.is_empty() {
                        let mut t = text.lock().unwrap();
                        t.0.push_str(seed);
                        t.1 += 1;
                    }
                }
            }
            None
        }
        SessionDelta::TextChunk { delta, .. } => {
            let mut t = text.lock().unwrap();
            t.0.push_str(delta);
            t.1 += 1;
            None
        }
        SessionDelta::ToolCallUpserted { tool_call, .. } => {
            tools
                .lock()
                .unwrap()
                .push(serde_json::to_value(tool_call).unwrap_or_default());
            None
        }
        SessionDelta::PlanUpdated { plan: p } => {
            if !p.is_empty() {
                *plan.lock().unwrap() = true;
            }
            None
        }
        SessionDelta::TurnFinished { stop_reason, .. } => Some(Ok(stop_reason.clone())),
        SessionDelta::TurnFailed { error, .. } => Some(Err(error.clone())),
        SessionDelta::AgentDisconnected { reason } => Some(Err(format!("disconnected: {reason}"))),
        _ => None,
    })
    .await;
    let t = text.into_inner().unwrap();
    out.text = t.0;
    out.text_chunks = t.1;
    out.tool_calls = tools.into_inner().unwrap();
    out.plan_seen = plan.into_inner().unwrap();
    out.assistant_message_id = msg_id.into_inner().unwrap();
    out.stop = match stop {
        Ok(inner) => inner,
        Err(e) => Err(e),
    };
    out
}

/// The universal auth ladder, exactly as the shared sign-in modal drives it:
/// try each advertised NON-terminal method until one lands. Returns whether
/// anything authenticated.
async fn try_authenticate(manager: &AgentManager, agent_id: AgentId) -> bool {
    let Ok(methods) = manager.auth_methods(agent_id) else {
        return false;
    };
    for m in methods {
        if m.terminal_command.is_some() {
            continue; // needs a human + browser; the modal's job, not ours
        }
        if manager.authenticate(agent_id, m.id.clone()).await.is_ok() {
            eprintln!("      🔑 authenticated via {}", m.id);
            return true;
        }
    }
    false
}

fn tmp_project(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("atlas-suite-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir tmp project");
    dir
}

fn is_auth_error(e: &str) -> bool {
    let e = e.to_lowercase();
    e.contains("auth") || e.contains("sign in") || e.contains("api key") || e.contains("log in")
}

// ── Phases ──────────────────────────────────────────────────────────────────

async fn phase_registry_stress(store: &Arc<RegistryStore>) -> Vec<String> {
    let mut failures = Vec::new();
    eprintln!("━━ P0 registry install/uninstall stress");

    // Fresh-install invariant.
    if !atlas_acp::SpecSource::extra_specs(store.as_ref()).is_empty() {
        failures.push("fresh store offered specs".into());
    }

    // Install all ten (binaries download for real).
    for id in AGENTS {
        let t0 = Instant::now();
        match store.install(id, None).await {
            Ok(i) => eprintln!("  ✓ install {id} v{} {:?}", i.version, t0.elapsed()),
            Err(e) => failures.push(format!("install {id}: {e}")),
        }
    }
    let n = atlas_acp::SpecSource::extra_specs(store.as_ref()).len();
    eprintln!("  → {n} spawnable specs after install");

    // Churn an npx agent 10×: uninstall must remove the spec, reinstall must
    // restore it, metadata must survive the whole time.
    for round in 0..10 {
        store.uninstall("cline", false).map_err(|e| failures.push(format!("churn uninstall: {e}"))).ok();
        if atlas_acp::SpecSource::extra_specs(store.as_ref())
            .iter()
            .any(|s| s.spec_id == "cline")
        {
            failures.push(format!("churn round {round}: uninstalled cline still spawnable"));
        }
        if store.metadata_for("cline").is_none() {
            failures.push(format!("churn round {round}: metadata lost on uninstall"));
        }
        if let Err(e) = store.install("cline", None).await {
            failures.push(format!("churn reinstall: {e}"));
        }
    }
    eprintln!("  ✓ 10× uninstall/reinstall churn");

    // 6 concurrent installs of one BINARY agent — the download lock must
    // serialize them into one archive fetch, all resolving Ok.
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let store = store.clone();
            tokio::spawn(async move { store.install("kilo", None).await.map(|_| ()) })
        })
        .collect();
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => failures.push(format!("concurrent install: {e}")),
            Err(e) => failures.push(format!("concurrent join: {e}")),
        }
    }
    eprintln!("  ✓ 6 concurrent installs of one binary agent");

    // Purge + self-heal: uninstall with cache purge, reinstall, ensure_ready.
    store.uninstall("kilo", true).map_err(|e| failures.push(format!("purge: {e}"))).ok();
    if let Err(e) = store.install("kilo", None).await {
        failures.push(format!("reinstall after purge: {e}"));
    }
    if let Err(e) = store.ensure_ready("kilo").await {
        failures.push(format!("ensure_ready: {e}"));
    }
    eprintln!("  ✓ purge → reinstall → ensure_ready self-heal");
    failures
}

async fn deep_agent_tests(
    manager: &AgentManager,
    recorder: &Arc<Recorder>,
    plugin_id: &str,
    report: &mut AgentReport,
) {
    // ── spawn + session ────────────────────────────────────────────────────
    let t0 = Instant::now();
    let info = match manager.spawn(plugin_id).await {
        Ok(i) => {
            report.spawn = Some(Ok(format!("{:?}", t0.elapsed())));
            i
        }
        Err(e) => {
            report.spawn = Some(Err(e.to_string()));
            return;
        }
    };
    let cwd = tmp_project(plugin_id);
    let mut init = match manager.new_session(info.agent_id, cwd.clone()).await {
        Ok(i) => i,
        Err(e) => {
            // Some agents refuse session/new unauthenticated — run the ladder
            // and retry once, the exact flow the sign-in pill drives.
            if is_auth_error(&e.to_string()) && try_authenticate(manager, info.agent_id).await {
                match manager.new_session(info.agent_id, cwd.clone()).await {
                    Ok(i) => i,
                    Err(e) => {
                        report.turn_tool_call = Some(Err(format!("session/new: {e}")));
                        return;
                    }
                }
            } else {
                report.turn_tool_call = Some(Err(format!("session/new: {e}")));
                return;
            }
        }
    };
    report.modes = init.available_modes.len();
    let key = init.key.clone();
    if let Ok(snap) = manager.snapshot_meta(&key) {
        report.config_options = snap.config_options.len();
    }

    // ── basic tool call: the turn must WRITE a real file ───────────────────
    //
    // Agents default to guarded modes (codex: read-only; claude: Manual). A
    // user who wants files written flips the mode first — do the same, picking
    // the least-guarded WRITE-capable mode the agent advertises. Permission
    // prompts that still fire are auto-approved by `drive`.
    if let Some(write_mode) = init
        .available_modes
        .iter()
        .find(|m| {
            let id = m.id.to_lowercase();
            (id.contains("accept")
                || id.contains("auto")
                || id.contains("full")
                || id.contains("dontask")
                || id.contains("bypass")
                || id.contains("edit"))
                && !id.contains("plan")
                && Some(&m.id) != init.current_mode.as_ref()
        })
        .map(|m| m.id.clone())
    {
        let mut rx = manager.subscribe();
        if manager.set_mode(&init.key, write_mode.clone()).is_ok() {
            let _ = drive(manager, &mut rx, &init.key, Duration::from_secs(10), |d| match d {
                SessionDelta::ModeChanged { mode_id } if *mode_id == write_mode => Some(()),
                _ => None,
            })
            .await;
            eprintln!("    → write mode: {write_mode}");
        }
    }
    let probe = format!("probe-{}.txt", &key.session_id.chars().take(6).collect::<String>());
    let prompt = format!(
        "Create a file named {probe} in the current directory containing exactly the \
         line PROBE_OK, using your file tools. Then reply with only the word DONE."
    );
    let mut turn = run_turn(manager, &key, &prompt, TURN_TIMEOUT).await;
    if let Err(e) = &turn.stop {
        // Unauthenticated agents fail here instead of at session/new.
        if is_auth_error(e) && try_authenticate(manager, info.agent_id).await {
            if let Ok(fresh) = manager.new_session(info.agent_id, cwd.clone()).await {
                init = fresh;
                report.modes = init.available_modes.len();
                turn = run_turn(manager, &init.key, &prompt, TURN_TIMEOUT).await;
            }
        }
    }
    let key = init.key.clone();
    report.streaming_chunks = Some(turn.text_chunks);
    report.plan_seen |= turn.plan_seen;
    report.turn_tool_call = Some(match &turn.stop {
        Ok(stop) => {
            let file_ok = std::fs::read_to_string(cwd.join(&probe))
                .map(|c| c.contains("PROBE_OK"))
                .unwrap_or(false);
            if file_ok {
                Ok(format!("{stop}+file ({} tool deltas)", turn.tool_calls.len()))
            } else if turn.tool_calls.is_empty() {
                Err(format!("no tool calls (text: {})", turn.text.trim().chars().take(40).collect::<String>()))
            } else {
                let titles: Vec<String> = turn
                    .tool_calls
                    .iter()
                    .filter_map(|t| t.get("title").and_then(|v| v.as_str()).map(str::to_string))
                    .collect();
                Err(format!(
                    "{} tool deltas but file not written [{}]",
                    turn.tool_calls.len(),
                    titles.join("; ").chars().take(80).collect::<String>()
                ))
            }
        }
        Err(e) => Err(e.clone()),
    });

    // ── broadcast wire-order invariants on that turn ───────────────────────
    report.broadcast_order = Some(check_wire_order(&recorder.for_session(&key.session_id)));

    // ── mode switching (incl. plan mode when advertised) ───────────────────
    if init.available_modes.len() > 1 {
        let current = init.current_mode.clone();
        // Prefer a "plan" mode so the plan machinery gets exercised.
        let target = init
            .available_modes
            .iter()
            .find(|m| m.id.to_lowercase().contains("plan") && Some(&m.id) != current.as_ref())
            .or_else(|| init.available_modes.iter().find(|m| Some(&m.id) != current.as_ref()))
            .map(|m| m.id.clone())
            .unwrap();
        let mut mode_rx = manager.subscribe();
        let set = manager.set_mode(&key, target.clone());
        report.set_mode = Some(match set {
            Err(e) => Err(e.to_string()),
            Ok(()) => {
                let seen = drive(manager, &mut mode_rx, &key, STEP_TIMEOUT, |d| match d {
                    SessionDelta::ModeChanged { mode_id } if *mode_id == target => {
                        Some(mode_id.clone())
                    }
                    _ => None,
                })
                .await;
                match seen {
                    Ok(id) => {
                        // In plan mode, ask for a plan; PlanUpdated is a bonus,
                        // not a hard assertion (agents plan when they see fit).
                        if id.to_lowercase().contains("plan") {
                            let t = run_turn(
                                manager,
                                &key,
                                "Plan (do not execute) the steps to add a CONTRIBUTING.md to this project. Keep it to 3 steps.",
                                TURN_TIMEOUT,
                            )
                            .await;
                            report.plan_seen |= t.plan_seen;
                        }
                        // Restore the original mode.
                        if let Some(back) = current {
                            let _ = manager.set_mode(&key, back);
                        }
                        Ok(id)
                    }
                    Err(e) => Err(format!("no ModeChanged: {e}")),
                }
            }
        });
    }

    // ── model / config-option switching ────────────────────────────────────
    if let Ok(snap) = manager.snapshot_meta(&key) {
        report.config_options = report.config_options.max(snap.config_options.len());
        // Prefer the generic config-option write (ACP's real mechanism); fall
        // back to the models blob for legacy-dialect agents.
        let via_config = snap.config_options.iter().find_map(|o| {
            let id = o.get("id")?.as_str()?;
            let cur = o.get("currentValue")?.as_str()?;
            let other = o
                .get("options")?
                .as_array()?
                .iter()
                .find_map(|v| v.get("value")?.as_str().filter(|x| *x != cur).map(str::to_string))?;
            Some((id.to_string(), cur.to_string(), other))
        });
        if let Some((opt_id, cur, other)) = via_config {
            let mut cfg_rx = manager.subscribe();
            let r = manager.set_config_option(&key, opt_id.clone(), serde_json::Value::String(other.clone()));
            report.set_config = Some(match r {
                Err(e) => Err(e.to_string()),
                Ok(()) => {
                    let echoed = drive(manager, &mut cfg_rx, &key, STEP_TIMEOUT, |d| match d {
                        SessionDelta::ConfigOptionsUpdated { options } => Some(options.clone()),
                        SessionDelta::ModeChanged { mode_id } => Some(vec![serde_json::json!({"id": opt_id, "currentValue": mode_id})]),
                        SessionDelta::ModelChanged { model_id } => Some(vec![serde_json::json!({"id": opt_id, "currentValue": model_id})]),
                        _ => None,
                    })
                    .await;
                    // Flip back either way.
                    let _ = manager.set_config_option(&key, opt_id.clone(), serde_json::Value::String(cur));
                    match echoed {
                        Ok(_) => Ok(format!("{opt_id}→{other} echoed")),
                        Err(e) => Err(format!("{opt_id} set but no echo: {e}")),
                    }
                }
            });
        } else if let Some(model) = snap.available_models.iter().find(|m| Some(&m.id) != snap.current_model.as_ref()) {
            let r = manager.set_model(&key, model.id.clone());
            report.set_config = Some(match r {
                Err(e) => Err(e.to_string()),
                Ok(()) => Ok(format!("set_model {}", model.id.chars().take(18).collect::<String>())),
            });
            if let Some(back) = snap.current_model {
                let _ = manager.set_model(&key, back);
            }
        }
    }

    // ── cancel mid-turn, then a follow-up turn on the same session ─────────
    let cancel_result: Result<String, String> = async {
        let mut rx = manager.subscribe();
        manager
            .send(&key, "Count from 1 to 200, one number per line, no commentary.".into())
            .map_err(|e| e.to_string())?;
        // Wait for streaming to start, then cancel. One receiver end-to-end so
        // a terminal landing between the waits is buffered, not lost.
        drive(manager, &mut rx, &key, TURN_TIMEOUT, |d| match d {
            SessionDelta::TextChunk { .. } | SessionDelta::ToolCallUpserted { .. } => Some(()),
            SessionDelta::TurnFailed { .. } => Some(()), // fast-fail still exercises cancel
            _ => None,
        })
        .await?;
        manager.cancel(&key).map_err(|e| e.to_string())?;
        // A terminal must arrive (cancelled turn-finished, or failed).
        let stop = drive(manager, &mut rx, &key, STEP_TIMEOUT, |d| match d {
            SessionDelta::TurnFinished { stop_reason, .. } => Some(Ok(stop_reason.clone())),
            SessionDelta::TurnFailed { error, .. } => Some(Err(error.clone())),
            _ => None,
        })
        .await??;
        // Follow-up turn on the SAME session must work (no wedged state).
        let follow = run_turn(manager, &key, "Reply with only the word ALIVE.", TURN_TIMEOUT).await;
        match follow.stop {
            Ok(_) if follow.text.contains("ALIVE") => Ok(format!("cancel({stop})→ALIVE")),
            Ok(s) => Err(format!("follow-up stop={s} text={:?}", follow.text.trim().chars().take(30).collect::<String>())),
            Err(e) => Err(format!("follow-up: {e}")),
        }
    }
    .await;
    report.cancel_follow_up = Some(cancel_result);

    // ── resume: drop the session, session/load it back ─────────────────────
    let resume_result: Result<String, String> = async {
        let sid_typed: atlas_agents::SessionId =
            serde_json::from_value(serde_json::Value::String(key.session_id.clone()))
                .map_err(|e| e.to_string())?;
        manager.drop_session(&key).map_err(|e| e.to_string())?;
        let loaded = manager.load_session(info.agent_id, sid_typed, cwd.clone()).await;
        let rekey = match loaded {
            Ok(k) => k,
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                // Not advertising `loadSession` is a capability, not a defect
                // (Zed gates its resume affordance the same way).
                if msg.contains("unsupported")
                    || msg.contains("not support")
                    || msg.contains("method not found")
                    || msg.contains("-32601")
                {
                    return Ok("n/a (no session/load)".into());
                }
                return Err(format!("load: {e}"));
            }
        };
        let snap = manager.snapshot(&rekey).map_err(|e| e.to_string())?;
        if !snap.messages.is_empty() {
            return Ok(format!("{} msgs replayed", snap.messages.len()));
        }
        // ACP replay into a just-dropped session is SUPPRESSED by design (the
        // resume-replay-duplication fix) — the app repaints Claude-family
        // sessions from their own JSONL transcript instead. Certify that path.
        let msgs = manager
            .replay_transcript(plugin_id, cwd.to_str().unwrap_or("."), &key.session_id)
            .await
            .map_err(|e| format!("transcript replay: {e}"))?;
        if msgs.is_empty() {
            return Err("0 msgs from ACP replay AND transcript".into());
        }
        Ok(format!("{} msgs via transcript", msgs.len()))
    }
    .await;
    report.resume = Some(resume_result);

    let _ = manager.kill(info.agent_id);
}

/// Wire-order invariants the frontend depends on (and Zed enforces on its
/// side): a running status precedes content; an assistant `message_appended`
/// precedes its text chunks (the Aug-06 ordering bug class); exactly one
/// terminal per turn boundary.
fn check_wire_order(deltas: &[SessionDelta]) -> Result<String, String> {
    let mut saw_running_before_content = false;
    let mut running_seen = false;
    let mut appended_before_chunk = true;
    let mut assistant_appended = false;
    let mut terminals = 0usize;
    for d in deltas {
        match d {
            SessionDelta::Status { status, .. } => {
                if format!("{status:?}").to_lowercase().contains("running") {
                    running_seen = true;
                }
            }
            SessionDelta::MessageAppended { message } => {
                let v = serde_json::to_value(message).unwrap_or_default();
                if v.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                    assistant_appended = true;
                }
            }
            SessionDelta::TextChunk { .. } => {
                if !running_seen {
                    // content before any Running status
                } else {
                    saw_running_before_content = true;
                }
                if !assistant_appended {
                    appended_before_chunk = false;
                }
            }
            SessionDelta::TurnFinished { .. } | SessionDelta::TurnFailed { .. } => terminals += 1,
            _ => {}
        }
    }
    if !appended_before_chunk {
        return Err("text_chunk before assistant message_appended".into());
    }
    if terminals == 0 {
        return Err("no terminal delta on the stream".into());
    }
    Ok(format!(
        "{} deltas, {} terminals{}",
        deltas.len(),
        terminals,
        if saw_running_before_content { ", running→content" } else { "" }
    ))
}

/// Feed a real turn's delta stream into atlas-checkpoint the way
/// `CaptureMiddleware` does, then read the timeline back and assert the
/// transcription landed in sessions.db.
async fn phase_timeline(manager: &AgentManager, plugin_id: &str) -> Result<String, String> {
    eprintln!("━━ P3 timeline / sessions.db transcription ({plugin_id})");
    let ws = tmp_project("timeline-ws");
    let atlas_dir = ws.join(".atlas");
    std::fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;

    let info = manager.spawn(plugin_id).await.map_err(|e| e.to_string())?;
    let init = manager
        .new_session(info.agent_id, ws.clone())
        .await
        .map_err(|e| e.to_string())?;
    let key = init.key.clone();

    let mut store = Store::open(&atlas_dir).map_err(|e| e.to_string())?;
    let ckey = CaptureKey {
        workspace_id: "suite-ws".into(),
        source: Source::Acp,
        native_session_id: key.session_id.clone(),
    };

    // 1. Send path: record the raw prompt BEFORE the turn (capture.rs:18-25 —
    //    the prompt never arrives on the delta stream).
    let prompt = "Read any one file in this directory if present, then reply with a one-line \
                  summary of what you did.";
    {
        let mut cap = Capture::new(&mut store, WorkspaceMode::Local);
        cap.record_prompt(&ckey, prompt, 1, Some(plugin_id), None, ws.to_str())
            .map_err(|e| e.to_string())?;
    }

    // 2. Live turn; mirror the middleware's delta mapping.
    let turn = run_turn(manager, &key, prompt, TURN_TIMEOUT).await;
    let stop = turn.stop.clone().map_err(|e| format!("turn: {e}"))?;
    {
        let mut cap = Capture::new(&mut store, WorkspaceMode::Local);
        let session_row = cap
            .ensure_session(&ckey, Some(plugin_id), None, None, ws.to_str())
            .map_err(|e| e.to_string())?;
        cap.record_turn(
            &session_row,
            TurnContent {
                turn_seq: 1,
                native_message_id: turn.assistant_message_id.clone(),
                role: Role::Assistant,
                mode: Mode::Text,
                body: turn.text.clone(),
                created_at: None,
            },
        )
        .map_err(|e| e.to_string())?;
        for (i, t) in turn.tool_calls.iter().enumerate() {
            let title = t.get("title").and_then(|v| v.as_str());
            let kind = t.get("kind").and_then(|v| v.as_str());
            let call_id = t.get("id").and_then(|v| v.as_str());
            let locations = t.get("locations").cloned().unwrap_or(serde_json::Value::Null);
            let name = atlas_checkpoint::tools::canonical_name(
                t.get("tool_name").and_then(|v| v.as_str()),
                title,
                kind,
                &serde_json::Value::Null,
            );
            let fallback_id = format!("call-{i}");
            cap.record_tool_call(
                &session_row,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(call_id.unwrap_or(&fallback_id)),
                    tool_name: name,
                    title,
                    kind,
                    status: ToolStatus::Completed,
                    locations: &locations,
                    arguments: None,
                    result: None,
                },
            )
            .map_err(|e| e.to_string())?;
        }
        cap.finish_turn(&session_row, 1).map_err(|e| e.to_string())?;
    }
    let _ = manager.kill(info.agent_id);

    // 3. Read back through the SAME API the Timeline board uses.
    let reader = Store::open_reader(&atlas_dir).map_err(|e| e.to_string())?;
    let sessions = timeline::sessions(&reader, "suite-ws").map_err(|e| e.to_string())?;
    let session = sessions.first().ok_or("no session row in sessions.db")?;
    let detail = timeline::detail(&reader, &session.id, |_| None)
        .map_err(|e| e.to_string())?
        .ok_or("no session detail")?;
    let kinds: Vec<String> = detail.entries.iter().map(|e| format!("{:?}", e.kind)).collect();
    let has_prompt = kinds.iter().any(|k| k.to_lowercase().contains("prompt"));
    let has_response = kinds.iter().any(|k| k.to_lowercase().contains("response"));
    if !has_prompt || !has_response {
        return Err(format!("entries missing prompt/response: {kinds:?}"));
    }
    Ok(format!(
        "session '{}' · {} entries (prompt+response{}) · stop={stop}",
        session.title.as_deref().unwrap_or("?"),
        detail.entries.len(),
        if kinds.iter().any(|k| k.to_lowercase().contains("tool")) { "+tools" } else { "" },
    ))
}

/// 10 sessions across 10 tmp projects on 3 agents, all streaming concurrently.
/// Asserts completion AND isolation (each session's text carries only its own
/// token; each snapshot's cwd is its own project).
async fn phase_concurrency(manager: &AgentManager) -> Result<String, String> {
    eprintln!("━━ P4 10 projects × concurrent sessions (3 agents)");
    let agents = ["claude-acp", "opencode", "gemini"];
    let mut spawned = HashMap::new();
    for a in agents {
        spawned.insert(a, manager.spawn(a).await.map_err(|e| format!("spawn {a}: {e}"))?);
    }
    let mut tasks = Vec::new();
    for i in 0..10usize {
        let agent = agents[i % agents.len()];
        let info = spawned[agent].clone();
        let manager = manager.clone();
        tasks.push(tokio::spawn(async move {
            let cwd = tmp_project(&format!("proj-{i}"));
            let init = manager
                .new_session(info.agent_id, cwd.clone())
                .await
                .map_err(|e| format!("p{i} session: {e}"))?;
            let token = format!("SESSION_{i}_OK");
            let turn = run_turn(
                &manager,
                &init.key,
                &format!("Reply with only the exact text {token}"),
                TURN_TIMEOUT,
            )
            .await;
            turn.stop.map_err(|e| format!("p{i} ({agent}): {e}"))?;
            if !turn.text.contains(&token) {
                return Err(format!("p{i}: token missing (got {:?})", turn.text.trim().chars().take(30).collect::<String>()));
            }
            // Cross-session bleed check: no OTHER project's token.
            for j in 0..10usize {
                if j != i && turn.text.contains(&format!("SESSION_{j}_OK")) {
                    return Err(format!("p{i}: bled p{j}'s token"));
                }
            }
            let snap = manager.snapshot_meta(&init.key).map_err(|e| e.to_string())?;
            if !snap.cwd.contains(&format!("proj-{i}")) {
                return Err(format!("p{i}: wrong cwd {}", snap.cwd));
            }
            Ok::<String, String>(format!("p{i}:{agent}"))
        }));
    }
    let mut ok = 0;
    let mut errs = Vec::new();
    for t in tasks {
        match t.await {
            Ok(Ok(_)) => ok += 1,
            Ok(Err(e)) => errs.push(e),
            Err(e) => errs.push(format!("join: {e}")),
        }
    }
    for info in spawned.values() {
        let _ = manager.kill(info.agent_id);
    }
    if errs.is_empty() {
        Ok(format!("10/10 sessions completed, isolated"))
    } else {
        Err(format!("{ok}/10 ok; {}", errs.join(" | ")))
    }
}

// ── Entry ───────────────────────────────────────────────────────────────────

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let only_agents: Option<Vec<String>> = std::env::var("AGENTS")
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect());
    let phases: Vec<String> = std::env::var("PHASES")
        .unwrap_or_else(|_| "stress,matrix,timeline,concurrency".into())
        .split(',')
        .map(|p| p.trim().to_string())
        .collect();

    let data_dir = std::env::temp_dir().join(format!("atlas-suite-data-{}", std::process::id()));
    let store = Arc::new(RegistryStore::new(data_dir.clone()));
    eprintln!("📁 {}", data_dir.display());
    store.refresh(true).await.expect("registry refresh");

    // BYOK env → every installed agent, as the host does at boot.
    let mut env = HashMap::new();
    for (var, src) in [
        ("OPENAI_API_KEY", "OPENAI_API_KEY"),
        ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        ("GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"),
        ("GOOGLE_API_KEY", "GOOGLE_API_KEY"),
    ] {
        if let Ok(v) = std::env::var(src) {
            env.insert(var.to_string(), v);
        }
    }
    store.set_agent_env(env);

    let mut stress_failures = Vec::new();
    if phases.iter().any(|p| p == "stress") {
        stress_failures = phase_registry_stress(&store).await;
    } else {
        for id in AGENTS {
            let _ = store.install(id, None).await;
        }
    }

    let recorder = Arc::new(Recorder::default());
    let manager = AgentManager::with_spec_source(
        recorder.clone(),
        data_dir.join("agent-config"),
        Some(store.clone() as Arc<dyn atlas_acp::SpecSource>),
    );

    let mut reports: Vec<(String, AgentReport)> = Vec::new();
    if phases.iter().any(|p| p == "matrix") {
        for id in AGENTS {
            if let Some(only) = &only_agents {
                if !only.iter().any(|o| o == id) {
                    continue;
                }
            }
            eprintln!("━━ P1/P2 {id}");
            let mut report = AgentReport::default();
            report.install = Some(Ok("installed".into()));
            if DEEP.contains(id) {
                deep_agent_tests(&manager, &recorder, id, &mut report).await;
            } else {
                // Shallow: spawn + initialize + advertisement only.
                let t0 = Instant::now();
                match manager.spawn(id).await {
                    Ok(info) => {
                        report.spawn = Some(Ok(format!("{:?}", t0.elapsed())));
                        if let Ok(init) = manager.new_session(info.agent_id, tmp_project(id)).await {
                            report.modes = init.available_modes.len();
                            let _ = manager.drop_session(&init.key);
                        }
                        let _ = manager.kill(info.agent_id);
                    }
                    Err(e) => report.spawn = Some(Err(e.to_string())),
                }
            }
            reports.push((id.to_string(), report));
        }
    }

    let timeline_result = if phases.iter().any(|p| p == "timeline") {
        Some(phase_timeline(&manager, "claude-acp").await)
    } else {
        None
    };
    let concurrency_result = if phases.iter().any(|p| p == "concurrency") {
        Some(phase_concurrency(&manager).await)
    } else {
        None
    };

    manager.shutdown();

    // ── Report ─────────────────────────────────────────────────────────────
    eprintln!("\n═══════════ BACKEND CERTIFICATION ═══════════");
    if !stress_failures.is_empty() {
        eprintln!("P0 registry stress FAILURES:");
        for f in &stress_failures {
            eprintln!("  ✗ {f}");
        }
    } else if phases.iter().any(|p| p == "stress") {
        eprintln!("P0 registry stress: ok (10 installs, 10× churn, 6-way concurrent, purge-heal)");
    }
    eprintln!(
        "\n{:<20} {:<12} {:>5} {:>4} | {:<30} {:>6} {:<22} {:<26} {:<30} {:<24} {}",
        "agent", "spawn", "modes", "cfg", "tool-call turn", "chunks", "set_mode", "set_config/model", "cancel→follow-up", "resume(load)", "wire-order"
    );
    for (id, r) in &reports {
        eprintln!(
            "{:<20} {:<12} {:>5} {:>4} | {:<30} {:>6} {:<22} {:<26} {:<30} {:<24} {}",
            id,
            mark(&r.spawn),
            r.modes,
            r.config_options,
            mark(&r.turn_tool_call),
            r.streaming_chunks.map(|c| c.to_string()).unwrap_or_else(|| "—".into()),
            mark(&r.set_mode),
            mark(&r.set_config),
            mark(&r.cancel_follow_up),
            mark(&r.resume),
            mark(&r.broadcast_order),
        );
    }
    let plans: Vec<&str> = reports
        .iter()
        .filter(|(_, r)| r.plan_seen)
        .map(|(id, _)| id.as_str())
        .collect();
    eprintln!("\nplan updates observed from: {}", if plans.is_empty() { "none".into() } else { plans.join(", ") });
    if let Some(t) = timeline_result {
        match t {
            Ok(s) => eprintln!("P3 timeline/sessions.db: ok — {s}"),
            Err(e) => eprintln!("P3 timeline/sessions.db: FAIL — {e}"),
        }
    }
    if let Some(c) = concurrency_result {
        match c {
            Ok(s) => eprintln!("P4 concurrency: ok — {s}"),
            Err(e) => eprintln!("P4 concurrency: FAIL — {e}"),
        }
    }
}
