//! End-to-end harness for the ACP-registry port.
//!
//! Drives the REAL production path for each agent, in order:
//!
//!   1. `RegistryStore::refresh` — fetch the official ACP registry manifest.
//!   2. `RegistryStore::install` — download+verify a binary distribution, or
//!      record an npx/uvx one.
//!   3. `SpecSource::extra_specs` — synthesise the spawn command with Zed's env
//!      layering (manifest env < BYOK keys < per-install overrides).
//!   4. `AgentRegistry::spawn` — spawn the process and complete `initialize`.
//!   5. `new_session` + `send_prompt` — run one real turn and collect the text.
//!
//! Nothing here special-cases an agent: the ids are just arguments. An agent
//! that needs credentials reports its advertised auth methods instead of a
//! turn, which is the same information the sign-in modal renders.
//!
//! ```bash
//! # every id in the default set
//! cargo run --manifest-path crates/atlas-registry/Cargo.toml --example registry_e2e
//! # specific ids, with a turn
//! AGENTS="codex-acp,gemini" ACP_PROMPT="Say hi" cargo run ... --example registry_e2e
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_acp::{AcpEvent, AgentId, AgentRegistry, EventSink, SpecSource};
use atlas_registry::RegistryStore;

/// Agents to exercise when `AGENTS` is unset — a spread across every
/// distribution kind (npx, per-platform binary) and both auth styles (API key
/// via env, and OAuth/subscription).
const DEFAULT_AGENTS: &[&str] = &[
    "claude-acp",
    "codex-acp",
    "gemini",
    "github-copilot-cli",
    "qwen-code",
    "cline",
    "opencode",
    "cursor",
    "kilo",
    "amp-acp",
];

const DEFAULT_PROMPT: &str = "Reply with exactly the word: ATLAS_OK";

/// Collects streamed assistant text so a turn can be asserted on.
#[derive(Default)]
struct Collector {
    text: std::sync::Mutex<String>,
    disconnected: AtomicBool,
}

impl EventSink for Collector {
    fn emit(&self, _agent: AgentId, event: AcpEvent, _turn: Option<u64>) {
        match event {
            AcpEvent::AgentDisconnected { reason } => {
                eprintln!("      ⚠ disconnected: {reason}");
                self.disconnected.store(true, Ordering::Relaxed);
            }
            AcpEvent::SessionUpdate { update, .. } => {
                if let Ok(v) = serde_json::to_value(&update) {
                    // Only the assistant's own message text; tool output and
                    // thoughts are noise for a liveness check.
                    if v.get("sessionUpdate").and_then(|s| s.as_str())
                        == Some("agent_message_chunk")
                    {
                        if let Some(t) = v.pointer("/content/text").and_then(|t| t.as_str()) {
                            if let Ok(mut buf) = self.text.lock() {
                                buf.push_str(t);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

struct Outcome {
    id: String,
    installed: Result<String, String>,
    spawned: Result<String, String>,
    turn: Result<String, String>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let ids: Vec<String> = std::env::var("AGENTS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_else(|| DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect());
    let prompt = std::env::var("ACP_PROMPT").unwrap_or_else(|_| DEFAULT_PROMPT.into());

    let dir = std::env::temp_dir().join(format!("atlas-registry-e2e-{}", std::process::id()));
    let store = RegistryStore::new(dir.clone());
    eprintln!("📁 app data: {}", dir.display());

    // A brand-new install: the invariant is that it can spawn nothing at all.
    assert!(
        store.extra_specs().is_empty(),
        "a fresh store must offer zero agents — nothing is built in"
    );
    eprintln!("✓ fresh store offers 0 agents (nothing is built in)\n");

    eprintln!("🌐 refreshing the ACP registry…");
    store.refresh(true).await?;
    let listing = store.list();
    eprintln!("✓ {} agents in the registry\n", listing.entries.len());

    // BYOK keys, injected into EVERY installed agent exactly as the app does.
    let mut env = HashMap::new();
    for (var, val) in [
        ("OPENAI_API_KEY", std::env::var("OPENAI_API_KEY").ok()),
        ("ANTHROPIC_API_KEY", std::env::var("ANTHROPIC_API_KEY").ok()),
        ("GEMINI_API_KEY", std::env::var("GOOGLE_API_KEY").ok()),
        (
            "GOOGLE_GENERATIVE_AI_API_KEY",
            std::env::var("GOOGLE_API_KEY").ok(),
        ),
        ("GOOGLE_API_KEY", std::env::var("GOOGLE_API_KEY").ok()),
    ] {
        if let Some(v) = val {
            env.insert(var.to_string(), v);
        }
    }
    eprintln!(
        "🔑 injecting {} API-key env vars into every agent\n",
        env.len()
    );
    store.set_agent_env(env);

    let store = Arc::new(store);
    let acp = AgentRegistry::with_spec_source(store.clone());
    let mut outcomes = Vec::new();

    for id in &ids {
        eprintln!("──────── {id}");
        let mut outcome = Outcome {
            id: id.clone(),
            installed: Err("not attempted".into()),
            spawned: Err("not attempted".into()),
            turn: Err("not attempted".into()),
        };

        let t0 = Instant::now();
        match store.install(id, None).await {
            Ok(inst) => {
                eprintln!("  ✓ installed v{} in {:?}", inst.version, t0.elapsed());
                outcome.installed = Ok(inst.version.clone());
            }
            Err(e) => {
                eprintln!("  ✗ install failed: {e}");
                outcome.installed = Err(e.to_string());
                outcomes.push(outcome);
                continue;
            }
        }

        // The spec must now exist, and ONLY because the install does.
        let spec = acp.known_specs().into_iter().find(|s| &s.spec_id == id);
        let Some(spec) = spec else {
            outcome.spawned = Err("installed but produced no spawnable spec".into());
            outcomes.push(outcome);
            continue;
        };
        let shown: String = spec.command.chars().take(110).collect();
        eprintln!("  → command: {shown}");

        let collector = Arc::new(Collector::default());
        let t0 = Instant::now();
        let info =
            match tokio::time::timeout(Duration::from_secs(120), acp.spawn(id, collector.clone()))
                .await
            {
                Ok(Ok(info)) => {
                    eprintln!("  ✓ spawned + initialized in {:?}", t0.elapsed());
                    outcome.spawned = Ok(format!("{:?}", t0.elapsed()));
                    info
                }
                Ok(Err(e)) => {
                    eprintln!("  ✗ spawn failed: {e}");
                    outcome.spawned = Err(e.to_string());
                    outcomes.push(outcome);
                    continue;
                }
                Err(_) => {
                    eprintln!("  ✗ spawn timed out");
                    outcome.spawned = Err("timed out after 120s".into());
                    outcomes.push(outcome);
                    continue;
                }
            };

        // Config options as the composer would see them at bind — the effort
        // picker's only source for agents that never push a config_option_update.
        match acp.new_session(info.agent_id, std::env::current_dir().unwrap_or_default()).await {
            Ok(init) => {
                let opts = init
                    .config_options
                    .as_ref()
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default();
                let ids: Vec<String> = opts
                    .iter()
                    .map(|o| {
                        format!(
                            "{}({})",
                            o.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                            o.get("category").and_then(|v| v.as_str()).unwrap_or("-")
                        )
                    })
                    .collect();
                eprintln!("  ⚙ session/new config options: [{}]", ids.join(", "));
            }
            Err(e) => eprintln!("  ⚙ session/new failed: {e}"),
        }

        // What the shared sign-in modal would offer for this agent.
        match acp.auth_methods(info.agent_id) {
            Ok(methods) if !methods.is_empty() => {
                let names: Vec<String> = methods
                    .iter()
                    .map(|m| {
                        format!(
                            "{}{}",
                            m.id,
                            if m.terminal_command.is_some() {
                                " (terminal)"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect();
                eprintln!("  🔐 auth methods: {}", names.join(", "));
            }
            Ok(_) => eprintln!("  🔓 no auth methods advertised"),
            Err(e) => eprintln!("  ? auth methods unavailable: {e}"),
        }

        outcome.turn = run_turn(&acp, info.agent_id, &collector, &prompt).await;
        // The universal auth ladder, exactly as the sign-in modal drives it:
        // an `Authentication required` failure is answered by calling the
        // protocol's own `authenticate` with an advertised method, then
        // retrying. No per-agent branch — the method ids come from the agent.
        if outcome
            .turn
            .as_ref()
            .err()
            .is_some_and(|e| e.to_lowercase().contains("authentication"))
        {
            for method in acp.auth_methods(info.agent_id).unwrap_or_default() {
                // Terminal methods open a browser and block on a human; the
                // modal runs those, this harness cannot.
                if method.terminal_command.is_some() {
                    continue;
                }
                eprintln!("  🔑 authenticate({})…", method.id);
                match acp.authenticate(info.agent_id, method.id.clone()).await {
                    Ok(()) => {
                        eprintln!("  ✓ authenticated via {}", method.id);
                        outcome.turn = run_turn(&acp, info.agent_id, &collector, &prompt).await;
                        if outcome.turn.is_ok() {
                            break;
                        }
                    }
                    Err(e) => eprintln!("  · {} rejected: {e}", method.id),
                }
            }
        }
        match &outcome.turn {
            Ok(t) => eprintln!("  ✓ turn: {t}"),
            Err(e) => eprintln!("  ✗ turn: {e}"),
        }
        let _ = acp.kill(info.agent_id);
        outcomes.push(outcome);
    }

    acp.kill_all();
    report(&outcomes);
    Ok(())
}

async fn run_turn(
    acp: &AgentRegistry,
    agent_id: AgentId,
    collector: &Arc<Collector>,
    prompt: &str,
) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let session =
        match tokio::time::timeout(Duration::from_secs(60), acp.new_session(agent_id, cwd)).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(format!("session/new: {e}")),
            Err(_) => return Err("session/new timed out".into()),
        };
    let session_id = session.session_id.clone();
    acp.mark_turn_started(agent_id, &session_id)
        .map_err(|e| e.to_string())?;

    match tokio::time::timeout(
        Duration::from_secs(180),
        acp.send_prompt(agent_id, session_id, prompt.to_string()),
    )
    .await
    {
        Ok(Ok(stop)) => {
            let text = collector.text.lock().map(|t| t.clone()).unwrap_or_default();
            let sample: String = text.trim().chars().take(80).collect();
            Ok(format!("stop={stop:?} text={sample:?}"))
        }
        Ok(Err(e)) => Err(format!("session/prompt: {e}")),
        Err(_) => Err("session/prompt timed out".into()),
    }
}

fn report(outcomes: &[Outcome]) {
    eprintln!("\n════════ SUMMARY ════════");
    eprintln!(
        "{:<22} {:<10} {:<12} {}",
        "agent", "install", "spawn", "turn"
    );
    for o in outcomes {
        let mark = |r: &Result<String, String>| if r.is_ok() { "ok" } else { "FAIL" };
        eprintln!(
            "{:<22} {:<10} {:<12} {}",
            o.id,
            mark(&o.installed),
            mark(&o.spawned),
            match &o.turn {
                Ok(t) => t.clone(),
                Err(e) => format!("FAIL: {}", e.chars().take(90).collect::<String>()),
            }
        );
    }
    let installed = outcomes.iter().filter(|o| o.installed.is_ok()).count();
    let spawned = outcomes.iter().filter(|o| o.spawned.is_ok()).count();
    let turned = outcomes.iter().filter(|o| o.turn.is_ok()).count();
    eprintln!(
        "\n{installed}/{} installed · {spawned}/{} spawned+initialized · {turned}/{} completed a turn",
        outcomes.len(),
        outcomes.len(),
        outcomes.len()
    );
}
