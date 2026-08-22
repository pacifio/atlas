//! Per-agent checkpoint pipeline probe.
//!
//! Users report Checkpoints appearing for Claude Code but not for Codex or
//! OpenCode. This probe answers *why*, per agent, with live turns:
//!
//! 1. real registry install → spawn → session in a fresh git repo;
//! 2. one prompt that makes the agent create a file;
//! 3. the middleware's exact gate chain mirrored over the delta stream —
//!    `canonical_name` → `writes_files()` → `extract_paths` → the
//!    first-sighting `existed_before` rule → hash+sketch at the terminal
//!    sighting (`commands/capture.rs::sample_writes` + `CompletedWrite`);
//! 4. a real commit, `walk_new_commits`, and a Checkpoint count.
//!
//! Every stage prints what it saw, so "no Checkpoint" decomposes into WHICH
//! gate dropped the write: no tool-call delta at all, a tool that never
//! classifies as write-shaped (an agent that edits via shell), or a call with
//! no extractable path (empty `locations`, unrecognised argument key).
//!
//! ```bash
//! OPENAI_API_KEY=… GOOGLE_API_KEY=… \
//!   cargo run --manifest-path crates/atlas-agents/Cargo.toml --example checkpoint_probe
//! AGENTS="codex-acp" …   # scope it
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use atlas_agents::{
    AgentManager, DeltaSink, PermissionDecision, SessionDelta, SessionDeltaEnvelope, SessionKey,
};
use atlas_checkpoint::capture::{Capture, FileWrite, SessionKey as CaptureKey, ToolCallContent};
use atlas_checkpoint::model::{Source, ToolStatus, WorkspaceMode};
use atlas_checkpoint::tools::{extract_paths, resolve_path};
use atlas_checkpoint::{walk_new_commits, Store};
use atlas_registry::RegistryStore;

const DEFAULT_AGENTS: &[&str] = &["claude-acp", "codex-acp", "opencode", "gemini"];
const TURN_TIMEOUT: Duration = Duration::from_secs(240);

// ── Sink ────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Recorder;
impl DeltaSink for Recorder {
    fn emit(&self, _envelope: SessionDeltaEnvelope) {}
}

// ── Git helpers ─────────────────────────────────────────────────────────────

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("git {args:?}: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn fresh_repo(tag: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("atlas-ckpt-probe-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    git(&dir, &["init", "--initial-branch=main"])?;
    git(&dir, &["config", "user.name", "Probe"])?;
    git(&dir, &["config", "user.email", "probe@example.com"])?;
    std::fs::write(dir.join("README.md"), "seed\n").map_err(|e| e.to_string())?;
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-m", "seed"])?;
    Ok(dir)
}

/// Mirrors `commands/capture.rs::workspace_id_for` — the canonical identity
/// both the recording and walking sides now share.
fn workspace_id_for(root: &Path) -> String {
    std::fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string()
}

// ── Middleware mirror: the write-sampling gate chain ────────────────────────

#[derive(Clone)]
struct SampledWrite {
    rel: String,
    existed_before: bool,
}

/// Per-call sampling state, mirroring `CaptureState::sample_writes` exactly:
/// the sampling event is cached per call id; `existed_before` comes from the
/// filesystem only on a pre-write first sighting, and from git's index on any
/// later (post-write) sighting.
#[derive(Default)]
struct WriteSampler {
    per_call: HashMap<String, Vec<SampledWrite>>,
}

impl WriteSampler {
    fn sample(
        &mut self,
        call_id: &str,
        ws: &Path,
        locations: &[serde_json::Value],
        arguments: &serde_json::Value,
        terminal: bool,
    ) {
        let first_sighting = !self.per_call.contains_key(call_id);
        let writes = self.per_call.entry(call_id.to_string()).or_default();
        for raw in extract_paths(locations, arguments) {
            let mut path = resolve_path(&raw, ws);
            // Mirror of the middleware's canonical-root retry (Fix B).
            if path.out_of_repo {
                if let Ok(real_root) = std::fs::canonicalize(ws) {
                    if real_root != ws {
                        let retry = resolve_path(&raw, &real_root);
                        if !retry.out_of_repo {
                            path = retry;
                        }
                    }
                }
            }
            if writes.iter().any(|w| w.rel == path.path) {
                continue;
            }
            let existed_before = if first_sighting && !terminal {
                ws.join(&path.path).exists()
            } else {
                atlas_checkpoint::git::tracked_in_head(ws, &path.path)
            };
            writes.push(SampledWrite { rel: path.path, existed_before });
        }
    }
}

// ── One tool-call sighting, as diagnosed ────────────────────────────────────

struct CallDiag {
    id: String,
    raw_name: String,
    kind: Option<String>,
    title: Option<String>,
    canonical: String,
    writes_files: bool,
    locations_n: usize,
    arg_keys: Vec<String>,
    extracted: Vec<String>,
}

// ── Per-agent probe ─────────────────────────────────────────────────────────

struct ProbeOutcome {
    tool_sightings: usize,
    diags: Vec<CallDiag>,
    touches: Vec<SampledWrite>,
    file_on_disk: bool,
    checkpoints: usize,
    stop: String,
}

async fn drive<T>(
    manager: &AgentManager,
    rx: &mut tokio::sync::broadcast::Receiver<SessionDeltaEnvelope>,
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
        if let SessionDelta::PermissionRequest { request_id, options, .. } = &env.delta {
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
            let _ =
                manager.respond_permission(key.agent_id, &key.session_id, *request_id, decision);
        }
        if let Some(v) = until(&env.delta) {
            return Ok(v);
        }
    }
}

async fn try_authenticate(manager: &AgentManager, agent_id: atlas_agents::AgentId) -> bool {
    let Ok(methods) = manager.auth_methods(agent_id) else { return false };
    for m in methods {
        if m.terminal_command.is_some() {
            continue;
        }
        if manager.authenticate(agent_id, m.id.clone()).await.is_ok() {
            return true;
        }
    }
    false
}

async fn probe_agent(manager: &AgentManager, plugin_id: &str) -> Result<ProbeOutcome, String> {
    let ws = fresh_repo(plugin_id)?;
    let atlas_dir = ws.join(".atlas");
    std::fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;
    let workspace_id = workspace_id_for(&ws);

    let info = manager.spawn(plugin_id).await.map_err(|e| format!("spawn: {e}"))?;
    let mut rx = manager.subscribe();
    let init = match manager.new_session(info.agent_id, ws.clone()).await {
        Ok(init) => init,
        Err(e) => {
            // The universal auth ladder, then one retry — same as the app.
            if try_authenticate(manager, info.agent_id).await {
                manager
                    .new_session(info.agent_id, ws.clone())
                    .await
                    .map_err(|e2| format!("session after auth: {e2}"))?
            } else {
                let _ = manager.kill(info.agent_id);
                return Err(format!("session: {e}"));
            }
        }
    };
    let key = init.key.clone();

    let mut store = Store::open(&atlas_dir).map_err(|e| e.to_string())?;
    // Seed the commit cursor the way enabling capture does.
    walk_new_commits(&store, &workspace_id, &ws, WorkspaceMode::Local).map_err(|e| e.to_string())?;

    let ckey = CaptureKey {
        workspace_id: workspace_id.clone(),
        source: Source::Acp,
        native_session_id: key.session_id.clone(),
    };
    let prompt = "Create a new file named greeting.txt in the current directory containing \
                  exactly one line of text: hello from the agent. Then stop.";
    {
        let mut cap = Capture::new(&mut store, WorkspaceMode::Local);
        cap.record_prompt(&ckey, prompt, 1, Some(plugin_id), None, ws.to_str())
            .map_err(|e| e.to_string())?;
    }

    // Live turn, sampling writes through the mirrored gate chain.
    let sampler = StdMutex::new(WriteSampler::default());
    let diags: StdMutex<Vec<CallDiag>> = StdMutex::new(Vec::new());
    let sightings = StdMutex::new(0usize);
    if let Err(e) = manager.send(&key, prompt.to_string()) {
        let _ = manager.kill(info.agent_id);
        return Err(format!("send: {e}"));
    }
    let stop = drive(manager, &mut rx, &key, TURN_TIMEOUT, |d| match d {
        // Includes calls announced only inside a permission request: the
        // apply layer registers those as ordinary tool calls now (gemini's
        // confirm path), so they arrive here like any other.
        SessionDelta::ToolCallUpserted { tool_call, .. } => {
            *sightings.lock().unwrap() += 1;
            let v = serde_json::to_value(tool_call).unwrap_or_default();
            let raw_name = v.get("tool_name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let kind = v.get("kind").and_then(|x| x.as_str()).map(str::to_string);
            let title = v.get("title").and_then(|x| x.as_str()).map(str::to_string);
            let call_id = v.get("id").and_then(|x| x.as_str()).unwrap_or("?").to_string();
            let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("");
            let terminal = matches!(status, "completed" | "failed");
            let locations = v
                .get("locations")
                .and_then(|l| l.as_array().cloned())
                .unwrap_or_default();
            let arguments = v.get("arguments").cloned().unwrap_or(serde_json::Value::Null);

            let canonical = atlas_checkpoint::canonical_name(
                Some(&raw_name),
                title.as_deref(),
                kind.as_deref(),
                &arguments,
            );
            let extracted = extract_paths(&locations, &arguments);
            if canonical.writes_files() {
                sampler.lock().unwrap().sample(&call_id, &ws, &locations, &arguments, terminal);
            }
            diags.lock().unwrap().push(CallDiag {
                id: call_id,
                raw_name,
                kind,
                title,
                canonical: format!("{canonical:?}"),
                writes_files: canonical.writes_files(),
                locations_n: locations.len(),
                arg_keys: arguments
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default(),
                extracted,
            });
            None
        }
        SessionDelta::TurnFinished { stop_reason, .. } => Some(Ok(stop_reason.clone())),
        SessionDelta::TurnFailed { error, .. } => Some(Err(error.clone())),
        SessionDelta::AgentDisconnected { reason } => Some(Err(format!("disconnected: {reason}"))),
        _ => None,
    })
    .await
    .and_then(|inner| inner)
    .unwrap_or_else(|e| format!("(turn error: {e})"));

    let _ = manager.kill(info.agent_id);

    // Terminal recording: hash + sketch from disk, exactly like CompletedWrite.
    let mut touches: Vec<SampledWrite> = Vec::new();
    {
        let mut cap = Capture::new(&mut store, WorkspaceMode::Local);
        let session_row = cap
            .ensure_session(&ckey, Some(plugin_id), None, None, ws.to_str())
            .map_err(|e| e.to_string())?;
        let per_call = std::mem::take(&mut sampler.lock().unwrap().per_call);
        for (call_id, writes) in per_call {
            if writes.is_empty() {
                continue;
            }
            let recorded_id = cap
                .record_tool_call(
                    &session_row,
                    ToolCallContent {
                        turn_seq: 1,
                        native_call_id: Some(&call_id),
                        tool_name: atlas_checkpoint::tools::ToolName::Write,
                        title: None,
                        kind: Some("edit"),
                        status: ToolStatus::Completed,
                        locations: &serde_json::json!([]),
                        arguments: None,
                        result: None,
                    },
                )
                .map_err(|e| e.to_string())?;
            for w in writes {
                let absolute = ws.join(&w.rel);
                let (sha, sketch, deleted) = match std::fs::read(&absolute) {
                    Ok(bytes) => (
                        Some(atlas_checkpoint::hash_written_content(&bytes)),
                        atlas_checkpoint::sketch::sketch(&bytes),
                        false,
                    ),
                    Err(_) => (None, None, true),
                };
                let resolved = resolve_path(&w.rel, &ws);
                cap.record_file_write(
                    &session_row,
                    &recorded_id,
                    1,
                    FileWrite {
                        path: &resolved,
                        sha256_after: sha,
                        sketch_after: sketch,
                        existed_before: w.existed_before,
                        deleted,
                    },
                )
                .map_err(|e| e.to_string())?;
                touches.push(w);
            }
        }
        cap.finish_turn(&session_row, 1).map_err(|e| e.to_string())?;
    }

    // The user commits whatever the agent produced.
    let file_on_disk = ws.join("greeting.txt").exists();
    git(&ws, &["add", "-A"])?;
    let dirty = !git(&ws, &["status", "--porcelain"])?.trim().is_empty();
    if dirty {
        git(&ws, &["commit", "-m", "commit agent work"])?;
    }
    walk_new_commits(&store, &workspace_id, &ws, WorkspaceMode::Local).map_err(|e| e.to_string())?;

    let reader = Store::open_reader(&atlas_dir).map_err(|e| e.to_string())?;
    let sessions = atlas_checkpoint::session_summaries(&reader, &workspace_id)
        .map_err(|e| e.to_string())?;
    let checkpoints = match sessions.first() {
        Some(s) => reader.checkpoints_for_session(&s.id).map_err(|e| e.to_string())?.len(),
        None => 0,
    };

    let tool_sightings = *sightings.lock().unwrap();
    Ok(ProbeOutcome {
        tool_sightings,
        diags: diags.into_inner().unwrap(),
        touches,
        file_on_disk,
        checkpoints,
        stop,
    })
}

// ── Entry ───────────────────────────────────────────────────────────────────

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let agents: Vec<String> = std::env::var("AGENTS")
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect())
        .unwrap_or_else(|_| DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect());

    let data_dir = std::env::temp_dir().join(format!("atlas-ckpt-probe-data-{}", std::process::id()));
    let store = Arc::new(RegistryStore::new(data_dir.clone()));
    store.refresh(true).await.expect("registry refresh");

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

    for id in &agents {
        if let Err(e) = store.install(id, None).await {
            eprintln!("⚠️  install {id}: {e}");
        }
    }

    let manager = AgentManager::with_spec_source(
        Arc::new(Recorder),
        data_dir.join("agent-config"),
        Some(store.clone() as Arc<dyn atlas_acp::SpecSource>),
    );

    let mut rows = Vec::new();
    for id in &agents {
        eprintln!("\n━━━ probing {id}");
        match probe_agent(&manager, id).await {
            Ok(o) => {
                eprintln!(
                    "    stop={} · sightings={} · file_on_disk={}",
                    o.stop, o.tool_sightings, o.file_on_disk
                );
                for d in &o.diags {
                    eprintln!(
                        "    call {} raw={:?} title={:?} kind={:?} → {} writes_files={} locs={} args={:?} extracted={:?}",
                        d.id, d.raw_name, d.title, d.kind, d.canonical, d.writes_files,
                        d.locations_n, d.arg_keys, d.extracted
                    );
                }
                let verdict = if o.checkpoints > 0 {
                    "CHECKPOINT ✅"
                } else if !o.file_on_disk {
                    "no file written (agent behaviour) ⚠️"
                } else if o.touches.is_empty() {
                    "file written but NO TOUCH RECORDED ❌ (gate chain dropped it)"
                } else {
                    "touch recorded but NO CHECKPOINT ❌ (link rule dropped it)"
                };
                eprintln!(
                    "    touches={:?} checkpoints={} → {verdict}",
                    o.touches.iter().map(|t| (&t.rel, t.existed_before)).collect::<Vec<_>>(),
                    o.checkpoints
                );
                rows.push((id.clone(), verdict.to_string()));
            }
            Err(e) => {
                eprintln!("    ERROR: {e}");
                rows.push((id.clone(), format!("error: {e}")));
            }
        }
    }

    eprintln!("\n══ verdicts ══");
    for (id, v) in &rows {
        eprintln!("  {id:<22} {v}");
    }
}
