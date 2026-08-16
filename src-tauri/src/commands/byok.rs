//! BYOK (bring-your-own-key) storage for AI provider API keys.
//!
//! Keys are stored in a single JSON file in the app's private config dir
//! (`byok-keys.json`, `0600` on unix). We deliberately do NOT use the OS
//! keychain: on macOS an unsigned / frequently-rebuilt binary triggers a
//! Keychain permission prompt on *every* access, which is unusable. The config
//! dir is already app-private; this keeps key access prompt-free.
//!
//! The frontend only ever receives metadata via `byok_list` (provider + last-4
//! + added-at); the raw key is returned solely by `byok_get`, which the
//! Model-Chat runtime calls to configure the AI SDK provider.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Stored record for one provider (key + display metadata).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKey {
    key: String,
    last4: String,
    added_at: String,
}

type Store = BTreeMap<String, StoredKey>;

/// Non-secret per-provider metadata the UI reads (no key material).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyMeta {
    pub provider: String,
    pub last4: String,
    pub added_at: String,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join("byok-keys.json"))
}

fn read_store(app: &AppHandle) -> Store {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // Best-effort lock down to owner-only on unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

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
        sync_builtin_agent_env(&app);
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

/// Map the BYOK store onto the env vars the auto-managed built-in agent CLIs
/// read (verified against opencode/kilo's provider docs; cursor uses browser
/// OAuth and ignores these). Google gets both spellings — the Vercel AI SDK
/// stack inside opencode reads `GOOGLE_GENERATIVE_AI_API_KEY`, other tooling
/// reads `GEMINI_API_KEY`.
fn builtin_agent_env(store: &Store) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    let mut add = |provider: &str, vars: &[&str]| {
        if let Some(k) = store.get(provider) {
            for var in vars {
                env.insert((*var).to_string(), k.key.clone());
            }
        }
    };
    add("anthropic", &["ANTHROPIC_API_KEY"]);
    add("openai", &["OPENAI_API_KEY"]);
    add("openrouter", &["OPENROUTER_API_KEY"]);
    add("google", &["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);
    add("groq", &["GROQ_API_KEY"]);
    add("deepinfra", &["DEEPINFRA_API_KEY"]);
    // Env-imported keys OVERLAY the stored ones — when both exist for a
    // provider, the environment's own key wins (the settings page surfaces
    // the conflict). Injected under every var spelling the CLIs read, not
    // just the one it was found as (GEMINI vs GOOGLE_GENERATIVE_AI).
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
    for (provider, ek) in env_keys() {
        for var in inject_vars(provider.as_str()) {
            env.insert((*var).to_string(), ek.key.clone());
        }
    }
    env
}

/// Push the current BYOK keys into the registry store's built-in spawn env so
/// opencode/kilo work out of the box with Atlas-configured keys — the clean
/// alternative to their interactive `auth login` TUI, which Atlas cannot
/// drive (it spawns login subprocesses with stdin closed). Called at boot and
/// after every key add/remove; live agents keep their env until respawned.
pub fn sync_builtin_agent_env(app: &AppHandle) {
    if let Some(registry) = app.try_state::<atlas_registry::RegistryStore>() {
        registry.set_builtin_env(builtin_agent_env(&read_store(app)));
    }
}

/// List configured providers (metadata only — no secrets).
#[tauri::command]
pub fn byok_list(app: AppHandle) -> Vec<ProviderKeyMeta> {
    read_store(&app)
        .into_iter()
        .map(|(provider, v)| ProviderKeyMeta {
            provider,
            last4: v.last4,
            added_at: v.added_at,
        })
        .collect()
}

/// Store/replace a provider's API key + metadata. `last4` is computed by the
/// frontend so we never have to slice the key here.
#[tauri::command]
pub fn byok_set(
    app: AppHandle,
    provider: String,
    key: String,
    last4: String,
    added_at: String,
) -> Result<(), String> {
    let mut store = read_store(&app);
    store.insert(provider, StoredKey { key, last4, added_at });
    write_store(&app, &store)?;
    sync_builtin_agent_env(&app);
    Ok(())
}

/// Remove a provider's key.
#[tauri::command]
pub fn byok_delete(app: AppHandle, provider: String) -> Result<(), String> {
    let mut store = read_store(&app);
    store.remove(&provider);
    write_store(&app, &store)?;
    sync_builtin_agent_env(&app);
    Ok(())
}

/// Read a provider's actual key (for the Model-Chat runtime). `None` if unset.
///
/// Env-imported keys take priority over stored ones — the same rule the
/// built-in agent injection uses, and what the settings page's conflict
/// warning promises. Non-blocking: reads the current snapshot; a
/// profile-only key can be missed in the first ~seconds after launch (before
/// the background shell probe lands), in which case the stored key answers.
#[tauri::command]
pub fn byok_get(app: AppHandle, provider: String) -> Result<Option<String>, String> {
    if let Some(ek) = env_keys().get(&provider) {
        return Ok(Some(ek.key.clone()));
    }
    Ok(read_store(&app).get(&provider).map(|v| v.key.clone()))
}
