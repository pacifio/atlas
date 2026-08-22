//! BYOK (bring-your-own-key) — a view onto the user's shell environment.
//!
//! **Atlas stores no API keys.** It used to keep them in a private JSON file;
//! that store is gone. A key lives exactly where the rest of the user's tooling
//! already looks for it — an `export` in their shell profile — and Settings ▸
//! API Keys is an editor for those lines, not a vault.
//!
//! This is the right shape for three reasons:
//!
//! - **One source of truth.** The user's CLIs, the ACP agents Atlas spawns
//!   through a login shell, and Atlas itself all read the same variable. No
//!   copy to drift, and no "works in my terminal but not in Atlas".
//! - **Nothing to leak.** Atlas holds keys in memory for the session only.
//!   Deleting Atlas takes nothing with it and leaves nothing behind.
//! - **No lock-in.** The user can edit the same lines by hand, and does not
//!   need Atlas running to keep their environment working.
//!
//! ## Reading
//!
//! Two phases, neither of which ever blocks a caller (see [`ensure_shell_probe`]):
//! the process env answers instantly, and a background `$SHELL -lic` probe fills
//! in profile-exported keys a moment later. On top of that, the profile files
//! themselves are parsed ([`super::shell_profile`]) so the UI can say *which
//! file and line* a key comes from, and offer to edit it.
//!
//! A key found only in the live environment (launchd, `/etc/profile`, a wrapper
//! script) is shown but not editable — Atlas will not guess at a file it did not
//! find the value in.
//!
//! ## Writing
//!
//! [`byok_env_set`] rewrites the assignment where it already lives, or appends
//! to the shell's primary rc file. Every write is backed up once and applied
//! atomically. The in-memory snapshot and the agent spawn env are updated
//! immediately, so a key works in the running app without a restart — while a
//! *terminal* needs a new shell, as it would for any profile edit.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::shell_profile::{self, ShellKind};

/// Environment-sourced API keys — the user may already export provider keys in
/// their shell profile. A Finder-launched GUI app never inherits those, so we
/// probe the login shell ONCE (same `-lic` discipline as PATH enrichment: the
/// exports usually live in `~/.zshrc`) and merge with the process env (which
/// wins — it covers `tauri dev` from a terminal). Values stay in memory only;
/// nothing is written to disk, and the UI gets provider + var name + last4.
///
/// Per provider the FIRST var in its list wins. Every provider lists its
/// canonical var first, then the alias spellings its own SDKs / common tooling
/// actually read (e.g. Cohere's SDK reads `CO_API_KEY`, DeepInfra's docs use
/// `DEEPINFRA_API_TOKEN`, ElevenLabs historically `XI_API_KEY`) — a user who
/// exported ANY recognised spelling gets their key imported.
const ENV_KEY_VARS: &[(&str, &[&str])] = &[
    ("anthropic", &["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]),
    ("openai", &["OPENAI_API_KEY", "OPENAI_KEY"]),
    ("google", &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]),
    ("openrouter", &["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"]),
    ("mistral", &["MISTRAL_API_KEY"]),
    ("cohere", &["COHERE_API_KEY", "CO_API_KEY"]),
    ("xai", &["XAI_API_KEY", "GROK_API_KEY"]),
    ("deepseek", &["DEEPSEEK_API_KEY"]),
    ("ai21", &["AI21_API_KEY"]),
    ("groq", &["GROQ_API_KEY"]),
    ("together", &["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY", "TOGETHERAI_API_KEY"]),
    ("fireworks", &["FIREWORKS_API_KEY", "FIREWORKS_AI_API_KEY"]),
    ("deepinfra", &["DEEPINFRA_API_KEY", "DEEPINFRA_API_TOKEN"]),
    ("cerebras", &["CEREBRAS_API_KEY"]),
    ("replicate", &["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]),
    ("perplexity", &["PERPLEXITY_API_KEY", "PPLX_API_KEY"]),
    ("litellm", &["LITELLM_API_KEY", "LITELLM_MASTER_KEY"]),
    ("azure", &["AZURE_API_KEY", "AZURE_OPENAI_API_KEY"]),
    ("voyage", &["VOYAGE_API_KEY", "VOYAGEAI_API_KEY"]),
    ("huggingface", &["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_API_KEY"]),
    ("jina", &["JINA_API_KEY"]),
    ("elevenlabs", &["ELEVENLABS_API_KEY", "ELEVEN_API_KEY", "XI_API_KEY"]),
];

/// One env-imported key: which provider it maps to, the variable it came from,
/// and its value. Held in memory only.
#[derive(Debug, Clone)]
pub struct EnvKey {
    pub provider: String,
    pub env_var: String,
    pub key: String,
}

/// Two-phase, NEVER-blocking env-key state. The old `OnceLock::get_or_init`
/// design made whichever reader arrived first (often the settings screen's
/// `byok_env_list`, since Settings → API Keys is a common first stop after
/// launch) wait up to 5s on the login-shell probe. Now:
///
/// - Phase 1 (instant, at first read): the process env is scanned — free, and
///   already correct for terminal-launched sessions.
/// - Phase 2 (background, kicked once by [`ensure_shell_probe`] at boot):
///   `$SHELL -lic` fills in profile-exported keys, merges (process env wins),
///   re-syncs the built-in agents' spawn env, and emits
///   `atlas:byok-env-updated` so the settings UI refreshes its pills.
///
/// Every reader gets the CURRENT snapshot immediately; nothing ever waits.
struct EnvKeyState {
    /// Raw env var → value, merged across both phases.
    by_var: BTreeMap<String, String>,
    /// True once the login-shell pass finished (or failed) — the snapshot is
    /// as complete as it will get this run.
    shell_done: bool,
}

fn env_state() -> &'static parking_lot::RwLock<EnvKeyState> {
    static STATE: std::sync::OnceLock<parking_lot::RwLock<EnvKeyState>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| {
        // Phase 1: process env only — microseconds, never blocks.
        let mut by_var = BTreeMap::new();
        for (_, vars) in ENV_KEY_VARS {
            for var in *vars {
                if let Ok(v) = std::env::var(var) {
                    if !v.trim().is_empty() {
                        by_var.insert((*var).to_string(), v.trim().to_string());
                    }
                }
            }
        }
        parking_lot::RwLock::new(EnvKeyState {
            by_var,
            shell_done: false,
        })
    })
}

/// provider id → env-sourced key, derived from the current (possibly still
/// phase-1-only) snapshot. Cheap: ~22 table rows against a small map.
fn env_keys() -> BTreeMap<String, EnvKey> {
    let state = env_state().read();
    let mut out = BTreeMap::new();
    for (provider, vars) in ENV_KEY_VARS {
        for var in *vars {
            if let Some(v) = state.by_var.get(*var) {
                out.insert(
                    (*provider).to_string(),
                    EnvKey {
                        provider: (*provider).to_string(),
                        env_var: (*var).to_string(),
                        key: v.clone(),
                    },
                );
                break; // first var in the list wins for this provider
            }
        }
    }
    out
}

/// Kick the phase-2 login-shell probe exactly once per app run, on its own
/// thread. Completion merges the results (process env wins on collision),
/// re-syncs the built-in agents' spawn env, and notifies the frontend.
/// Safe to call from anywhere, any number of times.
pub fn ensure_shell_probe(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let shell = shell_env_values();
        {
            let mut state = env_state().write();
            for (var, value) in shell {
                // Process env wins: a var exported in the launching terminal
                // is more current than the shell profile's.
                state.by_var.entry(var).or_insert(value);
            }
            state.shell_done = true;
        }
        sync_agent_key_env(&app);
        use tauri::Emitter;
        let _ = app.emit("atlas:byok-env-updated", ());
    });
}

/// `$SHELL -lic` probe for every known key var, sentinel-framed so rc noise
/// ahead of the printf can't contaminate the first value. Values may not
/// contain `` (unit separator) — a safe assumption for API keys.
fn shell_env_values() -> BTreeMap<String, String> {
    let vars: Vec<&str> = ENV_KEY_VARS.iter().flat_map(|(_, vs)| vs.iter().copied()).collect();
    let fmt: String = vars
        .iter()
        .map(|v| format!("\"${{{v}}}\""))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "printf 'ATLAS_ENV_PROBE\x1f'; printf '%s\x1f' {fmt}"
    );
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let child = std::process::Command::new(&shell)
        .args(["-lic", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(child) = child else { return BTreeMap::new() };
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(out)) if out.status.success() => out,
        _ => {
            let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
            return BTreeMap::new();
        }
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let Some(after) = raw.rsplit("ATLAS_ENV_PROBE").next() else {
        return BTreeMap::new();
    };
    let values: Vec<&str> = after.split('').collect();
    vars.iter()
        .zip(values)
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(var, v)| ((*var).to_string(), v.trim().to_string()))
        .collect()
}

/// Non-secret view of an env-imported key for the settings UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeyMeta {
    pub provider: String,
    pub env_var: String,
    pub last4: String,
}

/// Env-imported keys (provider + var + last4). Instant: reads the current
/// snapshot (process env at minimum) and never waits on the shell probe —
/// when the probe lands, `atlas:byok-env-updated` fires and the UI refetches.
#[tauri::command]
pub fn byok_env_list(app: AppHandle) -> Vec<EnvKeyMeta> {
    ensure_shell_probe(&app);
    env_keys()
        .values()
        .map(|k| EnvKeyMeta {
            provider: k.provider.clone(),
            env_var: k.env_var.clone(),
            last4: k.key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect(),
        })
        .collect()
}

/// Map the env-sourced keys onto the variable spellings the installed agent
/// CLIs actually read. Google gets both spellings — the Vercel AI SDK stack
/// inside opencode reads `GOOGLE_GENERATIVE_AI_API_KEY`, other tooling reads
/// `GEMINI_API_KEY` — so a user who exported either gets both.
fn agent_key_env() -> std::collections::HashMap<String, String> {
    let inject_vars = |provider: &str| -> &'static [&'static str] {
        match provider {
            "anthropic" => &["ANTHROPIC_API_KEY"],
            "openai" => &["OPENAI_API_KEY"],
            "openrouter" => &["OPENROUTER_API_KEY"],
            "google" => &["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
            "groq" => &["GROQ_API_KEY"],
            "deepinfra" => &["DEEPINFRA_API_KEY"],
            _ => &[],
        }
    };
    let mut env = std::collections::HashMap::new();
    for (provider, ek) in env_keys() {
        for var in inject_vars(provider.as_str()) {
            env.insert((*var).to_string(), ek.key.clone());
        }
    }
    env
}

/// Push the current BYOK keys into the registry store's spawn env, so any
/// installed agent that reads a standard provider key works out of the box —
/// the clean alternative to an interactive `auth login` TUI, which Atlas
/// cannot drive (it spawns login subprocesses with stdin closed).
///
/// Applied to EVERY installed agent, not a list of blessed ids: a key is a
/// host capability, and whether an agent uses it is the agent's business. The
/// agent's own registry env is the base and the user's per-install overrides
/// still win. Called at boot and after every key add/remove; live agents keep
/// their env until respawned.
pub fn sync_agent_key_env(app: &AppHandle) {
    if let Some(registry) = app.try_state::<atlas_registry::RegistryStore>() {
        registry.set_agent_env(agent_key_env());
    }
}


// ── Shell-profile view + editor ───────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// Every var Atlas recognises, flattened, with the provider it belongs to.
fn known_vars() -> Vec<(&'static str, &'static str)> {
    ENV_KEY_VARS
        .iter()
        .flat_map(|(p, vars)| vars.iter().map(move |v| (*p, *v)))
        .collect()
}

/// Where a key's value came from — and therefore whether Atlas can edit it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    pub provider: String,
    pub env_var: String,
    pub last4: String,
    /// Absolute path of the profile file holding it, when we found one.
    pub file: Option<String>,
    /// 1-based line in `file`.
    pub line: Option<usize>,
    /// False when the value only exists in the live environment (launchd,
    /// `/etc/profile`, a wrapper) — Atlas will not invent a file to edit.
    pub editable: bool,
}

/// Which profile files Atlas reads, and which one a new key would go into.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub shell: String,
    /// File new variables are appended to.
    pub target: String,
    /// Every candidate, in scan order, with whether it exists today.
    pub scanned: Vec<ScannedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub path: String,
    pub exists: bool,
}

#[tauri::command]
pub fn byok_profile_info() -> ProfileInfo {
    let shell = user_shell();
    let home = home_dir().unwrap_or_default();
    ProfileInfo {
        target: shell_profile::primary_target(&home, &shell)
            .to_string_lossy()
            .into_owned(),
        scanned: shell_profile::scan_candidates(&home, &shell)
            .into_iter()
            .map(|p| ScannedFile {
                exists: p.exists(),
                path: p.to_string_lossy().into_owned(),
            })
            .collect(),
        shell,
    }
}

/// The first profile file that assigns `var`, with the parsed assignment.
fn locate_in_profiles(var: &str) -> Option<(PathBuf, shell_profile::Assignment)> {
    let home = home_dir()?;
    for path in shell_profile::scan_candidates(&home, &user_shell()) {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        // Last assignment wins — that is what the shell ends up with.
        if let Some(a) = shell_profile::parse_assignments(&content)
            .into_iter()
            .filter(|a| a.var == var)
            .next_back()
        {
            return Some((path, a));
        }
    }
    None
}

fn last4(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

/// Every recognised key Atlas can see, whether it came from a profile file or
/// the ambient environment. Secrets stay in Rust — only `last4` is returned.
#[tauri::command]
pub fn byok_env_entries(app: AppHandle) -> Vec<EnvEntry> {
    ensure_shell_probe(&app);
    let live = env_state().read().by_var.clone();
    let mut out = Vec::new();

    for (provider, var) in known_vars() {
        let located = locate_in_profiles(var);
        // A value can be in a profile, in the live env, or both. Prefer the
        // profile's own text when present: it is what an edit would change.
        let value = match (&located, live.get(var)) {
            (Some((_, a)), _) => a.value.clone(),
            (None, Some(v)) => v.clone(),
            (None, None) => continue,
        };
        if value.trim().is_empty() {
            continue;
        }
        out.push(EnvEntry {
            provider: provider.to_string(),
            env_var: var.to_string(),
            last4: last4(&value),
            file: located.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
            line: located.as_ref().map(|(_, a)| a.line),
            editable: located.is_some(),
        });
    }
    out
}

/// Reveal one key's full value, for the editor's show/copy affordance. Kept off
/// [`byok_env_entries`] so a list render never ships every secret to the webview.
#[tauri::command]
pub fn byok_env_reveal(app: AppHandle, env_var: String) -> Option<String> {
    ensure_shell_probe(&app);
    if let Some((_, a)) = locate_in_profiles(&env_var) {
        return Some(a.value);
    }
    env_state().read().by_var.get(&env_var).cloned()
}

/// Back up a profile once per run before Atlas first modifies it, so a bad edit
/// is always recoverable from a file sitting next to the original.
fn backup_once(path: &Path) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    static DONE: Mutex<Option<std::collections::BTreeSet<PathBuf>>> = Mutex::new(None);
    static POISONED: AtomicBool = AtomicBool::new(false);
    if POISONED.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut guard) = DONE.lock() else {
        POISONED.store(true, Ordering::Relaxed);
        return;
    };
    let set = guard.get_or_insert_with(Default::default);
    if !set.insert(path.to_path_buf()) {
        return;
    }
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("atlas-backup"));
    }
}

/// Write `content` to `path` atomically (temp file + rename), so a crash mid-write
/// can never leave a truncated profile — the difference between a working shell
/// and a broken login.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let created = !path.exists();
    let tmp = path.with_extension("atlas-tmp");
    fs::write(&tmp, content).map_err(|e| format!("write temp: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Match the file we are replacing; a file we create ourselves holds
        // secrets and starts owner-only.
        let mode = fs::metadata(path).ok().map(|m| m.permissions().mode() & 0o777);
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(mode.unwrap_or(0o600)));
    }
    fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))?;
    let _ = created;
    Ok(())
}

/// Reflect a change into the live snapshot + agent env so the running app picks
/// it up without a restart. A new *terminal* still needs a fresh shell, exactly
/// as it would after editing the file by hand.
fn apply_live(app: &AppHandle, var: &str, value: Option<&str>) {
    {
        let mut state = env_state().write();
        match value {
            Some(v) => state.by_var.insert(var.to_string(), v.to_string()),
            None => state.by_var.remove(var),
        };
    }
    // Also update this process's own env so an in-process consumer that reads
    // it directly agrees with the snapshot.
    match value {
        Some(v) => std::env::set_var(var, v),
        None => std::env::remove_var(var),
    }
    sync_agent_key_env(app);
    let _ = app.emit("atlas:byok-env-updated", ());
}

/// Set (or replace) a key in the user's shell profile.
///
/// Rewrites the assignment where it already lives; otherwise appends it to the
/// shell's primary rc file under a marked block.
#[tauri::command]
pub fn byok_env_set(app: AppHandle, env_var: String, value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err("Value is empty.".into());
    }
    if !known_vars().iter().any(|(_, v)| *v == env_var) {
        return Err(format!("'{env_var}' is not a recognised provider key variable."));
    }
    let home = home_dir().ok_or("No home directory.")?;
    let shell = user_shell();

    let path = locate_in_profiles(&env_var)
        .map(|(p, _)| p)
        .unwrap_or_else(|| shell_profile::primary_target(&home, &shell));

    let content = fs::read_to_string(&path).unwrap_or_default();
    let updated = shell_profile::upsert(
        &content,
        &env_var,
        &value,
        ShellKind::from_shell_path(&shell),
    );

    backup_once(&path);
    write_atomic(&path, &updated)?;
    apply_live(&app, &env_var, Some(&value));
    Ok(path.to_string_lossy().into_owned())
}

/// Remove a key's assignment from the profile that defines it.
#[tauri::command]
pub fn byok_env_unset(app: AppHandle, env_var: String) -> Result<(), String> {
    let Some((path, _)) = locate_in_profiles(&env_var) else {
        // Live-env-only: nothing of ours to delete, and we will not guess.
        return Err(
            "This key is set outside your shell profile, so Atlas can't remove it.".into(),
        );
    };
    let content = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let updated = shell_profile::remove(&content, &env_var);

    backup_once(&path);
    write_atomic(&path, &updated)?;
    apply_live(&app, &env_var, None);
    Ok(())
}

/// A provider's key, for the in-process BYOK consumers (Rig model calls, memory
/// summarisation, the code-index Tier-2 pass). `None` if unset.
#[tauri::command]
pub fn byok_get(_app: AppHandle, provider: String) -> Result<Option<String>, String> {
    Ok(env_keys().get(&provider).map(|k| k.key.clone()))
}
