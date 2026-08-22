//! Claude Code install + status commands.
//!
//! Two commands the chat panel calls to gate the composer behind a
//! working `claude` CLI:
//!
//! - `claude_status` — fast, parallel probe: `claude --version` +
//!   `claude auth status`. Returns `installed` + `authenticated`.
//! - `claude_install` — long-running. Pipes `curl -fsSL
//!   https://claude.ai/install.sh | bash` and streams stdout/stderr lines
//!   as `atlas:claude-install:progress` window events; emits
//!   `atlas:claude-install:done` on child exit.
//!
//! The auth login flow itself is NOT in this module. It lives in
//! `commands::agents::agents_run_auth_method` because the canonical
//! source of truth for "how do I log in to Claude Code" is the
//! `authMethods` array the claude-agent-acp adapter advertises during
//! its ACP `initialize` response — same pattern Zed uses. The host's
//! job is just to spawn the spec the adapter hands it.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;
use tokio::time::timeout;

/// Resolve a CLI's absolute path via the user's login shell.
///
/// macOS GUI apps launched from Finder/the Dock inherit only a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `claude` spawn fails even when
/// the user has it on their interactive-shell PATH (`~/.local/bin`, nvm, a
/// custom npm prefix, Homebrew, etc.). Asking their own `$SHELL -lc` resolves
/// the binary the same way their terminal would — login-shell PATH sourcing
/// without interactive-shell job-control init, which self-stops via SIGTTOU
/// when this process has a real controlling terminal attached (e.g. any
/// dev-mode launch from a terminal, vs. a Finder/Dock-launched build).
/// Falls back to the bare name (relying on the process-wide PATH enrichment
/// by the login-shell probe) if the shell probe fails or times out.
async fn resolve_cli(name: &str) -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-lic`, not `-lc`: zsh only reads ~/.zshrc in interactive shells, and
    // that's where many installers put their PATH export — a login-only probe
    // finds the CLI in dev (terminal-inherited PATH) but not in the bundled
    // app. Interactive rcs can echo noise, so take the LAST non-empty line.
    let probe = AsyncCommand::new(&shell)
        .args(["-lic", &format!("command -v {name} 2>/dev/null")])
        .output();
    if let Ok(Ok(out)) = timeout(Duration::from_secs(5), probe).await {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            if let Some(p) = raw.lines().rev().find(|l| !l.trim().is_empty()) {
                let p = p.trim();
                // Accept only a real absolute path (not a shell function/alias name).
                if p.starts_with('/') && std::path::Path::new(p).exists() {
                    return p.to_string();
                }
            }
        }
    }
    name.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// claude_status
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    pub auth_summary: Option<String>,
}

/// Fast probe — runs `claude --version` and `claude auth status` in parallel.
/// Always returns a populated struct; never errors (an absent binary just
/// surfaces as `installed: false`).
#[tauri::command]
pub async fn claude_status() -> ClaudeStatus {
    // Resolve via the user's login shell so we find `claude` wherever they
    // installed it (GUI apps don't inherit the interactive-shell PATH).
    let claude = resolve_cli("claude").await;
    let version_fut = AsyncCommand::new(&claude).arg("--version").output();
    let auth_fut = AsyncCommand::new(&claude).args(["auth", "status"]).output();

    let (version_res, auth_res) = tokio::join!(version_fut, auth_fut);

    let (installed, version) = match version_res {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (true, if raw.is_empty() { None } else { Some(raw) })
        }
        _ => (false, None),
    };

    if !installed {
        return ClaudeStatus {
            installed: false,
            version: None,
            authenticated: false,
            auth_summary: None,
        };
    }

    let (authenticated, auth_summary) = match auth_res {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let summary = stdout
                .lines()
                .find(|l| !l.trim().is_empty())
                .or_else(|| stderr.lines().find(|l| !l.trim().is_empty()))
                .map(|l| l.trim().to_string());
            (out.status.success(), summary)
        }
        Err(_) => (false, None),
    };

    ClaudeStatus {
        installed,
        version,
        authenticated,
        auth_summary,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// claude_install
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct InstallProgress {
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

#[derive(Debug, Clone, Serialize)]
struct InstallDone {
    success: bool,
    exit_code: Option<i32>,
}

const INSTALL_CMD: &str = "curl -fsSL https://claude.ai/install.sh | bash";

/// Runs the official Anthropic install script. Streams each line of
/// stdout/stderr as a `atlas:claude-install:progress` event so the banner
/// can show a live tail; emits `atlas:claude-install:done` when the child
/// exits. Returns immediately after the child is spawned + reader tasks
/// are running — the frontend awaits the `done` event, not this Result.
#[tauri::command]
pub async fn claude_install(app: AppHandle) -> Result<(), String> {
    tracing::info!(target: "atlas::claude_setup", "starting claude install");

    let mut child = AsyncCommand::new("bash")
        .args(["-c", INSTALL_CMD])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn install: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_progress(&app, "stdout", line);
            }
        });
    }
    if let Some(err) = stderr {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_progress(&app, "stderr", line);
            }
        });
    }

    let app_for_wait = app.clone();
    tokio::spawn(async move {
        let result = child.wait().await;
        let (success, exit_code) = match result {
            Ok(status) => (status.success(), status.code()),
            Err(e) => {
                tracing::warn!(target: "atlas::claude_setup", "wait failed: {e}");
                (false, None)
            }
        };
        let _ = app_for_wait.emit(
            "atlas:claude-install:done",
            InstallDone { success, exit_code },
        );
    });

    Ok(())
}

fn emit_progress(app: &AppHandle, stream: &'static str, line: String) {
    let _ = app.emit(
        "atlas:claude-install:progress",
        InstallProgress { stream, line },
    );
}
