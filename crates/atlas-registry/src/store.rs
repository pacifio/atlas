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
    fn extra_specs(&self) -> Vec<atlas_acp::AgentSpec> {
        self.installed_specs()
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
        let program = if resolved.entry_cmd == "node" {
            atlas_acp::resolve_program("node").unwrap_or_else(|| "node".to_string())
        } else {
            resolved.entry_cmd.clone()
        };
        return Some(json_stdio_spec(&inst.id, &program, &resolved.args, &resolved.env));
    }
    if let Some(pkg) = &inst.distribution.npx {
        return Some(package_command("npx -y", &pkg.package, &pkg.args, &pkg.env, &inst.id));
    }
    if let Some(pkg) = &inst.distribution.uvx {
        return Some(package_command("uvx", &pkg.package, &pkg.args, &pkg.env, &inst.id));
    }
    None
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
    use crate::manifest::{BinaryTarget, PackageTarget};

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
}
