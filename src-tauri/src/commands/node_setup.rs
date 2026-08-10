//! Node runtime detection + auto-install via the bundled `nvm`.
//!
//! The ACP agents (`npx … claude-agent-acp` / `codex-acp`) need a working Node.
//! `atlas_acp::sanitize_host_env` already enriches PATH so a Node that's
//! installed-but-not-on-the-GUI-PATH is found. This module covers the two cases
//! that PATH enrichment can't fix:
//!   1. No Node anywhere on the machine.
//!   2. A Node that's present but too old for the ACP adapter.
//!
//! In both cases we install a known-good LTS Node using the bundled `nvm.sh`
//! (shipped as a Tauri resource — ~150 KB, no runtime download of nvm itself),
//! into an Atlas-private `NVM_DIR` under the app data dir, and register its bin
//! dir as the preferred toolchain for agent spawns
//! (`atlas_acp::register_managed_node_bin`). Node binaries themselves are still
//! fetched by nvm from nodejs.org on first install (network required once).
//!
//! Mirrors `claude_setup.rs`: `node_check` is a fast probe; `node_install`
//! streams progress as `atlas:node-install:progress` window events and emits
//! `atlas:node-install:done` on completion.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;
use tokio::time::timeout;

/// Minimum Node major version the ACP adapter (Claude Agent SDK) needs.
const MIN_NODE_MAJOR: u32 = 18;
/// Where the bundled nvm installs Node, relative to the app data dir.
const NODE_RUNTIME_SUBDIR: &str = "node-runtime";
/// Cache file (under the node-runtime dir) recording the last known-good Node so
/// subsequent boots skip the slow login-shell resolution. See `node_check`.
const NODE_READY_CACHE: &str = "ready.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    /// "ok" | "missing" | "incompatible"
    pub status: String,
    /// e.g. "v20.17.0" when a Node was found.
    pub version: Option<String>,
    /// Absolute path to the resolved `node`.
    pub path: Option<String>,
    /// True when the resolved Node is the Atlas-managed (bundled-nvm) install.
    pub managed: bool,
    /// Minimum major version required (so the UI can explain "needs Node ≥ N").
    pub min_major: u32,
}

/// Resolve a CLI to an absolute path via the user's login shell
/// (covers nvm/fnm/volta/brew). Mirrors `claude_setup::resolve_cli`.
async fn resolve_cli(name: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-lic`, not `-lc` — interactive so ~/.zshrc PATH exports (nvm init,
    // opencode, …) are seen; rc noise handled by taking the last line. See
    // `claude_setup::resolve_cli` / `atlas_acp::spawn::probe_shell`.
    let probe = AsyncCommand::new(&shell)
        .args(["-lic", &format!("command -v {name} 2>/dev/null")])
        .output();
    if let Ok(Ok(out)) = timeout(Duration::from_secs(5), probe).await {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            if let Some(p) = raw.lines().rev().find(|l| !l.trim().is_empty()) {
                let p = p.trim();
                if p.starts_with('/') && Path::new(p).exists() {
                    return Some(p.to_string());
                }
            }
        }
    }
    None
}

/// `<node> --version` → "v20.17.0".
async fn node_version(node: &str) -> Option<String> {
    let out = AsyncCommand::new(node).arg("--version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

fn major_of(version: &str) -> Option<u32> {
    version.trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Newest `<nvm_dir>/versions/node/vX.Y.Z/bin` directory, if any.
fn newest_managed_node_bin(nvm_dir: &Path) -> Option<PathBuf> {
    let versions = nvm_dir.join("versions").join("node");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&versions)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("bin").join("node").is_file())
        .collect();
    dirs.sort(); // vMAJOR.MINOR.PATCH sorts fine lexicographically for our use
    dirs.pop().map(|p| p.join("bin"))
}

/// Resolve the best available `node`: the Atlas-managed install first (a
/// previous bundled-nvm install), then whatever the login shell resolves.
async fn resolve_node() -> Option<(String, String)> {
    if let Some(bin) = atlas_acp::managed_node_bin() {
        let node = bin.join("node");
        if node.is_file() {
            let node = node.to_string_lossy().into_owned();
            if let Some(v) = node_version(&node).await {
                return Some((node, v));
            }
        }
    }
    if let Some(node) = resolve_cli("node").await {
        if let Some(v) = node_version(&node).await {
            return Some((node, v));
        }
    }
    None
}

/// Path to the known-good-Node cache file, under the app data dir.
fn ready_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(NODE_RUNTIME_SUBDIR).join(NODE_READY_CACHE))
}

fn read_ready_cache(app: &AppHandle) -> Option<NodeStatus> {
    let bytes = std::fs::read(ready_cache_path(app)?).ok()?;
    serde_json::from_slice::<NodeStatus>(&bytes).ok()
}

/// Persist a known-good status as the boot fast-path. Best-effort.
fn write_ready_cache(app: &AppHandle, status: &NodeStatus) {
    let Some(path) = ready_cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(status) {
        let _ = std::fs::write(&path, json);
    }
}

fn clear_ready_cache(app: &AppHandle) {
    if let Some(path) = ready_cache_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Full probe: resolve a Node (managed first, then login shell) and classify it.
/// This is the slow path — `resolve_cli` shells out to `$SHELL -lic` (≤5s).
async fn full_node_check() -> NodeStatus {
    match resolve_node().await {
        Some((path, version)) => {
            let compatible = major_of(&version).map(|m| m >= MIN_NODE_MAJOR).unwrap_or(false);
            let managed = atlas_acp::managed_node_bin()
                .map(|b| path.starts_with(&*b.to_string_lossy()))
                .unwrap_or(false);
            NodeStatus {
                status: if compatible { "ok" } else { "incompatible" }.into(),
                version: Some(version),
                path: Some(path),
                managed,
                min_major: MIN_NODE_MAJOR,
            }
        }
        None => NodeStatus {
            status: "missing".into(),
            version: None,
            path: None,
            managed: false,
            min_major: MIN_NODE_MAJOR,
        },
    }
}

/// Fast probe: is a Node usable for the ACP agents?
///
/// On a fresh process `MANAGED_NODE_BIN` is unset and `resolve_node` falls
/// through to `resolve_cli`, which shells out to `$SHELL -lic` — up to 5s on
/// every boot, even when a perfectly good Node is already installed. To make the
/// common "Node is ready" case load instantly we cache the last known-good
/// resolution in `node-runtime/ready.json`. On the fast path we only confirm the
/// cached binary still exists and reports a compatible version (a ~tens-of-ms
/// `node --version`, not the slow login-shell walk), and we re-register a managed
/// install so agent spawns prefer it this session. A miss falls back to the full
/// resolve and refreshes the cache.
#[tauri::command]
pub async fn node_check(app: AppHandle) -> NodeStatus {
    if let Some(cached) = read_ready_cache(&app) {
        if cached.status == "ok" {
            if let Some(path) = cached.path.clone() {
                if Path::new(&path).is_file() {
                    if let Some(version) = node_version(&path).await {
                        if major_of(&version).map(|m| m >= MIN_NODE_MAJOR).unwrap_or(false) {
                            // A managed Node is only registered (and thus PATH-
                            // preferred for spawns) after an in-session install;
                            // re-register it here so a previously-installed
                            // managed Node still wins after a restart.
                            if cached.managed {
                                if let Some(bin) = Path::new(&path).parent() {
                                    atlas_acp::register_managed_node_bin(bin.to_path_buf());
                                }
                            }
                            return NodeStatus { version: Some(version), ..cached };
                        }
                    }
                }
            }
        }
        // Stale cache (binary gone / downgraded) — drop it and re-resolve.
        clear_ready_cache(&app);
    }

    let status = full_node_check().await;
    if status.status == "ok" {
        write_ready_cache(&app, &status);
    }
    status
}

#[derive(Debug, Clone, Serialize)]
struct InstallProgress {
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallDone {
    success: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
}

/// Locate the bundled `nvm.sh` — the Tauri resource in production, the source
/// tree in `tauri dev`.
fn bundled_nvm_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve("resources/nvm.sh", BaseDirectory::Resource) {
        if p.exists() {
            return Some(p);
        }
    }
    // Dev fallback: resources/ next to Cargo.toml.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/nvm.sh");
    if dev.exists() { Some(dev) } else { None }
}

/// Install (or upgrade to) the latest LTS Node via the bundled nvm, into an
/// Atlas-private NVM_DIR. Streams progress; emits `atlas:node-install:done`.
/// Returns immediately after the child + reader tasks are running.
#[tauri::command]
pub async fn node_install(app: AppHandle) -> Result<(), String> {
    tracing::info!(target: "atlas::node_setup", "starting bundled-nvm node install");

    let nvm_sh = bundled_nvm_path(&app).ok_or_else(|| "bundled nvm.sh not found".to_string())?;
    let nvm_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join(NODE_RUNTIME_SUBDIR);
    std::fs::create_dir_all(&nvm_dir).map_err(|e| format!("mkdir NVM_DIR: {e}"))?;

    // Source nvm and install the latest LTS. PROFILE=/dev/null keeps nvm from
    // writing to the user's shell rc (we manage PATH ourselves).
    let script = format!(
        r#"export NVM_DIR="{nvm_dir}"
export PROFILE=/dev/null
\. "{nvm_sh}" --no-use
nvm install --lts --no-progress --default
node --version"#,
        nvm_dir = nvm_dir.display(),
        nvm_sh = nvm_sh.display(),
    );

    let mut child = AsyncCommand::new("/bin/bash")
        .args(["-c", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn nvm: {e}"))?;

    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_progress(&app, "stdout", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_progress(&app, "stderr", line);
            }
        });
    }

    tokio::spawn(async move {
        let status = child.wait().await;
        let ok = matches!(&status, Ok(s) if s.success());

        // Even on a non-zero exit, a usable Node may already be present (e.g. an
        // earlier install) — so we look for the bin regardless and decide based
        // on whether we actually found a working `node`.
        let bin = newest_managed_node_bin(&nvm_dir);
        let done = match bin {
            Some(bin) if bin.join("node").is_file() => {
                atlas_acp::register_managed_node_bin(bin.clone());
                let node = bin.join("node").to_string_lossy().into_owned();
                let version = node_version(&node).await;
                tracing::info!(target: "atlas::node_setup", "node ready at {node} ({version:?})");
                // Seed the boot fast-path so the next launch skips the slow
                // login-shell resolve and re-registers this managed Node.
                write_ready_cache(
                    &app,
                    &NodeStatus {
                        status: "ok".into(),
                        version: version.clone(),
                        path: Some(node.clone()),
                        managed: true,
                        min_major: MIN_NODE_MAJOR,
                    },
                );
                InstallDone {
                    success: true,
                    version,
                    path: Some(node),
                    error: None,
                }
            }
            _ => {
                let err = match status {
                    Ok(s) => format!("nvm exited with {s} and no Node was installed"),
                    Err(e) => format!("failed to wait for nvm: {e}"),
                };
                tracing::warn!(target: "atlas::node_setup", "{err}");
                InstallDone {
                    success: false,
                    version: None,
                    path: None,
                    error: Some(err),
                }
            }
        };
        let _ = ok; // kept for clarity; success is decided by binary presence
        let _ = app.emit("atlas:node-install:done", done);
    });

    Ok(())
}

fn emit_progress(app: &AppHandle, stream: &'static str, line: String) {
    let _ = app.emit("atlas:node-install:progress", InstallProgress { stream, line });
}
