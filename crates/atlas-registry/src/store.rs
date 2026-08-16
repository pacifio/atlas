//! `RegistryStore` — the process-global façade the Tauri layer and
//! `atlas_acp::AgentRegistry` consume. Owns the manifest cache, the install
//! store, and distribution → spawn-command synthesis.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;

use crate::binary::{self, ProgressFn};
use crate::cache::RegistryCache;
use crate::error::{RegistryError, Result};
use crate::install_store::{self, InstallStore, InstalledAgent};
use crate::manifest::{Distribution, RegistryAgent};
use crate::platform::platform_key;

/// Registry entries that duplicate an Atlas first-party agent. `opencode` /
/// `cursor` / `kilo` are literal plugin-id collisions; `claude-acp` /
/// `codex-acp` are the same adapters `claude-code-ts` / `codex` already launch
/// via npx. All five surface as "Built-in" in the marketplace and are never
/// installable — an install would shadow the first-party spec.
pub const BUILTIN_REGISTRY_IDS: &[&str] = &["claude-acp", "codex-acp", "opencode", "cursor", "kilo"];

#[derive(Clone)]
pub struct RegistryStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    cache: RegistryCache,
    installs: RwLock<InstallStore>,
    install_path: PathBuf,
    /// Extracted-binary root: `<app_data>/external-agents/`.
    binaries_root: PathBuf,
    /// Serializes concurrent downloads of the same agent (two windows
    /// installing / self-healing at once).
    download_locks: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// Auto-acquired binaries for the built-ins with no npx distribution
    /// (`atlas_acp::AUTO_MANAGED_BUILTIN_IDS`), keyed by id. Deliberately NOT
    /// persisted: these are not installs, so they never touch
    /// `installed.json`. The on-disk extract under `binaries_root` is the real
    /// cache — this map is just the resolved entry point, refilled from that
    /// extract (no download) by the first `ensure_builtin` after launch.
    builtin_binaries: DashMap<String, install_store::ResolvedBinary>,
    /// Extra env vars injected into the auto-managed built-ins' spawn specs —
    /// Atlas's BYOK keys mapped to the env vars those CLIs read
    /// (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Set by the host at boot and
    /// whenever a key is added/removed; a manifest-declared env var of the
    /// same name wins. Applies from the NEXT spawn — live agents keep the env
    /// they started with.
    builtin_env: RwLock<HashMap<String, String>>,
}

/// One agent as the marketplace sees it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntryView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub icon_data_url: Option<String>,
    pub installed: bool,
    /// Duplicates a first-party Atlas agent — not installable.
    pub builtin: bool,
    pub platform_supported: bool,
    /// "" when unsupported; else "binary" | "npx" | "uvx".
    pub distribution_kind: String,
    /// Binary distribution with no published sha256.
    pub unverified: bool,
    /// Why `platform_supported` is false (e.g. "requires uv").
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryListing {
    pub entries: Vec<RegistryEntryView>,
    pub last_refreshed_at: Option<String>,
    pub last_error: Option<String>,
}

impl RegistryStore {
    /// Synchronous cache-first construction — safe in app setup; the listing
    /// is servable before any network refresh.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let registry_dir = app_data_dir.join("agent-registry");
        let install_path = registry_dir.join("installed.json");
        Self {
            inner: Arc::new(StoreInner {
                cache: RegistryCache::load(registry_dir),
                installs: RwLock::new(install_store::load(&install_path)),
                install_path,
                binaries_root: app_data_dir.join("external-agents"),
                download_locks: DashMap::new(),
                builtin_binaries: DashMap::new(),
                builtin_env: RwLock::new(HashMap::new()),
            }),
        }
    }

    pub async fn refresh(&self, force: bool) -> Result<()> {
        self.inner.cache.refresh(force).await?;
        self.inner.cache.fetch_missing_icons().await;
        Ok(())
    }

    pub fn list(&self) -> RegistryListing {
        let manifest = self.inner.cache.manifest();
        let installs = self.inner.installs.read();
        let mut entries: Vec<RegistryEntryView> = manifest
            .map(|m| m.agents)
            .unwrap_or_default()
            .iter()
            .map(|agent| self.entry_view(agent, &installs))
            .collect();
        // Installed agents that dropped out of the upstream manifest must not
        // vanish from the marketplace (they're still runnable/uninstallable).
        for inst in installs.installed.values().filter(|i| i.is_active()) {
            if !entries.iter().any(|e| e.id == inst.id) {
                entries.push(self.orphan_view(inst));
            }
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        RegistryListing {
            entries,
            last_refreshed_at: self
                .inner
                .cache
                .last_refreshed_at()
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
            last_error: self.inner.cache.last_error(),
        }
    }

    /// Metadata for any id ever known (manifest ∪ install store, active or
    /// not) — the timeline/memory fallback for uninstalled-but-captured agents.
    pub fn metadata_for(&self, id: &str) -> Option<RegistryEntryView> {
        if let Some(agent) = self.inner.cache.agent(id) {
            let installs = self.inner.installs.read();
            return Some(self.entry_view(&agent, &installs));
        }
        let installs = self.inner.installs.read();
        installs.installed.get(id).map(|inst| self.orphan_view(inst))
    }

    pub fn icon_data_url(&self, id: &str) -> Option<String> {
        let path = self.inner.cache.icon_path(id)?;
        let bytes = std::fs::read(path).ok()?;
        // Many registry icons paint with `currentColor` (they're designed for
        // inline tinting, which is how Zed renders them). Atlas delivers them
        // as `<img src="data:...">`, where an SVG has no CSS color context and
        // `currentColor` computes to BLACK — invisible on the dark theme, so
        // whole cards looked icon-less. Bake in a neutral light gray instead.
        let svg = String::from_utf8_lossy(&bytes).replace("currentColor", "#c9c9c9");
        use base64::Engine as _;
        Some(format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
        ))
    }

    /// Install `id`: freeze its distribution into the install store, then (for
    /// binary distributions) eagerly download+extract with progress. npx/uvx
    /// distributions have no eager step — npm/uv cache on first spawn.
    pub async fn install(&self, id: &str, progress: Option<&ProgressFn>) -> Result<InstalledAgent> {
        if BUILTIN_REGISTRY_IDS.contains(&id) {
            return Err(RegistryError::UnknownAgent(format!(
                "{id} is built into Atlas and cannot be installed from the registry"
            )));
        }
        let agent = self
            .inner
            .cache
            .agent(id)
            .ok_or_else(|| RegistryError::UnknownAgent(id.to_string()))?;
        let kind = distribution_kind(&agent.distribution);
        if kind.is_none() {
            return Err(RegistryError::UnsupportedPlatform {
                id: id.to_string(),
                reason: unsupported_reason(&agent.distribution),
            });
        }

        let mut installed = InstalledAgent {
            id: agent.id.clone(),
            name: agent.name.clone(),
            version: agent.version.clone(),
            description: agent.description.clone(),
            repository: agent.repository.clone(),
            website: agent.website.clone(),
            distribution: agent.distribution.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            uninstalled_at: None,
            resolved_binary: None,
        };

        if let Some(target) = platform_binary(&agent.distribution) {
            let _guard = self.download_lock(id).lock_owned().await;
            let resolved = binary::ensure_binary(
                &self.inner.binaries_root,
                &agent.id,
                &agent.version,
                target,
                progress,
            )
            .await?;
            installed.resolved_binary = Some(resolved);
        }

        {
            let mut installs = self.inner.installs.write();
            installs.installed.insert(agent.id.clone(), installed.clone());
            install_store::save(&self.inner.install_path, &installs);
        }
        Ok(installed)
    }

    pub fn uninstall(&self, id: &str, purge_cache: bool) -> Result<()> {
        let mut installs = self.inner.installs.write();
        let entry = installs
            .installed
            .get_mut(id)
            .ok_or_else(|| RegistryError::NotInstalled(id.to_string()))?;
        entry.uninstalled_at = Some(chrono::Utc::now().to_rfc3339());
        if purge_cache {
            if let Some(resolved) = entry.resolved_binary.take() {
                let _ = std::fs::remove_dir_all(&resolved.cache_dir);
            }
        }
        install_store::save(&self.inner.install_path, &installs);
        Ok(())
    }

    /// Self-heal hook run before spawning an external agent: re-download a
    /// binary payload that went missing (killed mid-install, cache purge, app
    /// data migration). No-op for npx/uvx and healthy binary installs.
    pub async fn ensure_ready(&self, id: &str) -> Result<()> {
        let (version, target) = {
            let installs = self.inner.installs.read();
            let Some(inst) = installs.installed.get(id).filter(|i| i.is_active()) else {
                return Ok(()); // not an external agent — nothing to do
            };
            match platform_binary(&inst.distribution) {
                Some(target) => (inst.version.clone(), target.clone()),
                None => return Ok(()),
            }
        };
        let _guard = self.download_lock(id).lock_owned().await;
        let resolved =
            binary::ensure_binary(&self.inner.binaries_root, id, &version, &target, None).await?;
        let mut installs = self.inner.installs.write();
        if let Some(inst) = installs.installed.get_mut(id) {
            inst.resolved_binary = Some(resolved);
            install_store::save(&self.inner.install_path, &installs);
        }
        Ok(())
    }

    /// Acquire the managed binary for a built-in agent that has no npx
    /// distribution — cursor / opencode / kilo, i.e.
    /// `atlas_acp::AUTO_MANAGED_BUILTIN_IDS`. Claude and Codex spawn via
    /// `npx -y …`, so npm fetches their adapter on first run; these three are
    /// plain CLIs, and on a machine that never installed them by hand they
    /// cannot spawn at all. This closes that gap the way Zed does: the
    /// official per-platform archive from the registry manifest, downloaded
    /// on demand and cached.
    ///
    /// Cache-first — a completed extract is reused (no network), otherwise the
    /// archive is downloaded and extracted NOW, so the caller must expect this
    /// to be slow on a cold cache. sha256 is verified whenever the manifest
    /// publishes one (kilo/opencode do; cursor does not, so it installs
    /// unverified — same as Zed).
    ///
    /// **Never fails a spawn.** Manifest not fetched yet, no binary for this
    /// platform, offline, checksum mismatch — every failure just leaves the
    /// built-in's bare-CLI command in place, which is exactly the behaviour
    /// that existed before (spawn then fails with `explain_spawn_failure`'s
    /// install hint). Returns whether a managed binary is now available.
    pub async fn ensure_builtin(&self, id: &str, progress: Option<&ProgressFn>) -> bool {
        if !atlas_acp::AUTO_MANAGED_BUILTIN_IDS.contains(&id) {
            return false;
        }
        if self.inner.builtin_binaries.contains_key(id) {
            return true;
        }
        let Some(agent) = self.inner.cache.agent(id) else {
            tracing::debug!(
                target: "atlas_registry",
                "built-in {id}: no manifest entry (yet) — using its PATH command"
            );
            return false;
        };
        let Some(target) = platform_binary(&agent.distribution) else {
            tracing::debug!(
                target: "atlas_registry",
                "built-in {id}: no binary published for {} — using its PATH command",
                platform_key()
            );
            return false;
        };
        let _guard = self.download_lock(id).lock_owned().await;
        // Re-check under the lock: a concurrent spawn may have just finished
        // the same download.
        if self.inner.builtin_binaries.contains_key(id) {
            return true;
        }
        match binary::ensure_binary(
            &self.inner.binaries_root,
            id,
            &agent.version,
            target,
            progress,
        )
        .await
        {
            Ok(resolved) => {
                self.inner.builtin_binaries.insert(id.to_string(), resolved);
                true
            }
            Err(e) => {
                tracing::warn!(
                    target: "atlas_registry",
                    "built-in {id}: managed binary unavailable ({e}) — falling back to its PATH command"
                );
                false
            }
        }
    }

    /// Whether `id`'s managed built-in binary is acquired and ready to spawn.
    pub fn builtin_ready(&self, id: &str) -> bool {
        self.inner.builtin_binaries.contains_key(id)
    }

    /// Absolute path to `id`'s managed built-in executable, once acquired.
    ///
    /// Exists so the host can run the agent's OWN CLI for side flows the ACP
    /// session can't cover — signing in, above all. These binaries live in
    /// Atlas's app-data dir and never land on `PATH`, so this is the only way
    /// anything outside the spawn path can reach them.
    pub fn builtin_binary_path(&self, id: &str) -> Option<String> {
        self.inner
            .builtin_binaries
            .get(id)
            .map(|r| r.entry_cmd.clone())
    }

    pub fn is_installed(&self, id: &str) -> bool {
        self.inner
            .installs
            .read()
            .installed
            .get(id)
            .is_some_and(|i| i.is_active())
    }

    /// Spawnable specs for the active installed agents — consumed by
    /// `atlas_acp::AgentRegistry` via the `SpecSource` trait.
    pub fn installed_specs(&self) -> Vec<atlas_acp::AgentSpec> {
        let installs = self.inner.installs.read();
        installs
            .installed
            .values()
            .filter(|i| i.is_active())
            .filter_map(|inst| self.spec_for(inst))
            .collect()
    }

    /// Specs carrying the acquired binary command for auto-managed built-ins.
    /// Only `command` is consumed downstream — `AgentRegistry::known_specs`
    /// grafts it onto the built-in's existing entry and keeps Atlas's own
    /// display name, so these placeholder names are never shown.
    fn builtin_specs(&self) -> Vec<atlas_acp::AgentSpec> {
        let extra_env = self.inner.builtin_env.read().clone();
        self.inner
            .builtin_binaries
            .iter()
            .map(|e| atlas_acp::AgentSpec {
                spec_id: e.key().clone(),
                display_name: e.key().clone(),
                command: binary_command(e.key(), e.value(), &extra_env),
                help_url: None,
            })
            .collect()
    }

    /// Replace the BYOK-derived env injected into the auto-managed built-ins'
    /// spawn specs (see `builtin_env` on the inner state).
    pub fn set_builtin_env(&self, env: HashMap<String, String>) {
        *self.inner.builtin_env.write() = env;
    }

    fn spec_for(&self, inst: &InstalledAgent) -> Option<atlas_acp::AgentSpec> {
        let command = synthesize_command(&self.inner.binaries_root, inst)?;
        Some(atlas_acp::AgentSpec {
            spec_id: inst.id.clone(),
            display_name: inst.name.clone(),
            command,
            help_url: inst.repository.clone().or_else(|| inst.website.clone()),
        })
    }

    fn download_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .download_locks
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn entry_view(&self, agent: &RegistryAgent, installs: &InstallStore) -> RegistryEntryView {
        let kind = distribution_kind(&agent.distribution);
        let unverified = platform_binary(&agent.distribution)
            .map(|t| t.sha256.is_none())
            .unwrap_or(false);
        RegistryEntryView {
            id: agent.id.clone(),
            name: agent.name.clone(),
            version: agent.version.clone(),
            description: agent.description.clone(),
            repository: agent.repository.clone(),
            website: agent.website.clone(),
            icon_data_url: self.icon_data_url(&agent.id),
            installed: installs.installed.get(&agent.id).is_some_and(|i| i.is_active()),
            builtin: BUILTIN_REGISTRY_IDS.contains(&agent.id.as_str()),
            platform_supported: kind.is_some(),
            distribution_kind: kind.map(str::to_string).unwrap_or_default(),
            unverified,
            unsupported_reason: kind
                .is_none()
                .then(|| unsupported_reason(&agent.distribution)),
        }
    }

    /// View for an installed agent no longer present in the manifest.
    fn orphan_view(&self, inst: &InstalledAgent) -> RegistryEntryView {
        let kind = distribution_kind(&inst.distribution);
        RegistryEntryView {
            id: inst.id.clone(),
            name: inst.name.clone(),
            version: inst.version.clone(),
            description: inst.description.clone(),
            repository: inst.repository.clone(),
            website: inst.website.clone(),
            icon_data_url: self.icon_data_url(&inst.id),
            installed: inst.is_active(),
            builtin: false,
            platform_supported: kind.is_some(),
            distribution_kind: kind.map(str::to_string).unwrap_or_default(),
            unverified: false,
            unsupported_reason: None,
        }
    }
}

impl atlas_acp::SpecSource for RegistryStore {
    /// Installed externals first, auto-managed built-ins LAST — deliberately.
    /// One id can have both (a machine that installed OpenCode from the
    /// marketplace before it shipped as a built-in still carries that install
    /// record), and `known_specs` applies these in order, so the last write
    /// wins. The managed built-in is the one that tracks the current manifest
    /// version; an install record is frozen at install time and would pin a
    /// stale binary.
    fn extra_specs(&self) -> Vec<atlas_acp::AgentSpec> {
        let mut specs = self.installed_specs();
        specs.extend(self.builtin_specs());
        specs
    }
}

fn platform_binary(dist: &Distribution) -> Option<&crate::manifest::BinaryTarget> {
    dist.binary.as_ref()?.get(platform_key())
}

/// Preferred usable distribution for this platform: binary > npx > uvx
/// (mirrors Zed, uvx appended). `None` = nothing runnable here.
fn distribution_kind(dist: &Distribution) -> Option<&'static str> {
    if platform_binary(dist).is_some() {
        return Some("binary");
    }
    if dist.npx.is_some() {
        return Some("npx");
    }
    if dist.uvx.is_some() {
        // uvx needs uv on the machine; surfaced as supported and failing with
        // a clear hint at spawn if uv is absent (matches how npx agents
        // behave when Node is missing).
        return Some("uvx");
    }
    None
}

fn unsupported_reason(dist: &Distribution) -> String {
    if dist.binary.is_some() {
        format!("no binary published for {}", platform_key())
    } else {
        "no usable distribution".to_string()
    }
}

/// Distribution → shell-words command string (or JSON stdio spec when the
/// target needs env vars / an absolute pre-resolved program).
fn synthesize_command(binaries_root: &std::path::Path, inst: &InstalledAgent) -> Option<String> {
    if let Some(target) = platform_binary(&inst.distribution) {
        let resolved = match &inst.resolved_binary {
            Some(r) => r.clone(),
            // Not yet downloaded (interrupted install): compute the
            // deterministic paths anyway — `ensure_ready` heals before spawn,
            // and if it couldn't, the spawn error carries the help_url hint.
            None => install_store::ResolvedBinary {
                cache_dir: binary::versioned_cache_dir(
                    binaries_root,
                    &inst.id,
                    &inst.version,
                    &target.archive,
                )
                .to_string_lossy()
                .into_owned(),
                entry_cmd: if target.cmd == "node" {
                    "node".to_string()
                } else {
                    std::path::Path::new(&binary::versioned_cache_dir(
                        binaries_root,
                        &inst.id,
                        &inst.version,
                        &target.archive,
                    ))
                    .join(target.cmd.trim_start_matches("./"))
                    .to_string_lossy()
                    .into_owned()
                },
                args: target.args.clone(),
                env: target.env.clone(),
            },
        };
        // Marketplace-installed externals get no BYOK env injection — that is
        // scoped to the auto-managed built-ins (see `builtin_specs`).
        return Some(binary_command(&inst.id, &resolved, &HashMap::new()));
    }
    if let Some(pkg) = &inst.distribution.npx {
        return Some(package_command("npx -y", &pkg.package, &pkg.args, &pkg.env, &inst.id));
    }
    if let Some(pkg) = &inst.distribution.uvx {
        return Some(package_command("uvx", &pkg.package, &pkg.args, &pkg.env, &inst.id));
    }
    None
}

/// A downloaded binary's entry point → the JSON stdio spec the SDK spawns.
/// `"node"` entries resolve through the (possibly Atlas-managed) toolchain;
/// anything else is already an absolute path inside the extract dir.
fn binary_command(
    id: &str,
    resolved: &install_store::ResolvedBinary,
    extra_env: &HashMap<String, String>,
) -> String {
    let program = if resolved.entry_cmd == "node" {
        atlas_acp::resolve_program("node").unwrap_or_else(|| "node".to_string())
    } else {
        resolved.entry_cmd.clone()
    };
    // BYOK-derived keys first, then the manifest's own env on top — an env var
    // the registry manifest declares always beats the injected key.
    let mut env = extra_env.clone();
    env.extend(resolved.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    json_stdio_spec(id, &program, &resolved.args, &env)
}

fn package_command(
    runner: &str,
    package: &str,
    args: &[String],
    env: &HashMap<String, String>,
    id: &str,
) -> String {
    if env.is_empty() {
        // Plain shell-words string → `atlas_acp::spawn::resolve_command`
        // applies its full login-shell/managed-node resolution.
        let mut cmd = format!("{runner} {package}");
        for arg in args {
            cmd.push(' ');
            cmd.push_str(arg);
        }
        return cmd;
    }
    // Env vars only travel via the JSON stdio spec; resolve the runner to an
    // absolute path ourselves since resolve_command skips JSON specs.
    let program_name = runner.split_whitespace().next().unwrap_or(runner);
    let program =
        atlas_acp::resolve_program(program_name).unwrap_or_else(|| program_name.to_string());
    let mut full_args: Vec<String> = runner
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect();
    full_args.push(package.to_string());
    full_args.extend(args.iter().cloned());
    json_stdio_spec(id, &program, &full_args, env)
}

/// The SDK-side `{ "type": "stdio", ... }` spec — same shape
/// `atlas_acp::spawn::resolve_command` emits for managed-node commands. PATH
/// is always included (managed Node bin prepended when registered) so the
/// agent's children resolve the same toolchain.
fn json_stdio_spec(
    name: &str,
    program: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> String {
    let mut path = std::env::var("PATH").unwrap_or_default();
    if let Some(bin) = atlas_acp::managed_node_bin() {
        path = format!("{}:{path}", bin.to_string_lossy());
    }
    let mut env_list: Vec<serde_json::Value> = vec![serde_json::json!({
        "name": "PATH",
        "value": path,
    })];
    for (k, v) in env {
        env_list.push(serde_json::json!({ "name": k, "value": v }));
    }
    serde_json::json!({
        "type": "stdio",
        "name": name,
        "command": program,
        "args": args,
        "env": env_list,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{BinaryTarget, PackageTarget, RegistryManifest};

    fn installed(dist: Distribution) -> InstalledAgent {
        InstalledAgent {
            id: "test-agent".into(),
            name: "Test Agent".into(),
            version: "1.0.0".into(),
            description: None,
            repository: Some("https://github.com/x/y".into()),
            website: None,
            distribution: dist,
            installed_at: "2026-08-14T00:00:00Z".into(),
            uninstalled_at: None,
            resolved_binary: None,
        }
    }

    #[test]
    fn npx_without_env_synthesizes_plain_command() {
        let inst = installed(Distribution {
            binary: None,
            npx: Some(PackageTarget {
                package: "some-acp@1.0.0".into(),
                args: vec!["--acp".into()],
                env: HashMap::new(),
            }),
            uvx: None,
        });
        let cmd = synthesize_command(std::path::Path::new("/tmp"), &inst).unwrap();
        assert_eq!(cmd, "npx -y some-acp@1.0.0 --acp");
    }

    #[test]
    fn binary_synthesizes_json_stdio_spec_with_env() {
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        let mut binaries = HashMap::new();
        binaries.insert(
            platform_key().to_string(),
            BinaryTarget {
                archive: "https://x/y.tar.gz".into(),
                cmd: "./agent".into(),
                args: vec!["acp".into()],
                env,
                sha256: None,
            },
        );
        let inst = installed(Distribution {
            binary: Some(binaries),
            npx: None,
            uvx: None,
        });
        let cmd = synthesize_command(std::path::Path::new("/tmp/root"), &inst).unwrap();
        let spec: serde_json::Value = serde_json::from_str(&cmd).unwrap();
        assert_eq!(spec["type"], "stdio");
        assert!(spec["command"].as_str().unwrap().ends_with("/agent"));
        assert!(spec["env"].as_array().unwrap().iter().any(|e| e["name"] == "FOO"));
    }

    fn empty_store() -> (RegistryStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (RegistryStore::new(dir.path().to_path_buf()), dir)
    }

    #[tokio::test]
    async fn ensure_builtin_ignores_agents_that_are_not_auto_managed() {
        // Claude/Codex ship via npx and must never take this path; neither may
        // an arbitrary registry id.
        let (store, _dir) = empty_store();
        assert!(!store.ensure_builtin("claude-code-ts", None).await);
        assert!(!store.ensure_builtin("codex", None).await);
        assert!(!store.ensure_builtin("amp-acp", None).await);
    }

    #[tokio::test]
    async fn ensure_builtin_falls_back_when_no_manifest_is_cached() {
        // Offline first launch: no manifest → no managed binary, no error, and
        // the built-in keeps its bare PATH command.
        let (store, _dir) = empty_store();
        for id in atlas_acp::AUTO_MANAGED_BUILTIN_IDS {
            assert!(!store.ensure_builtin(id, None).await, "{id} must not resolve");
            assert!(!store.builtin_ready(id));
        }
        assert!(<RegistryStore as atlas_acp::SpecSource>::extra_specs(&store).is_empty());
    }

    #[tokio::test]
    async fn ensure_builtin_falls_back_when_the_platform_has_no_binary() {
        // The manifest knows cursor, but publishes nothing runnable here —
        // no download is attempted and the bare PATH command stands.
        let (store, _dir) = empty_store();
        store.inner.cache.set_manifest_for_tests(RegistryManifest {
            version: "1.0.0".into(),
            agents: vec![RegistryAgent {
                id: "cursor".into(),
                name: "Cursor".into(),
                version: "2026.08.11".into(),
                description: None,
                repository: None,
                website: None,
                authors: None,
                license: None,
                icon: None,
                distribution: Distribution {
                    // Deliberately a platform we are not running on.
                    binary: Some(HashMap::from([(
                        "some-other-platform".to_string(),
                        BinaryTarget {
                            archive: "https://example.invalid/x.tar.gz".into(),
                            cmd: "./cursor-agent".into(),
                            args: vec!["acp".into()],
                            env: HashMap::new(),
                            sha256: None,
                        },
                    )])),
                    npx: None,
                    uvx: None,
                },
            }],
        });
        assert!(!store.ensure_builtin("cursor", None).await);
        assert!(!store.builtin_ready("cursor"));
    }

    #[test]
    fn acquired_builtin_is_offered_as_a_spec_carrying_the_binary_command() {
        let (store, _dir) = empty_store();
        store.inner.builtin_binaries.insert(
            "cursor".to_string(),
            install_store::ResolvedBinary {
                cache_dir: "/tmp/root/cursor/v1".into(),
                entry_cmd: "/tmp/root/cursor/v1/dist-package/cursor-agent".into(),
                args: vec!["acp".into()],
                env: HashMap::new(),
            },
        );
        let specs = <RegistryStore as atlas_acp::SpecSource>::extra_specs(&store);
        let cursor = specs.iter().find(|s| s.spec_id == "cursor").unwrap();
        let spec: serde_json::Value = serde_json::from_str(&cursor.command).unwrap();
        assert_eq!(spec["command"], "/tmp/root/cursor/v1/dist-package/cursor-agent");
        assert_eq!(spec["args"][0], "acp");
    }

    #[test]
    fn managed_builtin_binary_outranks_a_stale_install_record() {
        // Seen live: a machine that installed OpenCode from the marketplace
        // before it shipped as a built-in has BOTH an install record and a
        // managed binary. The managed one tracks the current manifest version
        // and must be the command that survives into `known_specs`.
        let (store, _dir) = empty_store();
        let mut binaries = HashMap::new();
        binaries.insert(
            platform_key().to_string(),
            BinaryTarget {
                archive: "https://x/opencode-old.zip".into(),
                cmd: "./opencode".into(),
                args: vec!["acp".into()],
                env: HashMap::new(),
                sha256: None,
            },
        );
        let mut stale = installed(Distribution {
            binary: Some(binaries),
            npx: None,
            uvx: None,
        });
        stale.id = "opencode".into();
        stale.resolved_binary = Some(install_store::ResolvedBinary {
            cache_dir: "/stale".into(),
            entry_cmd: "/stale/opencode".into(),
            args: vec!["acp".into()],
            env: HashMap::new(),
        });
        store
            .inner
            .installs
            .write()
            .installed
            .insert("opencode".into(), stale);
        store.inner.builtin_binaries.insert(
            "opencode".to_string(),
            install_store::ResolvedBinary {
                cache_dir: "/fresh".into(),
                entry_cmd: "/fresh/opencode".into(),
                args: vec!["acp".into()],
                env: HashMap::new(),
            },
        );

        let acp = atlas_acp::AgentRegistry::with_spec_source(Arc::new(store));
        let specs = acp.known_specs();
        let opencode: Vec<_> = specs.iter().filter(|s| s.spec_id == "opencode").collect();
        assert_eq!(opencode.len(), 1, "one entry per agent");
        let cmd: serde_json::Value = serde_json::from_str(&opencode[0].command).unwrap();
        assert_eq!(cmd["command"], "/fresh/opencode");
    }
}
