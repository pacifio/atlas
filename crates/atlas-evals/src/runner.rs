//! The sweep runner. Drives the native agent in-process — the exact code
//! path the app ships — one isolated workspace and one scratch config dir
//! per run, bypass-mode permissions inside the normal sandbox tier.
//!
//! Budget rules (roadmap decision 2): a hard per-run ceiling (timeout +
//! cost, enforced by a watchdog that calls `cancel_turn`) and a sweep-level
//! dollar cap that stops scheduling new runs rather than pretending to
//! know the right number.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atlas_acp::{AcpEvent, AgentId, EventSink, SessionId};
use atlas_cersei::CerseiRuntime;

use crate::capture::HarnessCapture;
use crate::results::{self, RunRecord};
use crate::task::Task;
use crate::verify::run_verify;
use crate::workspace;

/// Everything one sweep needs.
pub struct SweepConfig {
    pub sweep_id: String,
    pub tasks: Vec<Task>,
    pub models: Vec<String>,
    pub runs_per_task: u32,
    /// BYOK keys, provider id → key.
    pub keys: BTreeMap<String, String>,
    pub repo_root: PathBuf,
    pub out_dir: PathBuf,
    pub scratch: PathBuf,
    pub max_cost_per_run: f64,
    pub max_cost_sweep: f64,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct SweepSummary {
    pub runs: u64,
    pub passed: u64,
    pub ghosts: u64,
    pub errors: u64,
    pub total_cost: f64,
    /// Set when the sweep-level dollar cap stopped scheduling.
    pub stopped_early: Option<String>,
}

/// Collects the sink-side signals of a run: cumulative usage/cost and any
/// permission request (which bypass mode should make impossible — one
/// arriving anyway means the run would hang, so the watchdog cancels).
#[derive(Default)]
pub struct CollectingSink {
    usage: Mutex<(u64, u64, f64)>,
    permission_requests: AtomicU64,
}

impl CollectingSink {
    pub fn cost(&self) -> f64 {
        self.usage.lock().expect("sink lock").2
    }

    pub fn tokens(&self) -> (u64, u64) {
        let g = self.usage.lock().expect("sink lock");
        (g.0, g.1)
    }

    pub fn permission_requests(&self) -> u64 {
        self.permission_requests.load(Ordering::Relaxed)
    }
}

impl EventSink for CollectingSink {
    fn emit(&self, _agent_id: AgentId, event: AcpEvent, _turn: Option<u64>) {
        match event {
            AcpEvent::Usage { input_tokens, output_tokens, cost, .. } => {
                *self.usage.lock().expect("sink lock") = (input_tokens, output_tokens, cost);
            }
            AcpEvent::PermissionRequest { .. } => {
                self.permission_requests.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

/// Provider id for a `"provider/model"` string (the runner requires the
/// explicit form — a bare model id would silently fall back to whatever
/// provider the scratch key file makes the default).
pub fn provider_of(model: &str) -> Option<&str> {
    model.split_once('/').map(|(p, _)| p)
}

/// Check every requested model has a key before any run starts.
pub fn check_model_keys(models: &[String], keys: &BTreeMap<String, String>) -> Result<(), String> {
    for model in models {
        let provider = provider_of(model)
            .ok_or_else(|| format!("model '{model}' must be provider-qualified (provider/model)"))?;
        if !keys.contains_key(provider) {
            return Err(format!("no API key for provider '{provider}' (model '{model}')"));
        }
    }
    Ok(())
}

/// Write the scratch config dir's `byok-keys.json` in the shape
/// `atlas-cersei/src/store.rs::byok_get` reads.
pub fn write_byok_keys(config_dir: &Path, keys: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("create config dir: {e}"))?;
    let doc: BTreeMap<&str, serde_json::Value> = keys
        .iter()
        .map(|(provider, key)| (provider.as_str(), serde_json::json!({ "key": key })))
        .collect();
    let path = config_dir.join("byok-keys.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// Run the whole sweep sequentially (runs share one process so the global
/// tracing capture attributes turns unambiguously).
pub async fn run_sweep(cfg: &SweepConfig, capture: &HarnessCapture) -> Result<SweepSummary, String> {
    check_model_keys(&cfg.models, &cfg.keys)?;
    let results_path = cfg.out_dir.join(&cfg.sweep_id).join("results.jsonl");
    let mut summary = SweepSummary::default();

    'sweep: for task in &cfg.tasks {
        for model in &cfg.models {
            for run_idx in 0..cfg.runs_per_task {
                if summary.total_cost > cfg.max_cost_sweep {
                    summary.stopped_early = Some(format!(
                        "sweep cost {:.2} exceeded cap {:.2}",
                        summary.total_cost, cfg.max_cost_sweep
                    ));
                    break 'sweep;
                }
                let record = run_one(cfg, capture, task, model, run_idx).await;
                summary.runs += 1;
                summary.passed += u64::from(record.pass);
                summary.ghosts += u64::from(record.ghost);
                summary.errors += u64::from(record.error.is_some());
                summary.total_cost += record.cost;
                results::append(&results_path, &record)?;
                eprintln!(
                    "[{}] {} {} run {} → {} ({}ms, ${:.3})",
                    cfg.sweep_id,
                    task.id,
                    model,
                    run_idx,
                    if record.pass { "pass" } else if record.ghost { "GHOST" } else { "fail" },
                    record.wall_clock_ms,
                    record.cost,
                );
            }
        }
    }
    Ok(summary)
}

/// One (task, model, run). Infrastructure failures come back as a record
/// with `error` set — the sweep keeps going.
async fn run_one(
    cfg: &SweepConfig,
    capture: &HarnessCapture,
    task: &Task,
    model: &str,
    run_idx: u32,
) -> RunRecord {
    let started_at = chrono::Utc::now().to_rfc3339();
    let started = Instant::now();
    let slug = format!("{}--{}--{}", task.id, model.replace('/', "_"), run_idx);

    let mut record = RunRecord {
        sweep: cfg.sweep_id.clone(),
        task_id: task.id.clone(),
        bucket: task.bucket,
        model: model.to_string(),
        run_idx,
        started_at,
        wall_clock_ms: 0,
        stop: None,
        error: None,
        pass: false,
        ghost: false,
        verify_exit: None,
        verify_detail: String::new(),
        turns: Vec::new(),
        tokens_in: 0,
        tokens_out: 0,
        cost: 0.0,
    };

    // Clear stale captures from a previous run before this one starts.
    let _ = capture.drain();

    let ws = match workspace::prepare(task, &cfg.repo_root, &cfg.scratch.join("workspaces"), &slug) {
        Ok(ws) => ws,
        Err(e) => {
            record.error = Some(format!("workspace: {e}"));
            record.wall_clock_ms = started.elapsed().as_millis() as u64;
            return record;
        }
    };

    let outcome = drive_agent(cfg, task, model, &slug, ws.root.clone()).await;
    record.turns = capture.drain();
    match outcome {
        Ok(driven) => {
            record.stop = Some(driven.stop);
            record.tokens_in = driven.tokens_in;
            record.tokens_out = driven.tokens_out;
            record.cost = driven.cost;
            if let Some(reason) = driven.cancelled_because {
                record.error = Some(reason);
            }
        }
        Err(e) => record.error = Some(e),
    }

    // Verify even after cancellation — a partially-done task is still fail,
    // and the verifier's output is diagnostic either way.
    let verdict = run_verify(task, &ws.root);
    record.pass = verdict.pass;
    record.verify_exit = verdict.exit_code;
    record.verify_detail = verdict.detail;
    record.ghost =
        RunRecord::classify_ghost(record.pass, record.stop.as_deref(), record.error.as_deref());

    if let Err(e) = workspace::cleanup(&ws) {
        eprintln!("warn: cleanup {slug}: {e}");
    }
    record.wall_clock_ms = started.elapsed().as_millis() as u64;
    record
}

struct Driven {
    stop: String,
    tokens_in: u64,
    tokens_out: u64,
    cost: f64,
    cancelled_because: Option<String>,
}

async fn drive_agent(
    cfg: &SweepConfig,
    task: &Task,
    model: &str,
    slug: &str,
    ws_root: PathBuf,
) -> Result<Driven, String> {
    let config_dir = cfg.scratch.join("config").join(slug);
    write_byok_keys(&config_dir, &cfg.keys)?;

    let runtime = CerseiRuntime::new(config_dir);
    let sink = Arc::new(CollectingSink::default());
    let info = runtime.spawn(sink.clone());
    let agent_id = info.agent_id;

    let session = runtime
        .new_session(agent_id, ws_root)
        .map_err(|e| format!("new_session: {e}"))?;
    let sid: String = session.session_id.to_string();
    runtime
        .set_model(agent_id, &sid, model.to_string())
        .map_err(|e| format!("set_model: {e}"))?;
    runtime
        .set_session_mode(agent_id, &sid, "bypass".into())
        .map_err(|e| format!("set_session_mode: {e}"))?;
    runtime
        .set_max_turns(agent_id, &sid, task.max_turns)
        .map_err(|e| format!("set_max_turns: {e}"))?;

    let prompt = task.prompt.clone();
    let rt2 = runtime.clone();
    let session_id = SessionId::new(sid.clone());
    let handle = tokio::spawn(async move { rt2.send_prompt(agent_id, session_id, prompt).await });

    let deadline = Instant::now() + Duration::from_secs(task.timeout_secs);
    let mut cancelled_because = None;
    while !handle.is_finished() {
        if Instant::now() > deadline {
            cancelled_because = Some(format!("timeout after {}s", task.timeout_secs));
        } else if sink.cost() > cfg.max_cost_per_run {
            cancelled_because =
                Some(format!("cost {:.2} exceeded per-run cap {:.2}", sink.cost(), cfg.max_cost_per_run));
        } else if sink.permission_requests() > 0 {
            // Bypass mode should never ask; an ask with no UI attached would
            // hang the run forever.
            cancelled_because = Some("unexpected permission request in bypass mode".into());
        }
        if cancelled_because.is_some() {
            let _ = runtime.cancel_turn(agent_id, &sid);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let sent = handle.await.map_err(|e| format!("runner task panicked: {e}"))?;
    let (tokens_in, tokens_out) = sink.tokens();
    let cost = sink.cost();
    match sent {
        Ok(stop) => Ok(Driven { stop, tokens_in, tokens_out, cost, cancelled_because }),
        // A cancelled turn surfaces as an error from send_prompt when the
        // provider call was mid-flight; keep the watchdog's reason.
        Err(e) => match cancelled_because {
            Some(reason) => Ok(Driven {
                stop: "cancelled".into(),
                tokens_in,
                tokens_out,
                cost,
                cancelled_because: Some(reason),
            }),
            None => Err(format!("send_prompt: {e}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_must_be_provider_qualified_and_keyed() {
        let mut keys = BTreeMap::new();
        keys.insert("anthropic".to_string(), "sk-x".to_string());
        assert!(check_model_keys(&["anthropic/claude-sonnet-4-5".into()], &keys).is_ok());
        let err = check_model_keys(&["claude-sonnet-4-5".into()], &keys).unwrap_err();
        assert!(err.contains("provider-qualified"), "{err}");
        let err = check_model_keys(&["google/gemini-2.5-flash".into()], &keys).unwrap_err();
        assert!(err.contains("no API key"), "{err}");
    }

    #[test]
    fn byok_keys_file_matches_the_store_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let mut keys = BTreeMap::new();
        keys.insert("anthropic".to_string(), "sk-test".to_string());
        write_byok_keys(tmp.path(), &keys).unwrap();
        let raw = std::fs::read_to_string(tmp.path().join("byok-keys.json")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["anthropic"]["key"], "sk-test");
    }

    #[test]
    fn the_sink_keeps_the_latest_cumulative_usage_and_counts_asks() {
        let sink = CollectingSink::default();
        let agent = AgentId::new();
        let sid = SessionId::new("s1".to_string());
        sink.emit(
            agent,
            AcpEvent::Usage { session_id: sid.clone(), input_tokens: 10, output_tokens: 2, cost: 0.01 },
            None,
        );
        sink.emit(
            agent,
            AcpEvent::Usage { session_id: sid, input_tokens: 30, output_tokens: 9, cost: 0.05 },
            None,
        );
        assert_eq!(sink.tokens(), (30, 9));
        assert_eq!(sink.cost(), 0.05);
        assert_eq!(sink.permission_requests(), 0);
    }
}
