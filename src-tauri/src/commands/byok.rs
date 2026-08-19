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
    probe_shell_vars(&vars)
}

/// The env vars that satisfy a provider, in preference order. Empty for a
/// provider the BYOK table has never heard of.
#[must_use]
pub fn env_vars_for_provider(provider: &str) -> &'static [&'static str] {
    ENV_KEY_VARS
        .iter()
        .find(|(p, _)| *p == provider)
        .map(|(_, vars)| *vars)
        .unwrap_or(&[])
}

/// Where a variable's value was found. Never carries the value itself — the
/// auth UI only ever needs to say "this is set", and routing secrets through an
/// extra surface is how they end up in a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvVarSource {
    /// Exported in the environment Atlas itself was launched with.
    ProcessEnv,
    /// Found by the login-shell probe, i.e. it lives in `~/.zshrc` & friends.
    ShellEnv,
}

/// Whether `name` is set, and where it came from (R5).
///
/// Process env is checked first and wins: a var exported in the terminal that
/// launched Atlas is more current than whatever the shell profile says. Falls
/// back to the cached login-shell probe, which is what makes a key the user put
/// in `~/.zshrc` visible to an app launched from Finder — the case the whole
/// env-BYOK model depends on.
pub fn env_var_source(name: &str) -> Option<EnvVarSource> {
    if std::env::var(name).is_ok_and(|v| !v.trim().is_empty()) {
        return Some(EnvVarSource::ProcessEnv);
    }
    env_state()
        .read()
        .by_var
        .get(name)
        .filter(|v| !v.trim().is_empty())
        .map(|_| EnvVarSource::ShellEnv)
}

/// Probe the login shell for variables the standard [`ENV_KEY_VARS`] sweep does
/// not cover — an agent's `env_var` auth method may name anything.
///
/// Results are merged into the shared cache so a second lookup for the same var
/// is free. Deliberately does nothing when every name is already known: each
/// call costs a `$SHELL -lic` spawn, and the auth modal re-checks on every
/// `atlas:byok-env-updated`.
pub fn ensure_vars_probed(names: &[String]) {
    let unknown: Vec<&str> = {
        let state = env_state().read();
        names
            .iter()
            .filter(|n| !state.by_var.contains_key(n.as_str()))
            .filter(|n| std::env::var(n.as_str()).is_err())
            .map(String::as_str)
            .collect()
    };
    if unknown.is_empty() {
        return;
    }
    let found = probe_shell_vars(&unknown);
    let mut state = env_state().write();
    for (var, value) in found {
        state.by_var.entry(var).or_insert(value);
    }
}

fn probe_shell_vars(vars: &[&str]) -> BTreeMap<String, String> {
    if vars.is_empty() {
        return BTreeMap::new();
    }
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
    /// Where it came from (E1). The distinction is what the user needs in
    /// order to act: a `shell-env` key lives in their profile and persists,
    /// while a `process-env` one only exists because they launched Atlas from a
    /// terminal that had it exported — and will vanish next time they open the
    /// app from Finder.
    pub source: Option<EnvVarSource>,
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
            source: env_var_source(&k.env_var),
        })
        .collect()
}

/// Map the BYOK store onto the env vars agent CLIs read for provider auth.
///
/// **Scope is EVERY spawned agent**, not just the built-ins the name suggests
/// (see `RegistryStore::agent_env`, which consumes this). Marketplace agents
/// mostly authenticate exactly this way and nothing else: `gemini` refuses to
/// open a session with "Gemini API key is missing or not configured" and
/// advertises no runnable login, and `qwen-code` states it "requires setting
/// the `OPENAI_API_KEY` environment variable". While this was built-ins-only,
/// installing them from the marketplace produced an agent that could never
/// start.
///
/// Verified against opencode/kilo's provider docs; cursor uses browser OAuth
/// and ignores these. Google gets both spellings — the Vercel AI SDK stack
/// inside opencode reads `GOOGLE_GENERATIVE_AI_API_KEY`, other tooling
/// (including the Gemini CLI) reads `GEMINI_API_KEY`.
/// Every env-var spelling a stored key for `provider` should be injected under.
///
/// [`ENV_KEY_VARS`] is the single source of truth for BOTH directions —
/// recognising a key the user exported, and handing it to an agent. Keeping two
/// lists is what broke this: injection covered only six providers while the
/// settings page happily stored twenty-two, so a user who saved a Mistral, xAI
/// or DeepSeek key had it accepted and then silently never delivered, and the
/// agent kept insisting it had no credentials.
///
/// Injecting under EVERY recognised spelling (not just a canonical one) is
/// deliberate: agents disagree about names — the Vercel AI SDK stack inside
/// opencode reads `GOOGLE_GENERATIVE_AI_API_KEY`, the Gemini CLI reads
/// `GEMINI_API_KEY`. An extra var an agent doesn't know is inert.
fn inject_vars_for(provider: &str) -> &'static [&'static str] {
    ENV_KEY_VARS
        .iter()
        .find(|(p, _)| *p == provider)
        .map(|(_, vars)| *vars)
        .unwrap_or(&[])
}

fn builtin_agent_env(store: &Store) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    // Stored (keychain) keys for every provider Atlas knows about.
    for (provider, vars) in ENV_KEY_VARS {
        if let Some(k) = store.get(*provider) {
            for var in *vars {
                env.insert((*var).to_string(), k.key.clone());
            }
        }
    }
    // Env-imported keys OVERLAY the stored ones — when both exist for a
    // provider, the environment's own key wins (the settings page surfaces
    // the conflict).
    for (provider, ek) in env_keys() {
        for var in inject_vars_for(provider.as_str()) {
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

#[cfg(test)]
mod agent_env_tests {
    use super::*;

    fn store_with(providers: &[&str]) -> Store {
        providers
            .iter()
            .map(|p| {
                (
                    (*p).to_string(),
                    StoredKey {
                        key: format!("sk-{p}"),
                        last4: "aaaa".into(),
                        added_at: "2026-08-17T00:00:00Z".into(),
                    },
                )
            })
            .collect()
    }

    /// A key the settings page accepts must reach agents. Injection used to
    /// cover six providers while the store accepted all of these, so a saved
    /// Mistral/xAI/DeepSeek key was silently never delivered and the agent went
    /// on claiming it had no credentials.
    #[test]
    fn every_storable_provider_is_injected() {
        for (provider, vars) in ENV_KEY_VARS {
            let env = builtin_agent_env(&store_with(&[provider]));
            assert!(
                !env.is_empty(),
                "{provider} can be stored but is never injected"
            );
            for var in *vars {
                assert_eq!(
                    env.get(*var).map(String::as_str),
                    Some(format!("sk-{provider}").as_str()),
                    "{provider} must be injected as {var}"
                );
            }
        }
    }

    /// Mirrors `detectKeyNeed` in `src/features/chat/lib/agent-key-need.ts`:
    /// the in-app prompt offers to collect keys for exactly these providers, so
    /// each one must actually be deliverable — otherwise the user types a key,
    /// Atlas says "saved", and nothing changes.
    #[test]
    fn the_providers_the_key_prompt_offers_are_all_deliverable() {
        for provider in [
            "google",
            "openai",
            "anthropic",
            "openrouter",
            "xai",
            "mistral",
            "groq",
            "deepseek",
        ] {
            let env = builtin_agent_env(&store_with(&[provider]));
            assert!(!env.is_empty(), "key prompt offers {provider} but it is undeliverable");
        }
    }

    #[test]
    fn google_is_injected_under_both_spellings_agents_use() {
        // opencode's Vercel AI SDK reads GOOGLE_GENERATIVE_AI_API_KEY; the
        // Gemini CLI reads GEMINI_API_KEY. Both, or one of them breaks.
        let env = builtin_agent_env(&store_with(&["google"]));
        assert_eq!(env.get("GEMINI_API_KEY").unwrap(), "sk-google");
        assert_eq!(env.get("GOOGLE_GENERATIVE_AI_API_KEY").unwrap(), "sk-google");
    }

    #[test]
    fn an_empty_store_injects_nothing() {
        // No keys → no env → agents keep the cheap plain-command spawn path.
        assert!(builtin_agent_env(&Store::new()).is_empty());
    }

    #[test]
    fn unknown_providers_are_ignored_rather_than_injected_blindly() {
        // A hand-edited byok-keys.json naming something Atlas has no var
        // mapping for must not invent an env var.
        assert!(builtin_agent_env(&store_with(&["not-a-provider"])).is_empty());
    }
}
