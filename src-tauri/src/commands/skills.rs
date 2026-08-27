//! Skills feature — Phase 1 backend (on-disk authoring + multi-agent enable).
//!
//! Atlas manages agent "skills" the same way the `skills` CLI and Zed do: a
//! single **canonical store** — `~/.agents/skills` (global) / `<project>/.agents/skills`
//! (project) — holds the authored `SKILL.md`, and each agent that should "see"
//! the skill gets a **symlink** into its own skills directory. Disk *is* the
//! state — there is no separate enable/disable file. See
//! `docs/adr/0003-agents-skills-is-the-canonical-store-acp-advertisement-is-the-picker.md`:
//! Atlas does not run its own second store anymore, it reads/writes the same
//! `.agents/skills` tree skills.sh and Zed already use.
//!
//! ```text
//! canonical (= installed, managed by Atlas):
//!   <root>/.agents/skills/<name>/SKILL.md
//! enablement (= symlink present, what the agent reads):
//!   <root>/.claude/skills/<name> -> ../../.agents/skills/<name>
//! ```
//!
//! `<root>` is the home dir (global scope) or the project path (project scope).
//! The agent registry is a static table for v1 (Claude Code + Codex); detection
//! is "does the agent's config dir exist under `<root>`?". Note Codex's own
//! *project*-scope skills dir was already `.agents/skills` before this store
//! converged onto the same path — see [`project`]'s native-location guard.
//!
//! Discovery also surfaces **external** skills: real directories (or symlinks
//! to directories, e.g. a skills.sh/Zed projection) that live directly in an
//! agent's skills dir (e.g. `~/.claude/skills/<name>/SKILL.md`) and are not the
//! canonical store's own entries. These are `managed = false`; the "Make for
//! all agents" (adopt) command copies them into the canonical store and fans
//! them out to every detected agent via symlink.
//!
//! A pre-convergence Atlas install may still have content sitting in the old
//! `.atlas/skills` store; [`migrate_legacy_skills`] moves it into the new
//! canonical store the first time it's discovered.
//!
//! A fourth, read-only discovery channel — [`list_plugin_skills`] — surfaces
//! Claude Code plugin marketplace skills (`~/.claude/plugins/marketplaces/*/skills/`)
//! purely for the Skills UI's browsing surface; they are never installable or
//! projectable through Atlas (ADR 0003).
//!
//! Security: skill names are sanitized and every resolved path is verified to
//! stay inside `<root>/.agents/skills` so a crafted name can't escape via `..`.
//!
//! Mirrors conventions from `byok.rs` (`#[tauri::command]` + `Result<T,String>`),
//! `shared_memory.rs` (atomic tmp+rename writes), and `agent_memory.rs`
//! (minimal hand-rolled YAML frontmatter — no new YAML crate).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use serde::{Deserialize, Serialize};

// ── Data model ─────────────────────────────────────────────────────────────────

/// Non-secret metadata for one installed skill (what the list view renders).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// Registry agent ids that currently have a symlink to this skill.
    pub enabled_agents: Vec<String>,
    /// Absolute path to the canonical `SKILL.md`.
    pub path: String,
    /// Capability tier from the registry (default `"native-dir"`).
    pub delivery: String,
    /// `true` when this skill exists in the canonical `.agents/skills` store
    /// (Atlas authored/adopted it, or it was placed there by skills.sh/Zed/another
    /// tool — the store is shared). `false` for external skills that only exist
    /// as a real directory inside one or more agent skills dirs.
    pub managed: bool,
    /// When this skill is *provided by an installed pack* (rather than authored
    /// in the canonical store), the originating pack name. `None` for authored
    /// or external skills. Pack-provided skills are still invokable — the
    /// bound agent advertises them over ACP like any other skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
}

/// Full skill contents for editing/preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    pub name: String,
    pub description: String,
    /// Body with the frontmatter block stripped.
    pub body: String,
    /// The raw on-disk file, frontmatter included.
    pub raw: String,
}

/// A registry agent as a possible enable target for the current scope+root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    pub id: String,
    pub display_name: String,
    /// Relative skills dir under `<root>` (e.g. `.claude/skills`).
    pub skills_dir: String,
    pub delivery: String,
    /// Whether the agent's config dir exists under `<root>`.
    pub detected: bool,
}

// ── Pack model (pack-install plan, Phase 0) ────────────────────────────────────
//
// A skills.sh entry is a *pack*: a Claude-Code-plugin-shaped tree that can ship
// several component kinds (skills, agents, commands, hooks, rules, scripts). The
// existing skill machinery below handles exactly one kind ("skill"); these types
// generalize the model to N kinds. They are inert in Phase 0 — parsing
// (`pack_parse`) lands in Phase 1, per-component projection in Phase 3.

/// The kinds of component a pack can ship.
///
/// `script` files live in the canonical pack and are only *referenced* (never
/// auto-run at install) — execution happens later, when an installed hook fires
/// them via the managed Node. See `.claude/plans/skills-pack-install.plan.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentKind {
    Skill,
    Agent,
    Command,
    Hook,
    Rule,
    Script,
}

impl Default for ComponentKind {
    /// Skill is the default so legacy ledgers (which predate this field)
    /// deserialize as skill projections.
    fn default() -> Self {
        ComponentKind::Skill
    }
}

impl ComponentKind {
    /// Stable lowercase tag (matches the serde representation + ledger storage).
    fn as_str(self) -> &'static str {
        match self {
            ComponentKind::Skill => "skill",
            ComponentKind::Agent => "agent",
            ComponentKind::Command => "command",
            ComponentKind::Hook => "hook",
            ComponentKind::Rule => "rule",
            ComponentKind::Script => "script",
        }
    }

    /// Infer a kind from a top-level pack directory name — the "infer from
    /// layout" fallback used when a pack has no `.claude-plugin/plugin.json`.
    /// Plural dir → singular kind; unknown dirs → `None`.
    fn from_dir_name(name: &str) -> Option<Self> {
        match name {
            "skills" => Some(ComponentKind::Skill),
            "agents" => Some(ComponentKind::Agent),
            "commands" => Some(ComponentKind::Command),
            "hooks" => Some(ComponentKind::Hook),
            "rules" => Some(ComponentKind::Rule),
            "scripts" => Some(ComponentKind::Script),
            _ => None,
        }
    }
}

/// One component discovered inside a pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackComponent {
    pub kind: ComponentKind,
    /// Path relative to the pack root, e.g. `agents/review.md` or `skills/foo`.
    pub rel_path: String,
    /// Projection leaf name (the file or dir name placed in a tool home),
    /// e.g. `review` or `foo`.
    pub name: String,
    /// Frontmatter `description` of the component's markdown (the SKILL.md for a
    /// skill, the `.md` body for command/agent/rule). `None` for non-markdown
    /// components or when no description is set. Lets the marketplace preview a
    /// pack's contents — packs themselves usually carry no manifest description.
    #[serde(default)]
    pub description: Option<String>,
}

/// Read the frontmatter `description` of a component's markdown. For a skill the
/// source is its directory (we read its `SKILL.md`); for other kinds it's the
/// `.md` file itself. Returns `None` for non-markdown or empty descriptions.
fn read_component_description(kind: ComponentKind, src: &Path) -> Option<String> {
    let md = if kind == ComponentKind::Skill {
        src.join("SKILL.md")
    } else {
        src.to_path_buf()
    };
    if md.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let raw = fs::read_to_string(&md).ok()?;
    let desc = parse_frontmatter(&raw).0.description?;
    let desc = desc.trim();
    if desc.is_empty() {
        None
    } else {
        Some(desc.to_string())
    }
}

/// Parsed `.claude-plugin/plugin.json`. Every field is optional — the parser is
/// deliberately tolerant so manifest-light packs still load. `author` is kept as
/// a raw value because the ecosystem uses both a bare string and an object.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<serde_json::Value>,
    // Claude Code plugin component paths. Each is a string or array of strings,
    // relative to the manifest root — they let a plugin keep components in
    // non-conventional locations (e.g. `.claude/skills`, `plugin/hooks/hooks.json`)
    // instead of top-level `skills/`, `hooks/`, etc.
    #[serde(default)]
    pub skills: Option<serde_json::Value>,
    #[serde(default)]
    pub commands: Option<serde_json::Value>,
    #[serde(default)]
    pub agents: Option<serde_json::Value>,
    #[serde(default)]
    pub hooks: Option<serde_json::Value>,
}

/// A parsed pack: canonical name, root dir, the manifest if present, and every
/// component discovered (manifest-declared or inferred from layout).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub manifest: Option<PluginManifest>,
    pub components: Vec<PackComponent>,
}

// ── Tool registry (CP.2) ─────────────────────────────────────────────────────────

/// How a non-skill component is materialized at its tool home.
///
/// - `Dir`  — placed as a file/dir leaf under a directory home (e.g. an agent
///   file in `.claude/agents/`). This is the projection path skills already use.
/// - `SettingsMerge` — merged into a JSON settings file (Claude Code hooks →
///   `.claude/settings.json`). Phase 3 owns the merge semantics.
/// - `AppendFile` — appended to a flat text file (Codex rules → `AGENTS.md`).
///
/// Phase 0 only records these; the projection engine still handles skills only.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HomeStyle {
    Dir,
    SettingsMerge,
    AppendFile,
}

/// Which scopes a component home applies to.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HomeScope {
    Global,
    Project,
    Both,
}

impl HomeScope {
    /// Does this home apply to the requested `"global"` / `"project"` scope?
    #[allow(dead_code)]
    fn covers(self, scope: &str) -> bool {
        matches!(
            (self, scope),
            (HomeScope::Both, _) | (HomeScope::Global, "global") | (HomeScope::Project, "project")
        )
    }
}

/// Where a single component *kind* lives for a tool, relative to `<root>`
/// (home dir at global scope, project path at project scope).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
struct ComponentHome {
    kind: ComponentKind,
    scope: HomeScope,
    /// Path relative to root, e.g. `.claude/agents` (Dir) or `.claude/settings.json`
    /// (SettingsMerge) or `AGENTS.md` (AppendFile).
    rel: &'static str,
    style: HomeStyle,
}

/// A statically-known *tool* (agent) and where its skills/config live, relative
/// to `<root>`. Extends the old `AgentDef`: the single `skills_dir` is split into
/// `global_skills_dir` + `project_skills_dir` because Codex uses different paths
/// per scope (`~/.codex/skills` global, `<proj>/.agents/skills` project).
///
/// `homes` lists where the **non-skill** component kinds (agent/command/hook/rule)
/// land for this tool. Skills are intentionally absent — they keep using
/// [`tool_skills_dir`]. A kind with no `homes` row is unsupported by that tool
/// (e.g. Codex has no agents).
struct ToolDef {
    /// Stable key, e.g. `"codex"`.
    id: &'static str,
    display_name: &'static str,
    /// Skills dir relative to home for **global** scope (e.g. `.codex/skills`).
    global_skills_dir: &'static str,
    /// Skills dir relative to the project for **project** scope (e.g. `.agents/skills`).
    project_skills_dir: &'static str,
    /// Config dir relative to root whose existence == "detected".
    config_dir: &'static str,
    /// `false` ⇒ copy-only projection (never attempt a symlink).
    supports_symlink: bool,
    /// `"native-dir"` | `"copy-only"` | `"inject-only"`.
    delivery: &'static str,
    /// Env var that, when set, relocates this tool's **global** skills base to
    /// `$ENV/skills` (e.g. `CODEX_HOME`, `CLAUDE_CONFIG_DIR`).
    env_override: Option<&'static str>,
    /// Where each non-skill component kind lands for this tool. Empty ⇒ this tool
    /// only supports skills (the legacy behavior).
    homes: &'static [ComponentHome],
}

// v1 in-scope tools: Claude Code + Codex. The registry is trivially extensible —
// a future ACP agent is one more ToolDef row.
const TOOL_REGISTRY: &[ToolDef] = &[
    ToolDef {
        id: "claude-code",
        display_name: "Claude Code",
        global_skills_dir: ".claude/skills",
        project_skills_dir: ".claude/skills",
        config_dir: ".claude",
        supports_symlink: true,
        delivery: "native-dir",
        env_override: Some("CLAUDE_CONFIG_DIR"),
        // Claude Code is the full-fidelity target: dir homes for agents/commands/
        // rules, and a settings.json merge for hooks. Same paths at both scopes.
        homes: &[
            ComponentHome {
                kind: ComponentKind::Agent,
                scope: HomeScope::Both,
                rel: ".claude/agents",
                style: HomeStyle::Dir,
            },
            ComponentHome {
                kind: ComponentKind::Command,
                scope: HomeScope::Both,
                rel: ".claude/commands",
                style: HomeStyle::Dir,
            },
            ComponentHome {
                kind: ComponentKind::Rule,
                scope: HomeScope::Both,
                rel: ".claude/rules",
                style: HomeStyle::Dir,
            },
            ComponentHome {
                kind: ComponentKind::Hook,
                scope: HomeScope::Both,
                rel: ".claude/settings.json",
                style: HomeStyle::SettingsMerge,
            },
        ],
    },
    ToolDef {
        id: "codex",
        // Codex: ~/.codex/skills globally, <proj>/.agents/skills at project scope.
        display_name: "Codex",
        global_skills_dir: ".codex/skills",
        project_skills_dir: ".agents/skills",
        config_dir: ".codex",
        supports_symlink: true,
        delivery: "native-dir",
        env_override: Some("CODEX_HOME"),
        // Codex supports a subset: prompt-style commands (global only) and rules
        // appended to AGENTS.md. No agents/hooks. Phase 3 refines the semantics.
        homes: &[
            ComponentHome {
                kind: ComponentKind::Command,
                scope: HomeScope::Global,
                rel: ".codex/prompts",
                style: HomeStyle::Dir,
            },
            ComponentHome {
                kind: ComponentKind::Rule,
                scope: HomeScope::Both,
                rel: "AGENTS.md",
                style: HomeStyle::AppendFile,
            },
        ],
    },
    ToolDef {
        id: "atlas",
        display_name: "Atlas",
        // The native in-process "Atlas" (cersei) agent. Enabled skills are
        // symlinked into a DEDICATED dir that only the in-process `AtlasSkillTool`
        // reads — kept separate from `.agents/skills` (the canonical store) so this
        // toggle is the exclusive gate (no `~/.claude`/bundled-skill leakage). Same
        // path at both scopes (`~/.atlas/agent-skills`, `<root>/.atlas/agent-skills`).
        global_skills_dir: ".atlas/agent-skills",
        project_skills_dir: ".atlas/agent-skills",
        config_dir: ".atlas",
        supports_symlink: true,
        delivery: "native-dir",
        env_override: None,
        // The native agent only consumes skills — no agent/command/rule/hook homes.
        homes: &[],
    },
];

fn tool_def(id: &str) -> Option<&'static ToolDef> {
    TOOL_REGISTRY.iter().find(|t| t.id == id)
}

/// Resolve where a non-skill component `kind` lands for `tool` at `scope`
/// (`"global"` / `"project"`). `None` ⇒ this tool does not support that kind at
/// that scope. Skills are not represented here — use [`tool_skills_dir`].
#[allow(dead_code)]
fn tool_home(tool: &ToolDef, kind: ComponentKind, scope: &str) -> Option<&'static ComponentHome> {
    tool.homes
        .iter()
        .find(|h| h.kind == kind && h.scope.covers(scope))
}

/// Select a tool's skills dir for a scope, honoring `env_override` at global
/// scope. `root` is the home dir (global) or project path (project).
///
/// At global scope with `env_override` set in the environment, the tool's global
/// skills base becomes `$ENV/skills` (an absolute path, ignoring `root`).
fn tool_skills_dir(tool: &ToolDef, scope: &str, root: &Path) -> PathBuf {
    match scope {
        "global" => {
            if let Some(var) = tool.env_override {
                if let Some(val) = std::env::var_os(var) {
                    let val = val.to_string_lossy();
                    let trimmed = val.trim();
                    if !trimmed.is_empty() {
                        return PathBuf::from(trimmed).join("skills");
                    }
                }
            }
            root.join(tool.global_skills_dir)
        }
        _ => root.join(tool.project_skills_dir),
    }
}

// ── Path resolution + security ─────────────────────────────────────────────────

/// Resolve `<root>` for a scope. Global → home dir; project → the given path.
fn root_for(scope: &str, project_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => home_dir().ok_or_else(|| "could not resolve home directory".to_string()),
        "project" => {
            let p = project_path
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "project scope requires a projectPath".to_string())?;
            let path = PathBuf::from(p);
            // Lexically reject parent-dir traversal. The project root may not
            // exist yet, so we cannot canonicalize; instead refuse any `..`
            // segment so a crafted path can't escape `.agents/skills` later.
            if path.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(
                    "invalid projectPath: parent-directory segments are not allowed".to_string(),
                );
            }
            Ok(path)
        }
        other => Err(format!("invalid scope: {other}")),
    }
}

/// Home dir, preferring the `dirs` crate (already a dependency) and falling
/// back to `$HOME`.
fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

/// `<root>/.agents/skills` — the canonical store base. This is the same
/// `.agents/skills` layout skills.sh and Zed already read/write (ADR 0003);
/// Atlas does not keep a separate store.
fn skills_base(root: &Path) -> PathBuf {
    root.join(".agents").join("skills")
}

/// `<root>/.atlas/skills` — the pre-convergence canonical store. Superseded by
/// [`skills_base`]; only consulted by [`migrate_legacy_skills`] to move any
/// leftover content from an Atlas install that predates the store convergence.
fn legacy_skills_base(root: &Path) -> PathBuf {
    root.join(".atlas").join("skills")
}

/// One-time migration of anything still sitting in the pre-convergence
/// `.atlas/skills` store into the new canonical `.agents/skills` store.
/// Best-effort and idempotent: called on every discovery pass, but becomes a
/// no-op as soon as the legacy dir is empty (no sentinel file needed) — on the
/// maintainer's machine this never had content, but other users who installed
/// skills through Atlas before the convergence do. A skill name already present
/// in the new store wins; the legacy copy is left in place rather than
/// clobbered. Renames when possible (same volume), copies as a fallback.
fn migrate_legacy_skills(root: &Path) {
    let legacy = legacy_skills_base(root);
    let Ok(entries) = fs::read_dir(&legacy) else {
        return;
    };
    let new_base = skills_base(root);
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue; // e.g. the legacy `.projections.json` ledger file
        }
        if !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(safe_name) = sanitize_name(&raw_name) else {
            continue;
        };
        let Ok(dst) = canonical_skill_dir(&new_base, &safe_name) else {
            continue;
        };
        if dst.exists() {
            continue; // new store already has this skill — don't clobber
        }
        if let Some(parent) = dst.parent() {
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let src = entry.path();
        if fs::rename(&src, &dst).is_ok() {
            eprintln!(
                "skills: migrated legacy skill '{safe_name}' from {} to {}",
                src.display(),
                dst.display()
            );
        } else if copy_dir_all(&src, &dst).is_ok() {
            // Cross-device rename failed — fall back to copy, leaving the
            // legacy copy in place (best-effort, not fatal to discovery).
            eprintln!(
                "skills: copied legacy skill '{safe_name}' from {} to {} (legacy copy left in place)",
                src.display(),
                dst.display()
            );
        } else {
            // Both rename and copy failed (permissions, disk full, …) — not
            // fatal to discovery, but worth a trace instead of vanishing
            // silently; the skill stays in the legacy dir and migration
            // retries on the next discovery pass.
            eprintln!(
                "skills: failed to migrate legacy skill '{safe_name}' from {} — left in place, will retry",
                src.display()
            );
        }
    }
}

/// Sanitize a skill name into a safe single path segment.
///
/// - lowercase; `[^a-z0-9._]+` → `-`; collapse runs; strip leading/trailing
///   `.`/`-`; cap at 255 chars.
/// - reject empty results and anything that still looks like traversal.
fn sanitize_name(name: &str) -> Result<String, String> {
    let lowered = name.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut prev_dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch);
            prev_dash = false;
        } else {
            // collapse any run of disallowed chars into a single '-'
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    let trimmed = out.trim_matches(['.', '-']).to_string();
    let capped: String = trimmed.chars().take(255).collect();
    let capped = capped.trim_matches(['.', '-']).to_string();

    if capped.is_empty() {
        return Err(format!("invalid skill name: {name:?}"));
    }
    // Defense in depth: no path separators, no `.`/`..` segment.
    if capped == "." || capped == ".." || capped.contains('/') || capped.contains('\\') {
        return Err(format!("unsafe skill name: {name:?}"));
    }
    Ok(capped)
}

/// Resolve the canonical skill directory for a sanitized name and verify it
/// stays inside `<root>/.agents/skills` (no `..` escape).
fn canonical_skill_dir(base: &Path, safe_name: &str) -> Result<PathBuf, String> {
    let dir = base.join(safe_name);
    // The only non-base component must be exactly `safe_name`.
    let rel = dir
        .strip_prefix(base)
        .map_err(|_| "path escapes skills base".to_string())?;
    let mut comps = rel.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if seg == std::ffi::OsStr::new(safe_name) => Ok(dir),
        _ => Err(format!("unsafe resolved path for {safe_name:?}")),
    }
}

// ── Frontmatter (minimal, no YAML crate — mirrors agent_memory.rs) ──────────────

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

/// Parse the leading `---` frontmatter block for `name`/`description`. Returns
/// the parsed scalars plus the body with the block stripped.
fn parse_frontmatter(raw: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return (fm, raw.to_string());
    }
    let Some(close) = lines.iter().skip(1).position(|l| l.trim_end() == "---") else {
        return (fm, raw.to_string()); // unterminated → all body
    };
    let close = close + 1; // un-skip

    for line in &lines[1..close] {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if let Some((k, v)) = line.trim().split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" if !indented => fm.name = Some(val),
                "description" if !indented => fm.description = Some(val),
                _ => {}
            }
        }
    }

    let body = lines[close + 1..].join("\n");
    let body = body.trim_start_matches(['\n', '\r']).to_string();
    (fm, body)
}

/// Render a `SKILL.md` with frontmatter for the given fields. Only used by the
/// test-only `create_skill` helper now that manual authoring is removed.
#[cfg(test)]
fn render_skill_md(name: &str, description: &str, body: &str) -> String {
    // Keep values single-line; frontmatter is scalar-only here.
    let desc = description.replace(['\n', '\r'], " ");
    format!("---\nname: {name}\ndescription: {desc}\n---\n\n{}\n", body.trim_end())
}

// ── Disk helpers ───────────────────────────────────────────────────────────────

/// Atomic write: tmp + rename (mirrors `shared_memory::atomic_write`).
fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// True if `<root>/<tool.config_dir>` exists.
fn tool_detected(root: &Path, def: &ToolDef) -> bool {
    // The native "Atlas" agent is in-process — always available, regardless of
    // whether any `.atlas` dir exists yet at this scope.
    if def.id == "atlas" {
        return true;
    }
    root.join(def.config_dir).is_dir()
}

/// Path to a tool's projection entry for a skill at a scope:
/// `<tool_skills_dir>/<name>`.
fn tool_link_path(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> PathBuf {
    tool_skills_dir(def, scope, root).join(safe_name)
}

/// Whether any entry (symlink or copy) for this skill exists in the tool dir.
fn tool_has_entry(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> bool {
    tool_link_path(root, def, scope, safe_name)
        .symlink_metadata()
        .is_ok()
}

/// Compute the relative symlink target from a tool's skills dir up to the
/// canonical `<root>/.agents/skills/<name>`. Used only for `<root>`-relative dirs
/// (the common case). For env-relocated absolute dirs we fall back to an absolute
/// target via [`canonical_symlink_target`].
fn relative_symlink_target(skills_dir_rel: &Path, safe_name: &str) -> PathBuf {
    let up = "../".repeat(skills_dir_rel.components().count());
    PathBuf::from(format!("{up}.agents/skills/{safe_name}"))
}

/// Best symlink target for a projection: relative when the tool dir is under
/// `<root>` (keeps the link valid if the tree moves), absolute otherwise (env
/// override relocated the dir outside `<root>`).
fn canonical_symlink_target(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> PathBuf {
    let dir = tool_skills_dir(def, scope, root);
    if let Ok(rel) = dir.strip_prefix(root) {
        relative_symlink_target(rel, safe_name)
    } else {
        skills_base(root).join(safe_name)
    }
}

/// Wipe whatever entry sits at the projection path (symlink/file/dir), so we can
/// re-materialize cleanly. Only ever the `<name>` entry inside the tool dir.
fn clear_entry(link: &Path) -> Result<(), String> {
    if let Ok(meta) = link.symlink_metadata() {
        if !meta.file_type().is_symlink() && meta.is_dir() {
            fs::remove_dir_all(link).map_err(|e| e.to_string())?;
        } else {
            let _ = fs::remove_file(link);
        }
    }
    Ok(())
}

/// Create a relative symlink from the tool skills dir to the canonical skill.
/// Idempotent: a stale entry is removed first, then recreated.
fn create_symlink(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    let target = canonical_symlink_target(root, def, scope, safe_name);
    symlink(&target, &link).map_err(|e| format!("symlink failed: {e}"))
}

/// Materialize a copy projection: recursively copy canonical → tool dir.
fn create_copy(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    if !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    copy_dir_all(&canonical, &link)
}

/// Remove a tool's projection for a skill (symlink or copy). Best-effort.
fn remove_symlink(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    clear_entry(&link)
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks are only supported on unix in v1",
    ))
}

// ── Content hashing (CP.3) ───────────────────────────────────────────────────────

/// Stable content hash of a skill directory for **change detection** (not
/// security). Walks every file under `dir` sorted by relative path and folds
/// `(relpath_bytes, 0x00, file_bytes)` into a 64-bit FNV-1a, returned as hex.
/// Missing dir → empty string (treated as "no content").
fn hash_skill_dir(dir: &Path) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    // Collect (relative-path, absolute-path) for every file, sorted by relpath.
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(dir, dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hash = FNV_OFFSET;
    let mut fold = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    for (rel, abs) in &files {
        fold(rel.as_bytes());
        fold(&[0x00]);
        if let Ok(bytes) = fs::read(abs) {
            fold(&bytes);
        }
    }
    format!("{hash:016x}")
}

/// Recursively gather files under `dir` as `(relative-to-base path, abs path)`.
/// Symlinks are not followed (only real files contribute to the hash).
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_files(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
}

// ── Projection ledger (CP.3) ─────────────────────────────────────────────────────

/// One recorded projection of a skill into a tool: how it was materialized and
/// the canonical hash at push time (for drift detection on copies).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerEntry {
    /// `"symlink"` | `"copy"` | `"native"` (the tool's own skills dir IS the
    /// canonical store at this scope — see [`project`]'s native-location guard).
    mode: String,
    /// Canonical content hash at the moment of projection.
    hash: String,
    /// Which component kind this entry projected. Defaults to `Skill` and is
    /// omitted from JSON when it *is* `Skill`, so pre-existing skill-only ledgers
    /// round-trip byte-identically.
    #[serde(default, skip_serializing_if = "is_skill_kind")]
    component_kind: ComponentKind,
}

/// `skip_serializing_if` predicate: a `Skill` kind is the implicit default and is
/// never written to the ledger JSON.
fn is_skill_kind(kind: &ComponentKind) -> bool {
    *kind == ComponentKind::Skill
}

/// `<root>/.agents/skills/.projections.json` — one ledger per root (home for
/// global, project for project). Map: skill → toolId → entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    projections: BTreeMap<String, BTreeMap<String, LedgerEntry>>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            projections: BTreeMap::new(),
        }
    }
}

fn ledger_path(root: &Path) -> PathBuf {
    skills_base(root).join(".projections.json")
}

/// Read the ledger, tolerating a missing or garbage file (→ default empty).
fn read_ledger(root: &Path) -> Ledger {
    let path = ledger_path(root);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Ledger::default(),
    }
}

/// Atomically persist the ledger (reuses [`atomic_write`]).
fn write_ledger(root: &Path, ledger: &Ledger) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    atomic_write(&ledger_path(root), &payload)
}

fn ledger_record(
    ledger: &mut Ledger,
    safe_name: &str,
    tool_id: &str,
    mode: &str,
    hash: &str,
) {
    ledger
        .projections
        .entry(safe_name.to_string())
        .or_default()
        .insert(
            tool_id.to_string(),
            LedgerEntry {
                mode: mode.to_string(),
                hash: hash.to_string(),
                component_kind: ComponentKind::Skill,
            },
        );
}

fn ledger_remove(ledger: &mut Ledger, safe_name: &str, tool_id: &str) {
    if let Some(tools) = ledger.projections.get_mut(safe_name) {
        tools.remove(tool_id);
        if tools.is_empty() {
            ledger.projections.remove(safe_name);
        }
    }
}

// ── Cross-ledger: pack awareness (Skills-side, read-only) ────────────────────────
//
// Packs own their own projection ledger (`.atlas/packs/.pack-projections.json`).
// The Skills subsystem reads it one-directionally — never writes it — so that a
// pack-delivered skill is a first-class skill in every listing and so the
// Skills side never silently clobbers a projection a pack owns.

/// Every skill shipped by an installed pack, as `(pack_name, safe_skill_name,
/// abs_skill_md_path)`. Reused by `list_skills`, `read_skill`, and `reconcile`.
fn pack_provided_skills(root: &Path) -> Vec<(String, String, PathBuf)> {
    let mut out = Vec::new();
    for installed in list_installed_packs(root).unwrap_or_default() {
        for comp in &installed.pack.components {
            if comp.kind != ComponentKind::Skill {
                continue;
            }
            let Ok(safe) = sanitize_name(&comp.name) else {
                continue;
            };
            let md = Path::new(&installed.pack.root)
                .join(&comp.rel_path)
                .join("SKILL.md");
            out.push((installed.pack.name.clone(), safe, md));
        }
    }
    out
}

/// The `SKILL.md` of an installed pack's skill named `safe_name`, if any.
fn pack_skill_md(root: &Path, safe_name: &str) -> Option<PathBuf> {
    pack_provided_skills(root)
        .into_iter()
        .find(|(_, name, _)| name == safe_name)
        .map(|(_, _, md)| md)
}

/// The pack (if any) that owns the skill projection at `safe_name` for this
/// `tool`/`scope`, per the live pack-projection ledger. The pack records its
/// target as `rel_to_root(root, target)`; the Skills target for the same skill
/// is `tool_link_path(...)`, so the two match when the names sanitize equally.
fn pack_owner_of_skill(
    root: &Path,
    proj: &PackProj,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Option<String> {
    let target_rel = rel_to_root(root, &tool_link_path(root, def, scope, safe_name));
    for (pack, tools) in &proj.projections {
        if let Some(entries) = tools.get(def.id) {
            if entries
                .iter()
                .any(|e| e.kind == ComponentKind::Skill && e.target_rel == target_rel)
            {
                return Some(pack.clone());
            }
        }
    }
    None
}

// ── Projection engine (CP.1 Job 3, CP.3) ─────────────────────────────────────────

/// Project a canonical skill into a tool at a scope. Symlink when the tool
/// `supports_symlink`, else copy fallback. Records mode + canonical hash in the
/// ledger. **Non-destructive**: refuses to clobber a `drifted` copy or an
/// `external` dir unless `force` is set.
fn project(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
    force: bool,
) -> Result<(), String> {
    if def.delivery == "inject-only" {
        return Err(format!(
            "tool {} is inject-only and cannot receive a file projection",
            def.id
        ));
    }
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let canonical_hash = hash_skill_dir(&canonical);
    if canonical_hash.is_empty() || !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }

    let link = tool_link_path(root, def, scope, safe_name);

    // Store convergence (ADR 0003): Codex's own *project*-scope skills dir was
    // already `.agents/skills`, the same path the canonical store now uses, so
    // for that (tool, scope) pair `link` and `canonical` are the same directory.
    // The skill already lives where the tool reads it — nothing to symlink/copy,
    // just record it as projected.
    if link == canonical {
        let mut ledger = read_ledger(root);
        ledger_record(&mut ledger, safe_name, def.id, "native", &canonical_hash);
        return write_ledger(root, &ledger);
    }

    // Non-destructive guard: if a real (non-symlink) dir already sits at the
    // target, only overwrite when the caller forces it.
    if !force {
        if let Ok(meta) = link.symlink_metadata() {
            if !meta.file_type().is_symlink() && meta.is_dir() {
                let existing_hash = hash_skill_dir(&link);
                if existing_hash != canonical_hash {
                    return Err(format!(
                        "refusing to overwrite drifted/external '{safe_name}' in {} (use force)",
                        def.id
                    ));
                }
            }
        }
        // Cross-ledger guard: never silently clobber a projection an installed
        // pack owns. The pack ledger is only read here — Skills never writes it.
        if let Some(owner) =
            pack_owner_of_skill(root, &read_pack_proj(root), def, scope, safe_name)
        {
            return Err(format!(
                "'{safe_name}' in {} is managed by pack '{owner}' — manage it from the Packs tab (or use force)",
                def.id
            ));
        }
    }

    let mut ledger = read_ledger(root);
    if def.supports_symlink {
        match create_symlink(root, def, scope, safe_name) {
            Ok(()) => {
                ledger_record(&mut ledger, safe_name, def.id, "symlink", &canonical_hash);
            }
            Err(_) => {
                // Symlink syscall failed (e.g. non-Unix) → copy fallback.
                create_copy(root, def, scope, safe_name)?;
                ledger_record(&mut ledger, safe_name, def.id, "copy", &canonical_hash);
            }
        }
    } else {
        create_copy(root, def, scope, safe_name)?;
        ledger_record(&mut ledger, safe_name, def.id, "copy", &canonical_hash);
    }
    write_ledger(root, &ledger)
}

/// Remove a projection (symlink or copy) and drop its ledger entry. Refuses to
/// act on a native-location pair (see [`project`]) — `clear_entry` would delete
/// the canonical skill itself rather than a projection of it.
fn unproject(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let link = tool_link_path(root, def, scope, safe_name);
    if link == canonical {
        return Err(format!(
            "cannot disable {} for '{safe_name}': its {scope}-scope skills dir is the canonical store itself",
            def.id
        ));
    }
    remove_symlink(root, def, scope, safe_name)?;
    let mut ledger = read_ledger(root);
    ledger_remove(&mut ledger, safe_name, def.id);
    write_ledger(root, &ledger)
}

// ── Core (testable, no Tauri) ──────────────────────────────────────────────────

fn list_skills(root: &Path, scope: &str) -> Result<Vec<SkillMeta>, String> {
    // One-time move of anything left in the pre-convergence `.atlas/skills`
    // store into the new canonical `.agents/skills` store. No-op once migrated.
    migrate_legacy_skills(root);

    // Keyed by the sanitized skill name so canonical + external entries dedupe.
    let mut by_name: BTreeMap<String, SkillMeta> = BTreeMap::new();

    // ── 1. Canonical (managed) skills under `<root>/.agents/skills/*`. ─────────
    let base = skills_base(root);
    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // Sanitize the on-disk dir name before using it to build tool link
            // paths; skip entries whose name can't be made safe.
            let Ok(safe_name) = sanitize_name(&raw_name) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue; // dir without a SKILL.md isn't a skill
            };
            let (fm, _body) = parse_frontmatter(&raw);
            let enabled_agents: Vec<String> = TOOL_REGISTRY
                .iter()
                .filter(|def| tool_has_entry(root, def, scope, &safe_name))
                .map(|def| def.id.to_string())
                .collect();

            by_name.insert(
                safe_name.clone(),
                SkillMeta {
                    name: fm.name.unwrap_or_else(|| safe_name.clone()),
                    description: fm.description.unwrap_or_default(),
                    scope: scope.to_string(),
                    enabled_agents,
                    path: skill_md.to_string_lossy().to_string(),
                    delivery: "native-dir".to_string(),
                    managed: true,
                    pack: None,
                },
            );
        }
    }

    // ── 2. External (unmanaged) skills living directly in each tool dir. ───────
    // A top-level entry — real directory OR symlink to one — with its own
    // `SKILL.md` and NOT one of our canonical skills is an external tool skill.
    // Symlinks are followed rather than rejected (ADR 0003): most of them are
    // exactly the `.agents/skills` projections skills.sh/Zed/Atlas itself write,
    // and those resolving into our own canonical store are already accounted for
    // above (the `by_name.contains_key` check below skips them). Container dirs
    // without a top-level `SKILL.md` (e.g. `~/.claude/skills/ecc/`) are skipped —
    // no recursion (v1).
    for def in TOOL_REGISTRY {
        let dir = tool_skills_dir(def, scope, root);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // Follow symlinks: only reject non-directories (files, broken links).
            if !entry.path().is_dir() {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue; // container dir without a top-level SKILL.md → skip
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe_name) = sanitize_name(&raw_name) else {
                continue;
            };
            // A managed skill of the same name wins; don't downgrade it.
            if by_name.contains_key(&safe_name) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _body) = parse_frontmatter(&raw);

            let meta = by_name.entry(safe_name.clone()).or_insert_with(|| SkillMeta {
                name: fm.name.clone().unwrap_or_else(|| safe_name.clone()),
                description: fm.description.clone().unwrap_or_default(),
                scope: scope.to_string(),
                enabled_agents: Vec::new(),
                path: skill_md.to_string_lossy().to_string(),
                delivery: "native-dir".to_string(),
                managed: false,
                pack: None,
            });
            if !meta.enabled_agents.iter().any(|a| a == def.id) {
                meta.enabled_agents.push(def.id.to_string());
            }
        }
    }

    // ── 3. Pack-provided skills (installed packs' `Skill` components). ─────────
    // A skill shipped by an installed pack is a first-class skill even before
    // it is projected into a tool. Surface it here (badged with its pack) so
    // My Skills sees it. An authored or external skill of the same name
    // wins — don't downgrade it.
    for (pack_name, safe_name, skill_md) in pack_provided_skills(root) {
        if by_name.contains_key(&safe_name) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&skill_md) else {
            continue;
        };
        let (fm, _body) = parse_frontmatter(&raw);
        // Which tools currently host this pack's skill projection at this scope.
        let enabled_agents: Vec<String> = TOOL_REGISTRY
            .iter()
            .filter(|def| tool_has_entry(root, def, scope, &safe_name))
            .map(|def| def.id.to_string())
            .collect();
        by_name.insert(
            safe_name.clone(),
            SkillMeta {
                name: fm.name.unwrap_or_else(|| safe_name.clone()),
                description: fm.description.unwrap_or_default(),
                scope: scope.to_string(),
                enabled_agents,
                path: skill_md.to_string_lossy().to_string(),
                delivery: "native-dir".to_string(),
                managed: false,
                pack: Some(pack_name),
            },
        );
    }

    let mut out: Vec<SkillMeta> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn read_skill(root: &Path, name: &str) -> Result<SkillContent, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");
    let raw = match fs::read_to_string(&skill_md) {
        Ok(raw) => raw,
        // Not in the canonical store — fall back to an installed pack that ships
        // a skill of this name, so pack-provided skills are readable too.
        Err(_) => pack_skill_md(root, &safe)
            .and_then(|p| fs::read_to_string(&p).ok())
            .ok_or_else(|| format!("skill not found: {safe}"))?,
    };
    let (fm, body) = parse_frontmatter(&raw);
    Ok(SkillContent {
        name: fm.name.unwrap_or(safe),
        description: fm.description.unwrap_or_default(),
        body,
        raw,
    })
}

// Manual skill authoring (the `skills_create` IPC command) was removed; skills
// now come from packs. `create_skill` is retained only as a test setup helper.
#[cfg(test)]
fn create_skill(
    root: &Path,
    scope: &str,
    name: &str,
    description: &str,
    body: &str,
    agents: &[String],
) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");

    let existed = skill_md.is_file();
    let contents = render_skill_md(&safe, description, body);
    atomic_write(&skill_md, &contents)?;

    // Enable for each requested registry tool (symlink/copy via the engine).
    let mut enabled_agents = Vec::new();
    for agent in agents {
        if let Some(def) = tool_def(agent) {
            project(root, def, scope, &safe, false)?;
            enabled_agents.push(def.id.to_string());
        }
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    // Edit-propagation: if this was an edit of an existing canonical skill,
    // re-push copy projections (symlinks read through the link for free). A copy
    // that is currently drifted is left untouched for explicit resolution.
    if existed {
        propagate_edit(root, scope, &safe)?;
    }

    Ok(SkillMeta {
        name: safe,
        description: description.replace(['\n', '\r'], " "),
        scope: scope.to_string(),
        enabled_agents,
        path: skill_md.to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

/// Recursively copy `src` → `dst` (dirs + files), creating parents as needed.
/// Used by `adopt_skill` to lift an external skill into the canonical store
/// without a new dependency. Symlinks inside the source are not followed into
/// new symlinks — their target contents are copied through `fs::copy`.
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// "Make for all agents": adopt an external/single-agent skill into the
/// canonical store and fan it out to every detected tool as a projection.
fn adopt_skill(root: &Path, scope: &str, name: &str) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let canonical = canonical_skill_dir(&skills_base(root), &safe)?;
    let canonical_md = canonical.join("SKILL.md");

    // 1. Locate the source. Prefer the canonical copy if it already exists;
    //    otherwise the first registry tool dir that holds a real skill dir.
    if !canonical_md.is_file() {
        let mut source: Option<PathBuf> = None;
        for def in TOOL_REGISTRY {
            let link = tool_link_path(root, def, scope, &safe);
            // Only adopt from a real directory with its own SKILL.md (an
            // external skill). A symlink would already point at canonical.
            let Ok(meta) = link.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if link.is_dir() && link.join("SKILL.md").is_file() {
                source = Some(link);
                break;
            }
        }
        let source = source.ok_or_else(|| format!("skill not found to adopt: {safe}"))?;
        // 2. Copy the entire source dir into canonical (never delete the original).
        copy_dir_all(&source, &canonical)?;
    }

    // 3. For each DETECTED tool: project (symlink/copy) from canonical. The
    //    original external dir, if present, hashes equal to the just-copied
    //    canonical, so the non-destructive guard lets `project` replace it.
    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY {
        if !tool_detected(root, def) || def.delivery == "inject-only" {
            continue;
        }
        project(root, def, scope, &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(&canonical_md).map_err(|e| e.to_string())?;
    let (fm, _body) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: scope.to_string(),
        enabled_agents,
        path: canonical_md.to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

fn set_enabled(
    root: &Path,
    scope: &str,
    name: &str,
    agent: &str,
    enabled: bool,
) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    // Ensure the canonical skill exists before toggling a projection.
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    if !dir.join("SKILL.md").is_file() {
        return Err(format!("skill not found: {safe}"));
    }
    let def = tool_def(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if enabled {
        project(root, def, scope, &safe, false)
    } else {
        unproject(root, def, scope, &safe)
    }
}

fn delete_skill(root: &Path, scope: &str, name: &str) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    // Remove every registry tool's projection first, then the canonical dir.
    for def in TOOL_REGISTRY {
        remove_symlink(root, def, scope, &safe)?;
    }
    let mut ledger = read_ledger(root);
    ledger.projections.remove(&safe);
    write_ledger(root, &ledger).ok();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

fn skill_path(root: &Path, name: &str) -> Result<String, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("skill not found: {safe}"));
    }
    Ok(skill_md.to_string_lossy().to_string())
}

fn list_targets(root: &Path, scope: &str) -> Vec<AgentTarget> {
    TOOL_REGISTRY
        .iter()
        .map(|def| AgentTarget {
            id: def.id.to_string(),
            display_name: def.display_name.to_string(),
            skills_dir: tool_skills_dir(def, scope, root)
                .to_string_lossy()
                .to_string(),
            delivery: def.delivery.to_string(),
            detected: tool_detected(root, def),
        })
        .collect()
}

// ── Edit propagation (CP.3) ──────────────────────────────────────────────────────

/// Re-push copy projections after a canonical edit. Symlinks read through the
/// link, so nothing to do for them. A copy whose on-disk hash already differs
/// from its ledger-recorded hash is *drifted* (edited out-of-band) → leave it
/// for explicit resolution, never silently overwrite.
#[cfg(test)]
fn propagate_edit(root: &Path, scope: &str, safe_name: &str) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let canonical_hash = hash_skill_dir(&canonical);
    let mut ledger = read_ledger(root);
    let Some(tools) = ledger.projections.get(safe_name).cloned() else {
        return Ok(());
    };
    for (tool_id, entry) in tools {
        if entry.mode != "copy" {
            continue;
        }
        let Some(def) = tool_def(&tool_id) else {
            continue;
        };
        let link = tool_link_path(root, def, scope, safe_name);
        let on_disk = hash_skill_dir(&link);
        // Drifted: the copy diverged from what we last pushed → block silent push.
        if !on_disk.is_empty() && on_disk != entry.hash {
            continue;
        }
        if on_disk == canonical_hash {
            continue; // already in sync
        }
        create_copy(root, def, scope, safe_name)?;
        ledger_record(&mut ledger, safe_name, &tool_id, "copy", &canonical_hash);
    }
    write_ledger(root, &ledger)
}

// ── Reconcile (CP.1 Job 2) ───────────────────────────────────────────────────────

/// A tool's registry facts for the reconciled view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub display_name: String,
    pub detected_global: bool,
    pub detected_project: bool,
    pub supports_symlink: bool,
    pub delivery: String,
}

/// One cell of the skill × tool matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionCell {
    pub tool: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// `canonical` | `synced` | `drifted` | `external` | `conflict` | `absent`.
    pub status: String,
    /// `"symlink"` | `"copy"` | `null`.
    pub mode: Option<String>,
    /// When this cell's on-disk projection is owned by an installed pack (per the
    /// pack-projection ledger), the owning pack name. Such cells are read-only
    /// from the Skills side — manage them in the Packs tab. `None` otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
}

/// One reconciled skill row: its canonical facts plus the per-tool matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledSkill {
    pub name: String,
    pub description: String,
    /// The scope this row was reconciled at.
    pub scope: String,
    pub managed: bool,
    /// Set when this skill is provided by an installed pack (origin badge).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    pub cells: Vec<ProjectionCell>,
}

/// The full reconciled view for one scope+root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileView {
    pub tools: Vec<ToolInfo>,
    pub skills: Vec<ReconciledSkill>,
}

/// Build the reconciled matrix for `scope`. `home` is always needed for global
/// detection facts even when reconciling a project scope.
fn reconcile(root: &Path, scope: &str, home: &Path) -> Result<ReconcileView, String> {
    // Same one-time legacy migration as `list_skills` — reconcile is a discovery
    // entry point too and is called independently of the list view.
    migrate_legacy_skills(root);

    let tools: Vec<ToolInfo> = TOOL_REGISTRY
        .iter()
        .map(|def| ToolInfo {
            id: def.id.to_string(),
            display_name: def.display_name.to_string(),
            detected_global: tool_detected(home, def),
            detected_project: scope == "project" && tool_detected(root, def),
            supports_symlink: def.supports_symlink,
            delivery: def.delivery.to_string(),
        })
        .collect();

    let ledger = read_ledger(root);
    let pack_proj = read_pack_proj(root);
    let base = skills_base(root);

    // Names: canonical dirs ∪ external dirs ∪ pack-provided skills at this scope.
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut canonical_meta: BTreeMap<String, (String, String)> = BTreeMap::new(); // name → (display, desc)
    let mut canonical_hash: BTreeMap<String, String> = BTreeMap::new();
    let mut pack_meta: BTreeMap<String, (String, String)> = BTreeMap::new(); // name → (display, desc)
    let mut pack_origin: BTreeMap<String, String> = BTreeMap::new(); // name → pack

    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe) = sanitize_name(&raw_name) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _b) = parse_frontmatter(&raw);
            canonical_meta.insert(
                safe.clone(),
                (
                    fm.name.unwrap_or_else(|| safe.clone()),
                    fm.description.unwrap_or_default(),
                ),
            );
            canonical_hash.insert(safe.clone(), hash_skill_dir(&entry.path()));
            names.insert(safe);
        }
    }

    // Pre-scan external/real dirs per tool (name → (display, desc, hash)).
    // Follows symlinks (ADR 0003) same as `list_skills`'s external scan.
    let mut external: BTreeMap<String, BTreeMap<String, (String, String, String)>> =
        BTreeMap::new();
    for def in TOOL_REGISTRY {
        let dir = tool_skills_dir(def, scope, root);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            if !entry.path().join("SKILL.md").is_file() {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe) = sanitize_name(&raw_name) else {
                continue;
            };
            let raw = fs::read_to_string(entry.path().join("SKILL.md")).unwrap_or_default();
            let (fm, _b) = parse_frontmatter(&raw);
            external.entry(safe.clone()).or_default().insert(
                def.id.to_string(),
                (
                    fm.name.unwrap_or_else(|| safe.clone()),
                    fm.description.unwrap_or_default(),
                    hash_skill_dir(&entry.path()),
                ),
            );
            names.insert(safe);
        }
    }

    // Pack-provided skills: surface them as rows too (managed = false, with a
    // pack origin) so they appear in My Skills even before being projected.
    for (pack_name, safe, md) in pack_provided_skills(root) {
        names.insert(safe.clone());
        pack_origin.entry(safe.clone()).or_insert(pack_name);
        if !canonical_meta.contains_key(&safe) && !pack_meta.contains_key(&safe) {
            if let Ok(raw) = fs::read_to_string(&md) {
                let (fm, _b) = parse_frontmatter(&raw);
                pack_meta.insert(
                    safe.clone(),
                    (
                        fm.name.unwrap_or_else(|| safe.clone()),
                        fm.description.unwrap_or_default(),
                    ),
                );
            }
        }
    }

    let mut skills: Vec<ReconciledSkill> = Vec::new();
    for name in &names {
        let managed = canonical_meta.contains_key(name);
        let (display, desc) = if let Some((d, e)) = canonical_meta.get(name) {
            (d.clone(), e.clone())
        } else if let Some((d, e)) = pack_meta.get(name) {
            (d.clone(), e.clone())
        } else {
            // Fall back to any external tool's metadata.
            external
                .get(name)
                .and_then(|m| m.values().next())
                .map(|(d, e, _)| (d.clone(), e.clone()))
                .unwrap_or_else(|| (name.clone(), String::new()))
        };
        let canon_hash = canonical_hash.get(name).cloned();

        let mut cells: Vec<ProjectionCell> = Vec::new();
        for def in TOOL_REGISTRY {
            let detected = tool_detected(root, def);
            let link = tool_link_path(root, def, scope, name);
            let entry_meta = link.symlink_metadata().ok();
            let is_symlink = entry_meta
                .as_ref()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            let is_real_dir = entry_meta
                .as_ref()
                .map(|m| !m.file_type().is_symlink() && m.is_dir())
                .unwrap_or(false);
            let ledger_entry = ledger
                .projections
                .get(name)
                .and_then(|t| t.get(def.id));

            let (status, mode) = if is_symlink {
                // A symlink projection always reflects canonical (it IS the file).
                ("synced".to_string(), Some("symlink".to_string()))
            } else if is_real_dir {
                let on_disk = hash_skill_dir(&link);
                if managed {
                    // Copy of a canonical skill → synced/drifted by hash.
                    match &canon_hash {
                        Some(h) if &on_disk == h => {
                            ("synced".to_string(), Some("copy".to_string()))
                        }
                        Some(_) => ("drifted".to_string(), Some("copy".to_string())),
                        None => ("drifted".to_string(), Some("copy".to_string())),
                    }
                } else {
                    // No canonical twin → external (or external-conflict).
                    ("external".to_string(), None)
                }
            } else if !entry_meta.is_some() {
                // Nothing on disk for this tool.
                if !detected {
                    ("absent".to_string(), None)
                } else if managed {
                    ("absent".to_string(), None)
                } else {
                    ("absent".to_string(), None)
                }
            } else {
                ("absent".to_string(), None)
            };

            // Conflict refinement: an external dir whose name collides with a
            // canonical skill but whose content differs is the dangerous case.
            let status = if status == "external" {
                if let (Some(ext_for_tool), Some(h)) =
                    (external.get(name).and_then(|m| m.get(def.id)), &canon_hash)
                {
                    if &ext_for_tool.2 != h {
                        "conflict".to_string()
                    } else {
                        status
                    }
                } else {
                    status
                }
            } else {
                status
            };

            // Mark the canonical owner cell on a synced-symlink when this tool
            // is the source? No — canonical lives in .atlas, not a tool dir. The
            // `canonical` status belongs to the library row itself, surfaced via
            // `managed`. Leave tool cells as projection statuses.
            let _ = mode; // (mode already set above)
            let mode = match (is_symlink, is_real_dir, ledger_entry) {
                (true, _, _) => Some("symlink".to_string()),
                (_, true, _) => Some("copy".to_string()),
                _ => None,
            };
            // Cross-ledger override: if this on-disk projection is owned by an
            // installed pack, surface it as a read-only `pack` cell so the Skills
            // side won't toggle it (manage it in the Packs tab instead).
            let (status, pack) = match pack_owner_of_skill(root, &pack_proj, def, scope, name) {
                Some(owner) => ("pack".to_string(), Some(owner)),
                None => (status, None),
            };
            cells.push(ProjectionCell {
                tool: def.id.to_string(),
                scope: scope.to_string(),
                status,
                mode,
                pack,
            });
        }

        skills.push(ReconciledSkill {
            name: display,
            description: desc,
            scope: scope.to_string(),
            managed,
            pack: pack_origin.get(name).cloned(),
            cells,
        });
    }

    Ok(ReconcileView { tools, skills })
}

// ── Freeze (CP.3 uninstall safety) ───────────────────────────────────────────────

/// Convert every Atlas-authored *symlink* projection in the ledger into a real
/// copy, so removing `~/.agents/skills` leaves each tool with a working,
/// self-contained skill dir. Idempotent (copies are left as-is).
fn freeze(root: &Path, scope: &str) -> Result<(), String> {
    let mut ledger = read_ledger(root);
    let snapshot = ledger.projections.clone();
    for (safe_name, tools) in snapshot {
        for (tool_id, entry) in tools {
            if entry.mode != "symlink" {
                continue;
            }
            let Some(def) = tool_def(&tool_id) else {
                continue;
            };
            let canonical = canonical_skill_dir(&skills_base(root), &safe_name)?;
            if !canonical.join("SKILL.md").is_file() {
                continue; // canonical gone — nothing to freeze from
            }
            let hash = hash_skill_dir(&canonical);
            // Replace the symlink with a real copy of canonical.
            create_copy(root, def, scope, &safe_name)?;
            ledger_record(&mut ledger, &safe_name, &tool_id, "copy", &hash);
        }
    }
    write_ledger(root, &ledger)
}

// ── Promote (CP.4 scenario 4) ────────────────────────────────────────────────────

/// Promote a project skill to global: copy `<proj>/.agents/skills/<name>` →
/// `~/.agents/skills/<name>`, then re-project into every detected tool at global
/// scope. The project copy is kept (the repo still travels with it).
fn promote(project_root: &Path, home: &Path, name: &str) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let src = canonical_skill_dir(&skills_base(project_root), &safe)?;
    if !src.join("SKILL.md").is_file() {
        return Err(format!("project skill not found: {safe}"));
    }
    let dst = canonical_skill_dir(&skills_base(home), &safe)?;
    // Copy project canonical → global canonical (overwrite global copy).
    if dst.exists() {
        fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&src, &dst)?;

    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY {
        if !tool_detected(home, def) || def.delivery == "inject-only" {
            continue;
        }
        project(home, def, "global", &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(dst.join("SKILL.md")).map_err(|e| e.to_string())?;
    let (fm, _b) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: "global".to_string(),
        enabled_agents,
        path: dst.join("SKILL.md").to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

// ── Plugin skills (read-only fourth discovery channel, ADR 0003) ─────────────────
//
// Claude Code plugin marketplaces ship their own bundled skills under
// `~/.claude/plugins/marketplaces/<marketplace>/skills/<name>/SKILL.md`. These
// are a genuinely foreign channel: never installable, projectable, or
// uninstallable through Atlas. They already reach the picker because the
// *agent* advertises them over ACP — Atlas only needs to find them so the
// Skills UI's browsing surface can show they exist. Not merged into
// `SkillMeta`/`list_skills`: that type's `managed`/`enabled_agents` fields
// describe things Atlas can toggle, which is exactly what these are not.

// TODO(codex plugin skills): Codex's plugin directory layout is unverified —
// `~/.codex/plugins/` exists on the maintainer's machine but contains only a
// `cache/` dir, not a `marketplaces/*/skills` tree like Claude Code's. Add a
// `list_codex_plugin_skills(home)` here (same read-only pattern, folded into
// `list_plugin_skills` below) once a real Codex plugin install reveals the
// actual layout — don't guess at a path that might be wrong.

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// List installed skills for a scope (canonical store scan + per-agent enable).
#[tauri::command]
pub async fn skills_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<SkillMeta>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || list_skills(&root, &scope))
        .await
        .map_err(|e| e.to_string())?
}

/// Read one skill's frontmatter + body (for editing/preview).
#[tauri::command]
pub async fn skills_read(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<SkillContent, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || read_skill(&root, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Enable/disable a single agent for a skill (create/remove its symlink).
#[tauri::command]
pub async fn skills_set_enabled(
    app: AppHandle,
    scope: String,
    name: String,
    agent: String,
    enabled: bool,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let (name_ev, agent_ev) = (name.clone(), agent.clone());
    let res = tokio::task::spawn_blocking(move || set_enabled(&root, &scope, &name, &agent, enabled))
        .await
        .map_err(|e| e.to_string())?;
    if res.is_ok() {
        app.state::<Arc<crate::telemetry::TelemetryClient>>().capture(
            if enabled { "skill_enabled" } else { "skill_disabled" },
            serde_json::json!({ "skill": name_ev, "agent": agent_ev }),
        );
    }
    res
}

/// Delete a skill: remove every agent symlink, then the canonical dir.
#[tauri::command]
pub async fn skills_delete(
    app: AppHandle,
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let (name_ev, scope_ev) = (name.clone(), scope.clone());
    let res = tokio::task::spawn_blocking(move || delete_skill(&root, &scope, &name))
        .await
        .map_err(|e| e.to_string())?;
    if res.is_ok() {
        app.state::<Arc<crate::telemetry::TelemetryClient>>().capture(
            "skill_deleted",
            serde_json::json!({ "skill": name_ev, "scope": scope_ev }),
        );
    }
    res
}

/// Absolute path to a skill's `SKILL.md` (for opening in the editor).
#[tauri::command]
pub async fn skills_path(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<String, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || skill_path(&root, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Adopt an external/single-agent skill: copy it into the canonical store (if
/// not already there) and symlink it into every detected agent ("Make for all
/// agents"). Returns the now-managed skill.
#[tauri::command]
pub async fn skills_adopt(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<SkillMeta, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || adopt_skill(&root, &scope, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// List registry agents as enable targets for the current scope+root.
#[tauri::command]
pub async fn agents_list_skill_targets(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<AgentTarget>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    Ok(
        tokio::task::spawn_blocking(move || list_targets(&root, &scope))
            .await
            .map_err(|e| e.to_string())?,
    )
}

// ── Tauri commands (Control Plane) ───────────────────────────────────────────────

/// List the tool registry with per-scope detection facts.
#[tauri::command]
pub async fn tools_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<AgentTarget>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    Ok(
        tokio::task::spawn_blocking(move || list_targets(&root, &scope))
            .await
            .map_err(|e| e.to_string())?,
    )
}

/// Build the reconciled skill × tool matrix for a scope.
#[tauri::command]
pub async fn skills_reconcile(
    scope: String,
    project_path: Option<String>,
) -> Result<ReconcileView, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let home = home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    tokio::task::spawn_blocking(move || reconcile(&root, &scope, &home))
        .await
        .map_err(|e| e.to_string())?
}

/// Project a canonical skill into one tool at a scope (symlink/copy + ledger).
#[tauri::command]
pub async fn skills_project(
    scope: String,
    name: String,
    tool: String,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        let safe = sanitize_name(&name)?;
        let def = tool_def(&tool).ok_or_else(|| format!("unknown tool: {tool}"))?;
        project(&root, def, &scope, &safe, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a projection (symlink/copy) of a skill from one tool + drop its ledger.
#[tauri::command]
pub async fn skills_unproject(
    scope: String,
    name: String,
    tool: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let safe = sanitize_name(&name)?;
        let def = tool_def(&tool).ok_or_else(|| format!("unknown tool: {tool}"))?;
        unproject(&root, def, &scope, &safe)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Promote a project skill to the global library + re-project at global scope.
#[tauri::command]
pub async fn skills_promote(
    name: String,
    project_path: String,
) -> Result<SkillMeta, String> {
    let project_root = root_for("project", Some(&project_path))?;
    let home = home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    tokio::task::spawn_blocking(move || promote(&project_root, &home, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Freeze every Atlas symlink projection into a real copy (uninstall safety).
#[tauri::command]
pub async fn skills_freeze(
    scope: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || freeze(&root, &scope))
        .await
        .map_err(|e| e.to_string())?
}

// ── Pack ingest & parse (pack-install plan, Phase 1) ─────────────────────────────
//
// A *pack* is a directory in the Claude Code plugin layout. Parsing is
// "manifest-or-infer": `.claude-plugin/plugin.json` supplies metadata (and the
// pack name) when present, but components are always discovered from the
// conventional top-level dirs (`skills/`, `agents/`, `commands/`, `hooks/`,
// `rules/`, `scripts/`). Unknown dirs (and `.claude-plugin` itself) are ignored.
// This phase only *reads* — nothing is projected or executed here.

/// Read `<dir>/.claude-plugin/plugin.json` if present. Tolerant: a missing or
/// malformed manifest yields `None` (the pack still parses via layout inference).
fn read_pack_manifest(dir: &Path) -> Option<PluginManifest> {
    let path = dir.join(".claude-plugin").join("plugin.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Resolve the canonical pack name: the manifest `name` (sanitized) if non-empty,
/// else the directory's basename (sanitized).
fn pack_name(dir: &Path, manifest: Option<&PluginManifest>) -> Result<String, String> {
    if let Some(name) = manifest.and_then(|m| m.name.as_deref()) {
        let name = name.trim();
        if !name.is_empty() {
            return sanitize_name(name);
        }
    }
    let base = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "pack path has no directory name".to_string())?;
    sanitize_name(&base)
}

/// The repo segment of an install `source` (`owner/repo`, possibly a `.git` URL),
/// used as the pack-name fallback when the manifest has no `name`. e.g.
/// `"vercel-labs/agent-skills"` → `"agent-skills"`.
fn repo_name_from_source(source: &str) -> String {
    source
        .trim()
        .trim_end_matches('/')
        .rsplit(|c| c == '/' || c == ':')
        .next()
        .unwrap_or(source)
        .trim_end_matches(".git")
        .to_string()
}

/// Relative path of `path` under `pack_root`, with `/` separators. Rejects any
/// `..` escape (defense in depth — entries come from `read_dir`, but never trust).
fn pack_rel(pack_root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(pack_root).ok()?;
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Recursively collect regular files under `dir`, skipping dot-entries
/// (`.DS_Store`, hidden dirs). Order is unspecified — callers sort.
fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_dir() => walk_files(&entry.path(), out),
            Ok(t) if t.is_file() => out.push(entry.path()),
            _ => {}
        }
    }
}

/// Which files count as a component of this `kind`. Agents/commands/rules are
/// markdown; hooks are JSON; scripts are any file. (Skills are dir-based and
/// handled separately.)
fn kind_accepts_file(kind: ComponentKind, path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    match kind {
        ComponentKind::Agent | ComponentKind::Command | ComponentKind::Rule => {
            ext.eq_ignore_ascii_case("md")
        }
        ComponentKind::Hook => ext.eq_ignore_ascii_case("json"),
        ComponentKind::Script => true,
        ComponentKind::Skill => false,
    }
}

/// Projection leaf name for a file component: scripts keep their extension
/// (they're executed by name); everything else uses the stem (`review.md` →
/// `review`, `hooks.json` → `hooks`).
fn component_file_name(kind: ComponentKind, path: &Path) -> Option<String> {
    let part = match kind {
        ComponentKind::Script => path.file_name(),
        _ => path.file_stem(),
    };
    part.map(|s| s.to_string_lossy().to_string())
}

/// Append the components of one `kind` found under `kind_dir` to `out`.
fn collect_kind(
    pack_root: &Path,
    kind: ComponentKind,
    kind_dir: &Path,
    out: &mut Vec<PackComponent>,
) {
    if kind == ComponentKind::Skill {
        // Each immediate subdir that owns a `SKILL.md` is one skill.
        let Ok(rd) = fs::read_dir(kind_dir) else {
            return;
        };
        for entry in rd.flatten() {
            let dir = entry.path();
            if dir.is_dir() && dir.join("SKILL.md").is_file() {
                if let (Some(rel), Some(name)) = (
                    pack_rel(pack_root, &dir),
                    dir.file_name().map(|s| s.to_string_lossy().to_string()),
                ) {
                    let description = read_component_description(kind, &dir);
                    out.push(PackComponent { kind, rel_path: rel, name, description });
                }
            }
        }
        return;
    }

    let mut files = Vec::new();
    walk_files(kind_dir, &mut files);
    for file in files {
        if !kind_accepts_file(kind, &file) {
            continue;
        }
        if let (Some(rel), Some(name)) =
            (pack_rel(pack_root, &file), component_file_name(kind, &file))
        {
            let description = read_component_description(kind, &file);
            out.push(PackComponent { kind, rel_path: rel, name, description });
        }
    }
}

/// Flatten a manifest component field (`"path"` or `["a","b"]`) into paths.
fn manifest_field_paths(v: &Option<serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        _ => vec![],
    }
}

/// The (kind, relative-path) components a manifest explicitly declares.
fn manifest_declared(m: &PluginManifest) -> Vec<(ComponentKind, String)> {
    let mut out = Vec::new();
    for (kind, field) in [
        (ComponentKind::Skill, &m.skills),
        (ComponentKind::Command, &m.commands),
        (ComponentKind::Agent, &m.agents),
        (ComponentKind::Hook, &m.hooks),
    ] {
        for p in manifest_field_paths(field) {
            out.push((kind, p));
        }
    }
    out
}

/// Resolve a manifest-declared path under `pack_root` and collect its components
/// of `kind`. Handles a directory (scanned) or a direct file (e.g. a `hooks.json`
/// pointed at by `"hooks"`). Paths that don't exist or escape the root are
/// ignored — manifest content is never trusted blindly.
fn collect_manifest_path(
    pack_root: &Path,
    kind: ComponentKind,
    rel: &str,
    out: &mut Vec<PackComponent>,
) {
    let candidate = pack_root.join(rel.trim_start_matches("./"));
    if pack_rel(pack_root, &candidate).is_none() {
        return; // traversal / escape
    }
    if candidate.is_dir() {
        collect_kind(pack_root, kind, &candidate, out);
    } else if candidate.is_file()
        && kind != ComponentKind::Skill
        && kind_accepts_file(kind, &candidate)
    {
        if let (Some(rel_path), Some(name)) = (
            pack_rel(pack_root, &candidate),
            component_file_name(kind, &candidate),
        ) {
            let description = read_component_description(kind, &candidate);
            out.push(PackComponent { kind, rel_path, name, description });
        }
    }
}

/// Parse a pack directory into a [`Pack`]: read the optional manifest, then
/// enumerate components. If the manifest declares component paths
/// (`skills`/`commands`/`agents`/`hooks`) it is authoritative — only those paths
/// are collected, so unrelated top-level dirs (e.g. a product repo's build
/// `scripts/`) are not mistaken for components. Otherwise we fall back to
/// inferring from the conventional top-level layout. Output is sorted by
/// `(kind, rel_path)` for deterministic results.
fn pack_parse(dir: &Path) -> Result<Pack, String> {
    if !dir.is_dir() {
        return Err(format!("pack path is not a directory: {}", dir.display()));
    }
    let manifest = read_pack_manifest(dir);
    let name = pack_name(dir, manifest.as_ref())?;

    let mut components = Vec::new();
    let declared = manifest.as_ref().map(manifest_declared).unwrap_or_default();
    if declared.is_empty() {
        // No manifest-declared paths → infer from conventional top-level layout.
        let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in rd.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Some(kind) = ComponentKind::from_dir_name(&entry.file_name().to_string_lossy()) {
                collect_kind(dir, kind, &entry.path(), &mut components);
            }
        }
    } else {
        // Manifest is authoritative — collect only what it declares.
        for (kind, rel) in declared {
            collect_manifest_path(dir, kind, &rel, &mut components);
        }
    }
    components.sort_by(|a, b| (a.kind.as_str(), &a.rel_path).cmp(&(b.kind.as_str(), &b.rel_path)));

    Ok(Pack {
        name,
        root: dir.to_string_lossy().to_string(),
        manifest,
        components,
    })
}

/// Inspect a pack directory on disk and return its manifest + component listing.
/// Read-only — nothing is installed, projected, or executed.
#[tauri::command]
pub fn pack_inspect(dir: String) -> Result<Pack, String> {
    pack_parse(Path::new(&dir))
}

// ── Pack install from registry (pack-install plan, Phase 2) ──────────────────────
//
// Discovery uses the public skills.sh search API; content comes from the GitHub
// source repo (skills.sh's content API is auth-gated). USER DECISION: one pack =
// one source repo — fetch the whole repo via `git clone --depth 1`, parse every
// component, store it under `<root>/.atlas/packs/<repo>/`. NOTHING is executed at
// install — scripts are only placed. Projection into tool homes is Phase 3.

const SKILLS_SEARCH_URL: &str = "https://www.skills.sh/api/search";

/// One hit from the skills.sh search index. `source` is a GitHub `owner/repo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSearchHit {
    pub id: String,
    #[serde(default)]
    pub skill_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub installs: u64,
    pub source: String,
}

/// skills.sh `/api/search` envelope (only `skills` is consumed).
#[derive(Debug, Clone, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    skills: Vec<PackSearchHit>,
}

/// Outcome of an install attempt against the existing store + lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackInstallState {
    /// Not previously installed — freshly fetched.
    Fresh,
    /// Re-fetched and content changed; store + lock updated.
    Updated,
    /// Already present with identical content — no change.
    AlreadyInstalled,
    /// Store dir exists but is not Atlas-managed (no lock entry) — refused.
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInstallResult {
    pub state: PackInstallState,
    pub pack: Pack,
    pub content_hash: String,
}

/// Result of a cheap "is this pack behind its source?" check (no content fetch).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateCheck {
    /// `true` when the remote HEAD SHA differs from the installed commit.
    pub has_update: bool,
    /// The remote HEAD SHA.
    pub remote_commit: String,
}

/// An installed pack as surfaced to the UI (manifest + provenance).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPack {
    pub pack: Pack,
    pub source: String,
    pub commit: String,
    pub installed_at: u64,
    pub updated_at: u64,
}

// ── Pack lockfile (`<root>/.atlas/packs/skills-lock.json`) ────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackLockEntry {
    /// `owner/repo` the pack was installed from.
    source: String,
    /// Commit SHA captured at clone time (`git rev-parse HEAD`).
    commit: String,
    /// Content hash of the stored tree (same fn as skills — drift detection).
    content_hash: String,
    /// Unix seconds. `installed_at` is preserved across updates.
    installed_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PackLock {
    version: u32,
    packs: BTreeMap<String, PackLockEntry>,
}

impl Default for PackLock {
    fn default() -> Self {
        Self {
            version: 1,
            packs: BTreeMap::new(),
        }
    }
}

fn packs_base(root: &Path) -> PathBuf {
    root.join(".atlas").join("packs")
}

fn pack_lock_path(root: &Path) -> PathBuf {
    packs_base(root).join("skills-lock.json")
}

/// Read the pack lock, tolerating a missing or malformed file (→ empty default).
fn read_pack_lock(root: &Path) -> PackLock {
    match fs::read_to_string(pack_lock_path(root)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => PackLock::default(),
    }
}

fn write_pack_lock(root: &Path, lock: &PackLock) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(lock).map_err(|e| e.to_string())?;
    atomic_write(&pack_lock_path(root), &payload)
}

/// Canonical store dir for a pack, guarded to stay inside `<root>/.atlas/packs`
/// (mirrors [`canonical_skill_dir`]).
fn pack_store_dir(root: &Path, safe_name: &str) -> Result<PathBuf, String> {
    let base = packs_base(root);
    let dir = base.join(safe_name);
    let rel = dir
        .strip_prefix(&base)
        .map_err(|_| "path escapes packs base".to_string())?;
    let mut comps = rel.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if seg == std::ffi::OsStr::new(safe_name) => Ok(dir),
        _ => Err(format!("unsafe resolved pack path for {safe_name:?}")),
    }
}

// ── GitHub source resolution + fetch ──────────────────────────────────────────

/// A safe GitHub `owner`/`repo` segment: ASCII alnum plus `.`/`_`/`-`, never
/// leading `-` (so it can't be misread as a `git` flag). Keeps the values safe
/// as clone-URL components and process arguments.
fn is_safe_gh_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Parse a skills.sh `source` into `(owner, repo)`. Accepts `owner/repo`,
/// `owner/repo/extra…` (extra ignored), and `https://github.com/owner/repo[.git]`.
fn parse_owner_repo(source: &str) -> Result<(String, String), String> {
    let s = source.trim();
    let s = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .or_else(|| s.strip_prefix("github.com/"))
        .unwrap_or(s);
    let mut parts = s.split('/').filter(|p| !p.is_empty());
    let owner = parts
        .next()
        .ok_or_else(|| format!("invalid source: {source:?}"))?;
    let repo = parts
        .next()
        .ok_or_else(|| format!("invalid source (need owner/repo): {source:?}"))?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !is_safe_gh_segment(owner) || !is_safe_gh_segment(repo) {
        return Err(format!("unsafe source segments: {source:?}"));
    }
    Ok((owner.to_string(), repo.to_string()))
}

/// Unique (not-yet-created) temp path for a clone.
fn temp_clone_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    let uniq = format!(
        "atlas-pack-clone-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    p.push(uniq);
    p
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Shallow-clone `owner/repo` into `dest` (must not pre-exist) and return the
/// HEAD commit SHA. Never prompts — auth failures fail fast.
fn git_clone_shallow(owner: &str, repo: &str, dest: &Path) -> Result<String, String> {
    let url = format!("https://github.com/{owner}/{repo}.git");
    let out = std::process::Command::new("git")
        .args(["clone", "--depth", "1", "--no-tags", "--"])
        .arg(&url)
        .arg(dest)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .output()
        .map_err(|e| format!("failed to run `git` (is it installed?): {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git clone of {owner}/{repo} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let rev = std::process::Command::new("git")
        .arg("-C")
        .arg(dest)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("failed to read HEAD: {e}"))?;
    Ok(String::from_utf8_lossy(&rev.stdout).trim().to_string())
}

/// Resolve the remote default-branch HEAD SHA WITHOUT fetching content
/// (`git ls-remote <url> HEAD`). Network-only, auth-free for public repos, never
/// prompts. Used to detect whether an installed pack is behind its source.
fn git_ls_remote_head(owner: &str, repo: &str) -> Result<String, String> {
    let url = format!("https://github.com/{owner}/{repo}.git");
    let out = std::process::Command::new("git")
        .args(["ls-remote", "--quiet"])
        .arg(&url)
        .arg("HEAD")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("failed to run `git` (is it installed?): {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git ls-remote of {owner}/{repo} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // Output is `<sha>\tHEAD` — take the first whitespace-delimited token.
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "git ls-remote returned no HEAD".to_string())
}

/// Clone `owner/repo` to a temp dir and strip its `.git`. Returns
/// `(temp_dir, commit_sha)`; the caller must remove `temp_dir` when done.
fn fetch_repo_to_temp(owner: &str, repo: &str) -> Result<(PathBuf, String), String> {
    let dest = temp_clone_path();
    match git_clone_shallow(owner, repo, &dest) {
        Ok(commit) => {
            // Drop VCS metadata so it never lands in the store or content hash.
            let _ = fs::remove_dir_all(dest.join(".git"));
            Ok((dest, commit))
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&dest);
            Err(e)
        }
    }
}

/// Install an already-fetched pack tree (`src`, `.git` stripped) into the store,
/// applying dedup against the lock. Network-free, so unit-testable.
fn install_pack_from_dir(
    root: &Path,
    src: &Path,
    source: &str,
    commit: &str,
    force: bool,
) -> Result<PackInstallResult, String> {
    let parsed_src = pack_parse(src)?;
    // `pack_name` falls back to the source DIR basename when the manifest has no
    // `name` — but at install time `src` is a throwaway clone dir
    // (`atlas-pack-clone-<pid>-<ts>`), which would become the pack's name. Prefer
    // the manifest name, else the source repo name (`owner/repo` → `repo`).
    let name = parsed_src
        .manifest
        .as_ref()
        .and_then(|m| m.name.as_deref())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| repo_name_from_source(source));
    let safe = sanitize_name(&name)?;
    let store = pack_store_dir(root, &safe)?;
    let new_hash = hash_skill_dir(src);

    let mut lock = read_pack_lock(root);
    let prior = lock.packs.get(&safe).cloned();

    if store.exists() {
        match &prior {
            // Present but unmanaged → refuse to clobber unless forced.
            None if !force => {
                let pack = pack_parse(&store).unwrap_or(parsed_src);
                return Ok(PackInstallResult {
                    state: PackInstallState::Conflict,
                    pack,
                    content_hash: new_hash,
                });
            }
            // Managed + identical content → no-op.
            Some(entry) if entry.content_hash == new_hash => {
                let pack = pack_parse(&store)?;
                return Ok(PackInstallResult {
                    state: PackInstallState::AlreadyInstalled,
                    pack,
                    content_hash: new_hash,
                });
            }
            _ => {}
        }
        fs::remove_dir_all(&store).map_err(|e| e.to_string())?;
    }

    copy_dir_all(src, &store)?;

    let now = now_unix_secs();
    let (installed_at, state) = match &prior {
        Some(prev) => (prev.installed_at, PackInstallState::Updated),
        None => (now, PackInstallState::Fresh),
    };
    lock.packs.insert(
        safe,
        PackLockEntry {
            source: source.to_string(),
            commit: commit.to_string(),
            content_hash: new_hash.clone(),
            installed_at,
            updated_at: now,
        },
    );
    write_pack_lock(root, &lock)?;

    let pack = pack_parse(&store)?;
    Ok(PackInstallResult {
        state,
        pack,
        content_hash: new_hash,
    })
}

/// List installed packs (lock ∩ on-disk store dirs).
fn list_installed_packs(root: &Path) -> Result<Vec<InstalledPack>, String> {
    let lock = read_pack_lock(root);
    let base = packs_base(root);
    let mut out = Vec::new();
    for (name, entry) in &lock.packs {
        let dir = base.join(name);
        if !dir.is_dir() {
            continue;
        }
        if let Ok(pack) = pack_parse(&dir) {
            out.push(InstalledPack {
                pack,
                source: entry.source.clone(),
                commit: entry.commit.clone(),
                installed_at: entry.installed_at,
                updated_at: entry.updated_at,
            });
        }
    }
    Ok(out)
}

// ── Pack commands ─────────────────────────────────────────────────────────────

/// Search the skills.sh registry. Discovery only — no content is fetched.
#[tauri::command]
pub async fn pack_search(query: String) -> Result<Vec<PackSearchHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::new();
    let resp = client
        .get(SKILLS_SEARCH_URL)
        .query(&[("q", q.as_str())])
        .header("User-Agent", "atlas")
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("search failed: HTTP {}", resp.status()));
    }
    let body: SearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad search response: {e}"))?;
    Ok(body.skills)
}

/// Fetch a pack's source repo and parse it WITHOUT installing — for the
/// install-preview UI (shows every component the pack ships).
#[tauri::command]
pub async fn pack_remote_preview(source: String) -> Result<Pack, String> {
    let (owner, repo) = parse_owner_repo(&source)?;
    tokio::task::spawn_blocking(move || {
        let (tmp, _commit) = fetch_repo_to_temp(&owner, &repo)?;
        let result = pack_parse(&tmp);
        let _ = fs::remove_dir_all(&tmp);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Install a pack from its GitHub source repo into the store. Fetches the whole
/// repo, dedups against the lock, writes `skills-lock.json`. No projection
/// (Phase 3) and no script execution.
#[tauri::command]
pub async fn pack_install_remote(
    app: AppHandle,
    scope: String,
    source: String,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<PackInstallResult, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    let source_ev = source.clone();
    let scope_ev = scope.clone();
    let res = tokio::task::spawn_blocking(move || {
        let (owner, repo) = parse_owner_repo(&source)?;
        let (tmp, commit) = fetch_repo_to_temp(&owner, &repo)?;
        let result = install_pack_from_dir(&root, &tmp, &source, &commit, force);
        let _ = fs::remove_dir_all(&tmp);
        result
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(result) = &res {
        app.state::<Arc<crate::telemetry::TelemetryClient>>().capture(
            "pack_installed",
            serde_json::json!({
                "source": source_ev,
                "scope": scope_ev,
                "skill_count": result.pack.components.len(),
            }),
        );
    }
    res
}

/// Install ONE skill from a cloned repo into the canonical store — the granular
/// counterpart to `install_pack_from_dir`. The skills.sh registry lists
/// individual skills (one `source` repo holds many), so installing a Discover row
/// should add just THAT skill as a managed skill (individually projectable +
/// uninstallable), not the whole repo. Network-free → unit-testable.
fn install_skill_from_dir(
    root: &Path,
    scope: &str,
    repo: &Path,
    skill_id: &str,
) -> Result<SkillMeta, String> {
    let parsed = pack_parse(repo)?;
    let comp = parsed
        .components
        .iter()
        .find(|c| c.kind == ComponentKind::Skill && c.name == skill_id)
        .ok_or_else(|| format!("skill '{skill_id}' not found in this repo"))?;
    let src_dir = repo.join(&comp.rel_path);
    if !src_dir.join("SKILL.md").is_file() {
        return Err(format!("skill '{skill_id}' has no SKILL.md"));
    }

    let safe = sanitize_name(skill_id)?;
    let dst = canonical_skill_dir(&skills_base(root), &safe)?;
    if dst.exists() {
        fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&src_dir, &dst)?;

    // Project immediately into every currently-detected agent, the way
    // `npx skills add` does (ADR 0003) — a freshly installed skill must be
    // visible right away, not stuck until the user finds the per-agent toggles
    // in another tab. Same fan-out `adopt_skill`/`promote` use; the per-agent
    // toggles remain for changing your mind later.
    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY {
        if !tool_detected(root, def) || def.delivery == "inject-only" {
            continue;
        }
        project(root, def, scope, &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(dst.join("SKILL.md")).map_err(|e| e.to_string())?;
    let (fm, _b) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: scope.to_string(),
        enabled_agents,
        path: dst.join("SKILL.md").to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

/// Install a single skill (`skill_id`) from a GitHub `source` repo as a managed
/// skill. Granular alternative to `pack_install_remote`.
#[tauri::command]
pub async fn pack_install_skill(
    app: AppHandle,
    scope: String,
    source: String,
    skill_id: String,
    project_path: Option<String>,
) -> Result<SkillMeta, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    // Cloned for the telemetry event (the closure moves the originals). `source`
    // is a public GitHub `owner/repo` slug; `scope` is "global"/"project".
    let source_ev = source.clone();
    let scope_ev = scope.clone();
    // The REGISTRY id, which `skill` (the installed SKILL.md's frontmatter name)
    // is not: the two can differ, so a per-skill install rollup keyed on `skill`
    // could not be joined back to the registry row the Discover table renders.
    // `(source, skill_id)` is that row's identity.
    let skill_id_ev = skill_id.clone();
    let res = tokio::task::spawn_blocking(move || {
        let (owner, repo) = parse_owner_repo(&source)?;
        let (tmp, _commit) = fetch_repo_to_temp(&owner, &repo)?;
        let res = install_skill_from_dir(&root, &scope, &tmp, &skill_id);
        let _ = fs::remove_dir_all(&tmp);
        res
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(meta) = &res {
        app.state::<Arc<crate::telemetry::TelemetryClient>>().capture(
            "skill_downloaded",
            serde_json::json!({
                "skill": meta.name,
                "skill_id": skill_id_ev,
                "source": source_ev,
                "scope": scope_ev,
            }),
        );
    }
    res
}

/// List packs installed in this scope (manifest + provenance).
#[tauri::command]
pub async fn pack_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<InstalledPack>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || list_installed_packs(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// Cheaply check whether an installed pack is behind its source repo: compares
/// the remote HEAD SHA (`git ls-remote`, no clone) to the commit in the lock.
/// Read-only — applying the update is `pack_install_remote`.
#[tauri::command]
pub async fn pack_check_update(
    scope: String,
    pack: String,
    project_path: Option<String>,
) -> Result<PackUpdateCheck, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let safe = sanitize_name(&pack)?;
        let lock = read_pack_lock(&root);
        let entry = lock
            .packs
            .get(&safe)
            .ok_or_else(|| format!("pack not installed: {pack}"))?;
        let (owner, repo) = parse_owner_repo(&entry.source)?;
        let remote = git_ls_remote_head(&owner, &repo)?;
        Ok(PackUpdateCheck {
            has_update: remote != entry.commit,
            remote_commit: remote,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Pack projection (pack-install plan, Phase 3) ─────────────────────────────────
//
// Project an INSTALLED pack's components from the store
// (`<root>/.atlas/packs/<pack>/<relPath>`) into a tool's homes, routed by
// `ComponentKind` via the Phase 0 `ToolDef.homes` table. Dir-style kinds are
// symlinked (copy fallback); hooks merge into `settings.json`; rules append to a
// flat file. Scripts are never projected. Every projection is recorded in a
// dedicated pack-projection ledger so unproject can undo precisely.

const ATLAS_PACK_TAG: &str = "_atlasPack";

/// One recorded pack-component projection (for precise un-projection).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackProjEntry {
    kind: ComponentKind,
    /// Component path relative to the pack store root (e.g. `agents/rev.md`).
    rel_path: String,
    /// Leaf in the tool home (e.g. `rev.md`, `foo`) or the rule/marker name.
    leaf: String,
    /// `"symlink" | "copy" | "settings-merge" | "append"`.
    mode: String,
    /// Target path relative to `<root>` that received the projection.
    target_rel: String,
}

/// `<root>/.atlas/packs/.pack-projections.json`: pack → toolId → entries.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PackProj {
    version: u32,
    projections: BTreeMap<String, BTreeMap<String, Vec<PackProjEntry>>>,
}

impl Default for PackProj {
    fn default() -> Self {
        Self {
            version: 1,
            projections: BTreeMap::new(),
        }
    }
}

fn pack_proj_path(root: &Path) -> PathBuf {
    packs_base(root).join(".pack-projections.json")
}

/// Read the pack-projection ledger, tolerating a missing/garbage file.
fn read_pack_proj(root: &Path) -> PackProj {
    match fs::read_to_string(pack_proj_path(root)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => PackProj::default(),
    }
}

fn write_pack_proj(root: &Path, proj: &PackProj) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(proj).map_err(|e| e.to_string())?;
    atomic_write(&pack_proj_path(root), &payload)
}

/// Per-component outcome reported back to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProjectReport {
    pub kind: ComponentKind,
    pub name: String,
    pub mode: String,
    /// `"projected" | "skipped" | "conflict"`.
    pub status: String,
}

/// Read-only ledger row for a single pack (flattened across tools).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProjectionView {
    pub tool: String,
    pub kind: ComponentKind,
    pub name: String,
    pub mode: String,
    pub target_rel: String,
}

/// Map a kind tag (`"agent"`, `"skill"`, …) to a `ComponentKind`.
fn kind_from_tag(s: &str) -> Option<ComponentKind> {
    match s.trim().to_lowercase().as_str() {
        "skill" => Some(ComponentKind::Skill),
        "agent" => Some(ComponentKind::Agent),
        "command" => Some(ComponentKind::Command),
        "hook" => Some(ComponentKind::Hook),
        "rule" => Some(ComponentKind::Rule),
        "script" => Some(ComponentKind::Script),
        _ => None,
    }
}

/// Projection leaf for a file component: the component name plus the original
/// extension from its `rel_path` (`rev` + `agents/rev.md` → `rev.md`).
fn comp_leaf(rel_path: &str, name: &str) -> String {
    match Path::new(rel_path).extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{name}.{ext}"),
        None => name.to_string(),
    }
}

/// `p` relative to `root` as a `/`-joined string (for ledger storage).
fn rel_to_root(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// Relative path from `link`'s parent dir to `dest` (both absolute). `None` when
/// they share no common base (caller falls back to an absolute target).
fn relative_link_target(link: &Path, dest: &Path) -> Option<PathBuf> {
    let base = link.parent()?;
    let base_comps = base.components().collect::<Vec<_>>();
    let dest_comps = dest.components().collect::<Vec<_>>();
    let mut i = 0;
    while i < base_comps.len() && i < dest_comps.len() && base_comps[i] == dest_comps[i] {
        i += 1;
    }
    if i == 0 {
        return None; // no shared prefix (e.g. different roots)
    }
    let mut out = PathBuf::new();
    for _ in i..base_comps.len() {
        out.push("..");
    }
    for c in &dest_comps[i..] {
        out.push(c.as_os_str());
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Symlink (or copy-fallback) `src_abs` → `target_abs`. Returns the mode used
/// (`"symlink"`/`"copy"`). Clears any existing entry first; creates parent dirs.
fn link_or_copy_into(
    src_abs: &Path,
    target_abs: &Path,
    supports_symlink: bool,
) -> Result<String, String> {
    if let Some(parent) = target_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(target_abs)?;

    if supports_symlink {
        let link_target =
            relative_link_target(target_abs, src_abs).unwrap_or_else(|| src_abs.to_path_buf());
        if symlink(&link_target, target_abs).is_ok() {
            return Ok("symlink".to_string());
        }
    }
    if src_abs.is_dir() {
        copy_dir_all(src_abs, target_abs)?;
    } else {
        fs::copy(src_abs, target_abs).map_err(|e| e.to_string())?;
    }
    Ok("copy".to_string())
}

/// The `_atlasPack` tag on a hook entry, if any.
fn entry_pack_tag(entry: &serde_json::Value) -> Option<&str> {
    entry.get(ATLAS_PACK_TAG).and_then(|v| v.as_str())
}

/// Merge a pack's hooks JSON into a tool settings file, tagging each injected
/// top-level entry with `_atlasPack=<pack>`. Idempotent: prior entries for this
/// pack are dropped first. Preserves all other settings keys.
/// Single-quote a string for safe use in a POSIX shell command.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolve a pack's plugin root in every hook `command` so bundled scripts load
/// once the hooks are merged into a plain `settings.json`.
///
/// Claude Code only defines `CLAUDE_PLUGIN_ROOT` for *real* plugin hooks; a
/// merged settings.json hook runs without it, so two breakage shapes appear:
///   1. literal `${CLAUDE_PLUGIN_ROOT}/foo.js` paths expand to nothing, and
///   2. self-bootstrapping hooks (e.g. ECC) read `process.env.CLAUDE_PLUGIN_ROOT`
///      at runtime, fall back to `~/.claude`, and `require` a missing script
///      (`cjs/loader` throws on every fire).
///
/// We fix both: substitute the literal placeholder with the absolute store path,
/// then prepend `CLAUDE_PLUGIN_ROOT=<store>` as a leading shell assignment so the
/// runtime lookup resolves too. Recurses through the nested `hooks` arrays Claude
/// Code uses; only touches `type:"command"` leaves (the default when unset).
fn rewrite_hook_commands(value: &mut serde_json::Value, plugin_root: &str) {
    match value {
        serde_json::Value::Object(map) => {
            let is_command = map
                .get("type")
                .and_then(|t| t.as_str())
                .map(|t| t == "command")
                .unwrap_or(true);
            if is_command {
                if let Some(serde_json::Value::String(cmd)) = map.get_mut("command") {
                    let resolved = cmd
                        .replace("${CLAUDE_PLUGIN_ROOT}", plugin_root)
                        .replace("$CLAUDE_PLUGIN_ROOT", plugin_root);
                    // Skip only if the command *opens* with the assignment already
                    // (an inner `process.env.CLAUDE_PLUGIN_ROOT=` must not count).
                    *cmd = if resolved.trim_start().starts_with("CLAUDE_PLUGIN_ROOT=") {
                        resolved
                    } else {
                        format!(
                            "CLAUDE_PLUGIN_ROOT={} {}",
                            sh_single_quote(plugin_root),
                            resolved
                        )
                    };
                }
            }
            for v in map.values_mut() {
                rewrite_hook_commands(v, plugin_root);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                rewrite_hook_commands(v, plugin_root);
            }
        }
        _ => {}
    }
}

fn merge_hooks_into_settings(
    settings_path: &Path,
    hooks_src: &Path,
    pack: &str,
    plugin_root: &Path,
) -> Result<(), String> {
    let incoming: serde_json::Value = {
        let raw = fs::read_to_string(hooks_src).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("invalid hooks json: {e}"))?
    };
    let Some(incoming_hooks) = incoming.get("hooks").and_then(|h| h.as_object()) else {
        return Ok(());
    };

    let mut settings: serde_json::Value = match fs::read_to_string(settings_path) {
        Ok(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| format!("invalid settings json: {e}"))?
        }
        _ => serde_json::json!({}),
    };
    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    {
        let obj = settings.as_object_mut().unwrap();
        let hooks_entry = obj
            .entry("hooks".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !hooks_entry.is_object() {
            *hooks_entry = serde_json::json!({});
        }
        let hooks_obj = hooks_entry.as_object_mut().unwrap();
        for (event, arr) in incoming_hooks {
            let Some(arr) = arr.as_array() else {
                continue;
            };
            let dst = hooks_obj
                .entry(event.clone())
                .or_insert_with(|| serde_json::json!([]));
            if !dst.is_array() {
                *dst = serde_json::json!([]);
            }
            let dst_arr = dst.as_array_mut().unwrap();
            dst_arr.retain(|e| entry_pack_tag(e) != Some(pack));
            for entry in arr {
                let mut tagged = entry.clone();
                rewrite_hook_commands(&mut tagged, &plugin_root.to_string_lossy());
                if let Some(o) = tagged.as_object_mut() {
                    o.insert(
                        ATLAS_PACK_TAG.to_string(),
                        serde_json::Value::String(pack.to_string()),
                    );
                }
                dst_arr.push(tagged);
            }
        }
    }

    let payload = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(settings_path, &payload)
}

/// Strip every hook entry tagged for `pack` from a settings file. Best-effort.
fn remove_pack_hooks_from_settings(settings_path: &Path, pack: &str) -> Result<(), String> {
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return Ok(());
    };
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut settings: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_event, arr) in hooks.iter_mut() {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|e| entry_pack_tag(e) != Some(pack));
            }
        }
    }
    let payload = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(settings_path, &payload)
}

fn rule_marker_start(pack: &str, rule: &str) -> String {
    format!("<!-- atlas-pack:{pack}:{rule} START -->")
}

fn rule_marker_end(pack: &str, rule: &str) -> String {
    format!("<!-- atlas-pack:{pack}:{rule} END -->")
}

/// Append (or replace in place) a marked rule block in a flat text file.
fn append_rule_block(target: &Path, pack: &str, rule: &str, content: &str) -> Result<(), String> {
    let start = rule_marker_start(pack, rule);
    let end = rule_marker_end(pack, rule);
    let block = format!("{start}\n{}\n{end}", content.trim_end());

    let existing = fs::read_to_string(target).unwrap_or_default();
    let new_body = match (existing.find(&start), existing.find(&end)) {
        (Some(s), Some(e)) if e > s => {
            let e_end = e + end.len();
            let mut out = String::with_capacity(existing.len());
            out.push_str(&existing[..s]);
            out.push_str(&block);
            out.push_str(&existing[e_end..]);
            out
        }
        _ => {
            let mut out = existing;
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&block);
            out.push('\n');
            out
        }
    };
    atomic_write(target, &new_body)
}

/// Remove a marked rule block (best-effort).
fn remove_rule_block(target: &Path, pack: &str, rule: &str) -> Result<(), String> {
    let Ok(existing) = fs::read_to_string(target) else {
        return Ok(());
    };
    let start = rule_marker_start(pack, rule);
    let end = rule_marker_end(pack, rule);
    if let (Some(s), Some(e)) = (existing.find(&start), existing.find(&end)) {
        if e > s {
            let e_end = e + end.len();
            let mut out = String::with_capacity(existing.len());
            out.push_str(existing[..s].trim_end());
            out.push_str(&existing[e_end..]);
            return atomic_write(target, &out);
        }
    }
    Ok(())
}

/// Is `target` an existing entry we do NOT own (not recorded for this pack+tool)?
/// `force` always returns false (overwrite allowed).
fn is_foreign_conflict(
    root: &Path,
    target: &Path,
    safe_pack: &str,
    tool_id: &str,
    proj: &PackProj,
    force: bool,
) -> bool {
    if force || target.symlink_metadata().is_err() {
        return false;
    }
    let target_rel = rel_to_root(root, target);
    let owned = proj
        .projections
        .get(safe_pack)
        .and_then(|m| m.get(tool_id))
        .map(|entries| entries.iter().any(|e| e.target_rel == target_rel))
        .unwrap_or(false);
    !owned
}

/// Project all (or a kind-filtered subset of) an installed pack's components into
/// `tool_id`. Records each projection in the pack-projection ledger.
fn project_pack(
    root: &Path,
    scope: &str,
    pack: &str,
    tool_id: &str,
    kinds: Option<&[ComponentKind]>,
    force: bool,
) -> Result<Vec<PackProjectReport>, String> {
    let safe_pack = sanitize_name(pack)?;
    let store = pack_store_dir(root, &safe_pack)?;
    if !store.is_dir() {
        return Err(format!("pack not installed: {pack}"));
    }
    let def = tool_def(tool_id).ok_or_else(|| format!("unknown tool: {tool_id}"))?;
    let parsed = pack_parse(&store)?;

    let mut proj = read_pack_proj(root);
    let mut new_entries: Vec<PackProjEntry> = Vec::new();
    let mut report: Vec<PackProjectReport> = Vec::new();

    for comp in &parsed.components {
        if let Some(filter) = kinds {
            if !filter.contains(&comp.kind) {
                continue;
            }
        }
        let src_abs = store.join(&comp.rel_path);

        // Scripts are placed in the store but never projected.
        if comp.kind == ComponentKind::Script {
            report.push(PackProjectReport {
                kind: comp.kind,
                name: comp.name.clone(),
                mode: "skip".to_string(),
                status: "skipped".to_string(),
            });
            continue;
        }

        // Skills use the tool skills dir (not represented in `homes`).
        if comp.kind == ComponentKind::Skill {
            let safe_leaf = sanitize_name(&comp.name)?;
            let target = tool_skills_dir(def, scope, root).join(&safe_leaf);
            if is_foreign_conflict(root, &target, &safe_pack, tool_id, &proj, force) {
                report.push(conflict_report(comp));
                continue;
            }
            let mode = link_or_copy_into(&src_abs, &target, def.supports_symlink)?;
            new_entries.push(PackProjEntry {
                kind: comp.kind,
                rel_path: comp.rel_path.clone(),
                leaf: safe_leaf,
                mode: mode.clone(),
                target_rel: rel_to_root(root, &target),
            });
            report.push(projected_report(comp, &mode));
            continue;
        }

        // Everything else routes through the tool home for its kind/scope.
        let Some(home) = tool_home(def, comp.kind, scope) else {
            report.push(PackProjectReport {
                kind: comp.kind,
                name: comp.name.clone(),
                mode: "unsupported".to_string(),
                status: "skipped".to_string(),
            });
            continue;
        };
        match home.style {
            HomeStyle::Dir => {
                let leaf = comp_leaf(&comp.rel_path, &comp.name);
                let target = root.join(home.rel).join(&leaf);
                if is_foreign_conflict(root, &target, &safe_pack, tool_id, &proj, force) {
                    report.push(conflict_report(comp));
                    continue;
                }
                let mode = link_or_copy_into(&src_abs, &target, def.supports_symlink)?;
                new_entries.push(PackProjEntry {
                    kind: comp.kind,
                    rel_path: comp.rel_path.clone(),
                    leaf,
                    mode: mode.clone(),
                    target_rel: rel_to_root(root, &target),
                });
                report.push(projected_report(comp, &mode));
            }
            HomeStyle::SettingsMerge => {
                let target = root.join(home.rel);
                merge_hooks_into_settings(&target, &src_abs, &safe_pack, &store)?;
                new_entries.push(PackProjEntry {
                    kind: comp.kind,
                    rel_path: comp.rel_path.clone(),
                    leaf: comp.name.clone(),
                    mode: "settings-merge".to_string(),
                    target_rel: home.rel.to_string(),
                });
                report.push(projected_report(comp, "settings-merge"));
            }
            HomeStyle::AppendFile => {
                let target = root.join(home.rel);
                let content = fs::read_to_string(&src_abs).map_err(|e| e.to_string())?;
                let rule = sanitize_name(&comp.name)?;
                append_rule_block(&target, &safe_pack, &rule, &content)?;
                new_entries.push(PackProjEntry {
                    kind: comp.kind,
                    rel_path: comp.rel_path.clone(),
                    leaf: rule,
                    mode: "append".to_string(),
                    target_rel: home.rel.to_string(),
                });
                report.push(projected_report(comp, "append"));
            }
        }
    }

    // Merge into the ledger: keep prior entries for kinds we didn't touch this
    // run (so a kind-filtered project doesn't orphan other kinds' records).
    let tool_entries = proj
        .projections
        .entry(safe_pack)
        .or_default()
        .entry(tool_id.to_string())
        .or_default();
    match kinds {
        Some(filter) => tool_entries.retain(|e| !filter.contains(&e.kind)),
        None => tool_entries.clear(),
    }
    tool_entries.extend(new_entries);
    write_pack_proj(root, &proj)?;

    Ok(report)
}

fn projected_report(comp: &PackComponent, mode: &str) -> PackProjectReport {
    PackProjectReport {
        kind: comp.kind,
        name: comp.name.clone(),
        mode: mode.to_string(),
        status: "projected".to_string(),
    }
}

fn conflict_report(comp: &PackComponent) -> PackProjectReport {
    PackProjectReport {
        kind: comp.kind,
        name: comp.name.clone(),
        mode: "conflict".to_string(),
        status: "conflict".to_string(),
    }
}

/// Undo every recorded projection for `(pack, tool)` and drop the ledger subtree.
fn unproject_pack(root: &Path, pack: &str, tool_id: &str) -> Result<(), String> {
    let safe_pack = sanitize_name(pack)?;
    let mut proj = read_pack_proj(root);
    let entries = proj
        .projections
        .get(&safe_pack)
        .and_then(|m| m.get(tool_id))
        .cloned()
        .unwrap_or_default();

    for e in &entries {
        let target = root.join(&e.target_rel);
        match e.mode.as_str() {
            "settings-merge" => remove_pack_hooks_from_settings(&target, &safe_pack)?,
            "append" => remove_rule_block(&target, &safe_pack, &e.leaf)?,
            _ => {
                let _ = clear_entry(&target);
            }
        }
    }

    if let Some(tools) = proj.projections.get_mut(&safe_pack) {
        tools.remove(tool_id);
        if tools.is_empty() {
            proj.projections.remove(&safe_pack);
        }
    }
    write_pack_proj(root, &proj)
}

/// Flatten the ledger for one pack into a UI view (across tools).
fn list_pack_projections(root: &Path, pack: &str) -> Result<Vec<PackProjectionView>, String> {
    let safe = sanitize_name(pack)?;
    let proj = read_pack_proj(root);
    let mut out = Vec::new();
    if let Some(tools) = proj.projections.get(&safe) {
        for (tool, entries) in tools {
            for e in entries {
                out.push(PackProjectionView {
                    tool: tool.clone(),
                    kind: e.kind,
                    name: e.leaf.clone(),
                    mode: e.mode.clone(),
                    target_rel: e.target_rel.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// One invokable pack-delivered component (command/agent/rule) for the Skills
/// list and the `#<kind>:` mention rail. Skills already flow through
/// `list_skills`; hooks/scripts are not chat-invokable and are excluded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackComponentMeta {
    pub pack: String,
    /// `"command" | "agent" | "rule"` (lowercase serde).
    pub kind: ComponentKind,
    pub name: String,
    /// Component path within the pack store (e.g. `commands/ship.md`).
    pub rel_path: String,
    /// Absolute path to the component's body file (the `.md`).
    pub path: String,
    pub description: String,
    /// Registry tool ids (agents) this component is currently projected to —
    /// i.e. enabled for. Empty = not projected anywhere. Lets the chat `#` rail
    /// hide components a pack has disabled for the active agent.
    pub enabled_agents: Vec<String>,
}

/// Pack component kinds that are chat-invokable — their body is a usable prompt
/// or context. Skills are handled separately; hooks (settings JSON) and scripts
/// (executables) are not invokable.
fn is_invokable_component(kind: ComponentKind) -> bool {
    matches!(
        kind,
        ComponentKind::Agent | ComponentKind::Command | ComponentKind::Rule
    )
}

/// Every invokable component (command/agent/rule) shipped by an installed pack,
/// read-only from the pack store. Reused by the Skills list and the `#` picker.
fn pack_components(root: &Path) -> Vec<PackComponentMeta> {
    let mut out = Vec::new();
    // Per-agent gating data: the pack projection ledger records which tools
    // (agents) each pack component is projected to. Read once for the whole scan.
    let proj = read_pack_proj(root);
    for installed in list_installed_packs(root).unwrap_or_default() {
        let pack_safe = sanitize_name(&installed.pack.name).ok();
        for comp in &installed.pack.components {
            if !is_invokable_component(comp.kind) {
                continue;
            }
            let path = Path::new(&installed.pack.root).join(&comp.rel_path);
            let description = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| parse_frontmatter(&raw).0.description)
                .unwrap_or_default();
            // Tools this component is currently projected to (= enabled for that
            // agent), matched by (kind, rel_path) in the pack projection ledger.
            let enabled_agents: Vec<String> = pack_safe
                .as_ref()
                .and_then(|safe| proj.projections.get(safe))
                .map(|tools| {
                    tools
                        .iter()
                        .filter(|(_tool, entries)| {
                            entries
                                .iter()
                                .any(|e| e.kind == comp.kind && e.rel_path == comp.rel_path)
                        })
                        .map(|(tool, _)| tool.clone())
                        .collect()
                })
                .unwrap_or_default();
            out.push(PackComponentMeta {
                pack: installed.pack.name.clone(),
                kind: comp.kind,
                name: comp.name.clone(),
                rel_path: comp.rel_path.clone(),
                path: path.to_string_lossy().to_string(),
                description,
                enabled_agents,
            });
        }
    }
    out.sort_by(|a, b| {
        (a.kind.as_str(), &a.name).cmp(&(b.kind.as_str(), &b.name))
    });
    out
}

// ── Pack projection commands ──────────────────────────────────────────────────

/// Project an installed pack's components into a tool (optionally kind-filtered).
#[tauri::command]
pub async fn pack_project(
    scope: String,
    pack: String,
    tool: String,
    kinds: Option<Vec<String>>,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<Vec<PackProjectReport>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    let kind_filter: Option<Vec<ComponentKind>> =
        kinds.map(|v| v.iter().filter_map(|s| kind_from_tag(s)).collect());
    tokio::task::spawn_blocking(move || {
        project_pack(&root, &scope, &pack, &tool, kind_filter.as_deref(), force)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo every projection of a pack into a tool.
#[tauri::command]
pub async fn pack_unproject(
    scope: String,
    pack: String,
    tool: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || unproject_pack(&root, &pack, &tool))
        .await
        .map_err(|e| e.to_string())?
}

/// Fully remove an installed pack: unproject it from every tool it's recorded
/// in (clears the tool homes), delete its store dir, and drop its lock entry.
/// Idempotent — uninstalling a pack that isn't present is a no-op success.
#[tauri::command]
pub async fn pack_uninstall(
    scope: String,
    pack: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let safe = sanitize_name(&pack)?;
        // 1. Unproject from every tool it's recorded in.
        let tool_ids: Vec<String> = read_pack_proj(&root)
            .projections
            .get(&safe)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        for tool_id in tool_ids {
            unproject_pack(&root, &pack, &tool_id)?;
        }
        // 2. Delete the canonical store dir.
        let store = pack_store_dir(&root, &safe)?;
        if store.exists() {
            fs::remove_dir_all(&store)
                .map_err(|e| format!("remove {}: {e}", store.display()))?;
        }
        // 3. Drop the lock entry.
        let mut lock = read_pack_lock(&root);
        lock.packs.remove(&safe);
        write_pack_lock(&root, &lock)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read-only projection ledger view for one pack.
#[tauri::command]
pub async fn pack_projections(
    scope: String,
    pack: String,
    project_path: Option<String>,
) -> Result<Vec<PackProjectionView>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || list_pack_projections(&root, &pack))
        .await
        .map_err(|e| e.to_string())?
}

/// Every invokable component (command/agent/rule) across installed packs, for
/// the Skills list and the `#<kind>:` mention rail. Read-only.
#[tauri::command]
pub async fn pack_components_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<PackComponentMeta>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || pack_components(&root))
        .await
        .map_err(|e| e.to_string())
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        let uniq = format!(
            "atlas-skills-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(uniq);
        fs::create_dir_all(&p).unwrap();
        // Make both v1 tools "detected".
        fs::create_dir_all(p.join(".claude")).unwrap();
        fs::create_dir_all(p.join(".codex")).unwrap();
        p
    }

    #[test]
    fn sanitize_lowercases_and_replaces_spaces() {
        assert_eq!(sanitize_name("My Cool Skill").unwrap(), "my-cool-skill");
        assert_eq!(sanitize_name("PDF Extract").unwrap(), "pdf-extract");
        assert_eq!(sanitize_name("a   b").unwrap(), "a-b"); // collapse runs
    }

    #[test]
    fn sanitize_rejects_traversal() {
        // "../evil" → disallowed chars become '-', leading dashes stripped → "evil".
        let safe = sanitize_name("../evil").unwrap();
        assert_eq!(safe, "evil");
        assert!(!safe.contains('/'));
        assert!(!safe.contains(".."));
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name("///").is_err());
        assert!(sanitize_name("...").is_err());
    }

    #[test]
    fn canonical_dir_stays_in_base() {
        let root = tmp_root();
        let base = skills_base(&root);
        let dir = canonical_skill_dir(&base, "pdf-extract").unwrap();
        assert!(dir.starts_with(&base));
        assert_eq!(dir.file_name().unwrap(), "pdf-extract");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_then_list_round_trip() {
        let root = tmp_root();
        let meta = create_skill(
            &root,
            "project",
            "PDF Extract",
            "Pull text out of PDFs",
            "Use pdftotext.",
            &["claude-code".to_string()],
        )
        .unwrap();
        assert_eq!(meta.name, "pdf-extract");
        assert_eq!(meta.enabled_agents, vec!["claude-code".to_string()]);

        let listed = list_skills(&root, "project").unwrap();
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "pdf-extract");
        assert_eq!(s.description, "Pull text out of PDFs");
        // codex is auto-included: its project-scope skills dir IS the canonical
        // store post-convergence (ADR 0003), so any canonical skill is already
        // there — no explicit projection needed.
        assert_eq!(
            s.enabled_agents,
            vec!["claude-code".to_string(), "codex".to_string()]
        );

        // Canonical SKILL.md exists, symlink exists for claude-code.
        assert!(root.join(".agents/skills/pdf-extract/SKILL.md").is_file());
        assert!(root.join(".claude/skills/pdf-extract").symlink_metadata().is_ok());
        // `.agents/skills/pdf-extract` IS the canonical dir above, not a separate
        // codex projection — same path, no symlink involved.

        // Round-trip the body via read_skill.
        let content = read_skill(&root, "pdf-extract").unwrap();
        assert_eq!(content.description, "Pull text out of PDFs");
        assert_eq!(content.body.trim(), "Use pdftotext.");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn symlink_target_resolves_to_canonical() {
        let root = tmp_root();
        create_skill(&root, "project", "demo", "d", "body", &["claude-code".to_string()]).unwrap();
        let link = root.join(".claude/skills/demo");
        // Following the link reaches the canonical SKILL.md.
        let resolved = fs::canonicalize(link.join("SKILL.md")).unwrap();
        let expected = fs::canonicalize(root.join(".agents/skills/demo/SKILL.md")).unwrap();
        assert_eq!(resolved, expected);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn set_enabled_toggles_symlink() {
        let root = tmp_root();
        create_skill(&root, "project", "demo", "d", "b", &[]).unwrap();

        // claude-code has its own dir — a real toggleable symlink projection.
        let claude_link = root.join(".claude/skills/demo");
        assert!(claude_link.symlink_metadata().is_err());
        set_enabled(&root, "project", "demo", "claude-code", true).unwrap();
        assert!(claude_link.symlink_metadata().is_ok());
        set_enabled(&root, "project", "demo", "claude-code", false).unwrap();
        assert!(claude_link.symlink_metadata().is_err());

        // codex's project-scope skills dir IS the canonical store post-
        // convergence (ADR 0003): already "enabled" the moment the skill
        // exists, enabling again is a no-op, and disabling is refused rather
        // than deleting the canonical skill.
        let codex_path = root.join(".agents/skills/demo");
        assert!(codex_path.symlink_metadata().is_ok());
        set_enabled(&root, "project", "demo", "codex", true).unwrap();
        assert!(set_enabled(&root, "project", "demo", "codex", false).is_err());
        assert!(
            codex_path.join("SKILL.md").is_file(),
            "disabling codex must not delete the canonical skill"
        );

        // Toggling for an unknown agent errors.
        assert!(set_enabled(&root, "project", "demo", "nope", true).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_canonical_and_symlinks() {
        let root = tmp_root();
        create_skill(
            &root,
            "project",
            "demo",
            "d",
            "b",
            &["claude-code".to_string(), "codex".to_string()],
        )
        .unwrap();
        // `.agents/skills/demo` is both the canonical dir AND codex's project
        // skills dir post-convergence (ADR 0003) — same path.
        assert!(root.join(".agents/skills/demo").is_dir());
        assert!(root.join(".claude/skills/demo").symlink_metadata().is_ok());

        delete_skill(&root, "project", "demo").unwrap();
        assert!(!root.join(".agents/skills/demo").exists());
        assert!(root.join(".claude/skills/demo").symlink_metadata().is_err());

        // Listing is now empty.
        assert!(list_skills(&root, "project").unwrap().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_targets_reports_detection() {
        let root = tmp_root();
        // Registry is claude-code + codex. tmp_root creates .claude and .codex,
        // so both are detected.
        let targets = list_targets(&root, "global");
        assert_eq!(targets.len(), 3); // claude-code, codex, atlas
        assert!(targets.iter().any(|t| t.id == "claude-code" && t.detected));
        assert!(targets.iter().any(|t| t.id == "codex" && t.detected));
        // The native Atlas agent is in-process → always detected.
        assert!(targets.iter().any(|t| t.id == "atlas" && t.detected));

        // Remove codex's config dir → not detected.
        fs::remove_dir_all(root.join(".codex")).unwrap();
        let targets = list_targets(&root, "global");
        let codex = targets.iter().find(|t| t.id == "codex").unwrap();
        assert!(!codex.detected);
        fs::remove_dir_all(&root).ok();
    }

    // ── Control Plane (CP) ────────────────────────────────────────────────────

    #[test]
    fn hash_is_stable_and_detects_change() {
        let root = tmp_root();
        create_skill(&root, "project", "h", "d", "body one", &[]).unwrap();
        let dir = root.join(".agents/skills/h");
        let a = hash_skill_dir(&dir);
        assert_eq!(a, hash_skill_dir(&dir), "hash must be stable");
        create_skill(&root, "project", "h", "d", "body two", &[]).unwrap();
        assert_ne!(a, hash_skill_dir(&dir), "hash must change with content");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_symlinks_records_ledger_then_unproject_clears() {
        let root = tmp_root();
        create_skill(&root, "project", "p", "d", "b", &[]).unwrap();
        let def = tool_def("claude-code").unwrap();

        project(&root, def, "project", "p", false).unwrap();
        let link = root.join(".claude/skills/p");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(read_ledger(&root).projections["p"]["claude-code"].mode, "symlink");

        unproject(&root, def, "project", "p").unwrap();
        assert!(link.symlink_metadata().is_err());
        assert!(!read_ledger(&root).projections.contains_key("p"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reconcile_reports_synced_external_and_absent() {
        let root = tmp_root();
        // Canonical skill projected into claude-code → synced. codex's
        // project-scope skills dir IS the canonical store post-convergence
        // (ADR 0003), so it reads synced too without an explicit projection;
        // atlas's dedicated dir is untouched → absent.
        create_skill(&root, "project", "owned", "d", "b", &[]).unwrap();
        project(&root, tool_def("claude-code").unwrap(), "project", "owned", false).unwrap();
        // A hand-authored skill living only in claude-code's project dir →
        // external. (Planting one in codex's project dir is no longer a
        // distinct "external" case — that dir IS the canonical store now, so
        // anything placed there is ordinary discovery, not reconciliation.)
        plant_external(&root, ".claude/skills", "wild", "External wild");

        let view = reconcile(&root, "project", &root).unwrap();
        assert_eq!(view.tools.len(), 3); // claude-code, codex, atlas

        let owned = view.skills.iter().find(|s| s.name == "owned").unwrap();
        assert!(owned.managed);
        assert_eq!(
            owned.cells.iter().find(|c| c.tool == "claude-code").unwrap().status,
            "synced"
        );
        assert_eq!(
            owned.cells.iter().find(|c| c.tool == "codex").unwrap().status,
            "synced"
        );
        assert_eq!(
            owned.cells.iter().find(|c| c.tool == "atlas").unwrap().status,
            "absent"
        );

        let wild = view.skills.iter().find(|s| s.name == "wild").unwrap();
        assert!(!wild.managed);
        assert_eq!(
            wild.cells.iter().find(|c| c.tool == "claude-code").unwrap().status,
            "external"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn freeze_converts_symlink_projection_to_real_copy() {
        let root = tmp_root();
        create_skill(&root, "project", "f", "d", "b", &[]).unwrap();
        project(&root, tool_def("claude-code").unwrap(), "project", "f", false).unwrap();
        let link = root.join(".claude/skills/f");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());

        freeze(&root, "project").unwrap();
        let meta = link.symlink_metadata().unwrap();
        assert!(!meta.file_type().is_symlink(), "freeze must replace the symlink");
        assert!(link.join("SKILL.md").is_file(), "frozen copy keeps the skill file");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn promote_copies_project_skill_to_global() {
        let home = tmp_root();
        let proj = tmp_root();
        create_skill(&proj, "project", "pr", "Promote me", "b", &[]).unwrap();

        let meta = promote(&proj, &home, "pr").unwrap();
        assert_eq!(meta.name, "pr");
        assert!(home.join(".agents/skills/pr/SKILL.md").is_file());
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn skill_path_errors_when_missing() {
        let root = tmp_root();
        assert!(skill_path(&root, "ghost").is_err());
        create_skill(&root, "project", "ghost", "d", "b", &[]).unwrap();
        assert!(skill_path(&root, "ghost").unwrap().ends_with("ghost/SKILL.md"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn canonical_base_is_under_dot_agents() {
        let root = tmp_root();
        assert_eq!(skills_base(&root), root.join(".agents/skills"));
        let meta = create_skill(&root, "project", "demo", "d", "b", &[]).unwrap();
        assert!(meta.path.contains("/.agents/skills/demo/"));
        assert!(meta.managed);
        assert!(root.join(".agents/skills/demo/SKILL.md").is_file());
        fs::remove_dir_all(&root).ok();
    }

    /// Plant a real (unmanaged) skill dir directly in an agent's skills dir.
    fn plant_external(root: &Path, agent_skills_dir: &str, name: &str, description: &str) {
        let dir = root.join(agent_skills_dir).join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn external_skill_is_listed_as_unmanaged() {
        let root = tmp_root();
        plant_external(&root, ".claude/skills", "foo", "External foo");

        let listed = list_skills(&root, "global").unwrap();
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "foo");
        assert!(!s.managed);
        assert_eq!(s.description, "External foo");
        assert_eq!(s.enabled_agents, vec!["claude-code".to_string()]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn container_dir_without_skill_md_is_not_listed() {
        let root = tmp_root();
        // `~/.claude/skills/ecc/` nests skills one level deeper → no top-level
        // SKILL.md. Must be skipped (no recursion in v1).
        fs::create_dir_all(root.join(".claude/skills/ecc/nested")).unwrap();
        fs::write(
            root.join(".claude/skills/ecc/nested/SKILL.md"),
            "---\nname: nested\n---\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        assert!(listed.is_empty(), "container dir must not be listed: {listed:?}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn adopt_external_skill_makes_it_managed_for_all_agents() {
        let root = tmp_root(); // both .claude and .codex detected
        plant_external(&root, ".claude/skills", "foo", "External foo");
        // Sanity: pre-adopt it's unmanaged and claude-only.
        let pre = list_skills(&root, "global").unwrap();
        assert_eq!(pre.len(), 1);
        assert!(!pre[0].managed);

        let meta = adopt_skill(&root, "global", "foo").unwrap();
        assert!(meta.managed);
        assert_eq!(meta.description, "External foo");
        // "Make for all agents" now includes the always-present native Atlas agent
        // (enabled_agents is sorted alphabetically).
        assert_eq!(
            meta.enabled_agents,
            vec![
                "atlas".to_string(),
                "claude-code".to_string(),
                "codex".to_string()
            ]
        );

        // Canonical copy now exists.
        assert!(root.join(".agents/skills/foo/SKILL.md").is_file());
        // The original real dir was replaced by a symlink into canonical.
        let claude_link = root.join(".claude/skills/foo");
        assert!(claude_link.symlink_metadata().unwrap().file_type().is_symlink());
        // And the other detected tool (codex, global dir) got a symlink too.
        let codex_link = root.join(".codex/skills/foo");
        assert!(codex_link.symlink_metadata().unwrap().file_type().is_symlink());
        // Both resolve to the canonical SKILL.md.
        let expected = fs::canonicalize(root.join(".agents/skills/foo/SKILL.md")).unwrap();
        assert_eq!(
            fs::canonicalize(claude_link.join("SKILL.md")).unwrap(),
            expected
        );
        assert_eq!(
            fs::canonicalize(codex_link.join("SKILL.md")).unwrap(),
            expected
        );

        // Now listed once, managed=true.
        let post = list_skills(&root, "global").unwrap();
        assert_eq!(post.len(), 1);
        assert!(post[0].managed);
        assert_eq!(
            post[0].enabled_agents,
            vec![
                "claude-code".to_string(),
                "codex".to_string(),
                "atlas".to_string()
            ]
        );
        fs::remove_dir_all(&root).ok();
    }

    // ── Store convergence (ADR 0003) ──────────────────────────────────────────

    /// Plant a real skill dir at `real_rel`, then symlink it into an agent's
    /// skills dir at `link_rel` — mirrors what a skills.sh/Zed projection into
    /// `.claude/skills` looks like from Atlas's point of view.
    fn plant_symlinked_external(root: &Path, real_rel: &str, link_rel: &str, name: &str) {
        let real_dir = root.join(real_rel).join(name);
        fs::create_dir_all(&real_dir).unwrap();
        fs::write(
            real_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: symlinked\n---\n\nbody\n"),
        )
        .unwrap();
        let link_parent = root.join(link_rel);
        fs::create_dir_all(&link_parent).unwrap();
        symlink(&real_dir, &link_parent.join(name)).unwrap();
    }

    #[test]
    fn external_scan_follows_symlinked_skill_dirs() {
        let root = tmp_root();
        // A skill dir that lives outside both the canonical store and any
        // registry tool dir, symlinked into claude-code's skills dir — e.g. a
        // skills.sh/Zed-style projection Atlas didn't create itself.
        plant_symlinked_external(&root, "elsewhere", ".claude/skills", "linked");

        let listed = list_skills(&root, "global").unwrap();
        let s = listed.iter().find(|s| s.name == "linked").expect(
            "symlinked external skill dir must be discovered, not skipped as a managed marker",
        );
        assert!(!s.managed);
        assert_eq!(s.enabled_agents, vec!["claude-code".to_string()]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_legacy_skills_moves_pre_convergence_store_content() {
        let root = tmp_root();
        // Simulate a pre-convergence Atlas install: a skill sitting in the old
        // `.atlas/skills` store, never touched by the new `.agents/skills` one.
        let legacy_dir = legacy_skills_base(&root).join("legacy-demo");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("SKILL.md"),
            "---\nname: legacy-demo\ndescription: from before convergence\n---\n\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        let s = listed
            .iter()
            .find(|s| s.name == "legacy-demo")
            .expect("legacy skill must be migrated and then discovered");
        assert!(s.managed);
        assert_eq!(s.description, "from before convergence");
        assert!(root.join(".agents/skills/legacy-demo/SKILL.md").is_file());
        assert!(
            !legacy_dir.exists(),
            "legacy copy should be moved, not left behind, when the rename succeeds"
        );

        // Idempotent: a second discovery pass is a no-op (nothing left to migrate).
        let listed_again = list_skills(&root, "global").unwrap();
        assert_eq!(listed_again.len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_legacy_skills_does_not_clobber_existing_new_store_entry() {
        let root = tmp_root();
        // New store already has `demo`, with different content than the legacy
        // copy — the legacy copy must be left alone, not overwrite it.
        create_skill(&root, "global", "demo", "new content wins", "b", &[]).unwrap();
        let legacy_dir = legacy_skills_base(&root).join("demo");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: stale legacy content\n---\n\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        let s = listed.iter().find(|s| s.name == "demo").unwrap();
        assert_eq!(s.description, "new content wins");
        assert!(legacy_dir.exists(), "legacy copy is left in place, not deleted");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_project_scope_is_native_location_not_a_projection() {
        let root = tmp_root();
        let def = tool_def("codex").unwrap();
        create_skill(&root, "project", "native", "d", "b", &[]).unwrap();

        // Projecting is a no-op success recorded as "native" in the ledger —
        // there is nothing to symlink, the skill already lives where codex reads.
        project(&root, def, "project", "native", false).unwrap();
        assert_eq!(read_ledger(&root).projections["native"]["codex"].mode, "native");
        assert!(
            root.join(".agents/skills/native")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_dir(),
            "must stay a real dir, never become a self-referential symlink"
        );

        // Unprojecting must refuse rather than delete the canonical skill.
        assert!(unproject(&root, def, "project", "native").is_err());
        assert!(root.join(".agents/skills/native/SKILL.md").is_file());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_skill_projects_to_detected_agents_immediately() {
        let root = tmp_root(); // both .claude and .codex detected
        let src = make_src_pack("v1");
        let meta = install_skill_from_dir(&root, "project", &src, "foo").unwrap();
        fs::remove_dir_all(&src).ok();

        // Installed skill is immediately visible to every detected agent, not
        // left with empty `enabled_agents` until a separate per-agent toggle.
        assert!(meta.enabled_agents.contains(&"claude-code".to_string()));
        assert!(meta.enabled_agents.contains(&"codex".to_string()));
        assert!(root.join(".claude/skills/foo").symlink_metadata().is_ok());
        fs::remove_dir_all(&root).ok();
    }

    // ── Phase 0: pack model + tool homes ─────────────────────────────────────

    #[test]
    fn component_kind_maps_known_dir_names_and_rejects_others() {
        assert_eq!(ComponentKind::from_dir_name("skills"), Some(ComponentKind::Skill));
        assert_eq!(ComponentKind::from_dir_name("agents"), Some(ComponentKind::Agent));
        assert_eq!(ComponentKind::from_dir_name("commands"), Some(ComponentKind::Command));
        assert_eq!(ComponentKind::from_dir_name("hooks"), Some(ComponentKind::Hook));
        assert_eq!(ComponentKind::from_dir_name("rules"), Some(ComponentKind::Rule));
        assert_eq!(ComponentKind::from_dir_name("scripts"), Some(ComponentKind::Script));
        assert_eq!(ComponentKind::from_dir_name("docs"), None);
        assert_eq!(ComponentKind::from_dir_name(""), None);
    }

    #[test]
    fn component_kind_defaults_to_skill() {
        assert_eq!(ComponentKind::default(), ComponentKind::Skill);
        assert!(is_skill_kind(&ComponentKind::default()));
        assert!(!is_skill_kind(&ComponentKind::Agent));
    }

    #[test]
    fn claude_code_homes_resolve_for_supported_kinds() {
        let cc = tool_def("claude-code").unwrap();
        // Agent/command/rule are dir homes at both scopes.
        for scope in ["global", "project"] {
            let agent = tool_home(cc, ComponentKind::Agent, scope).unwrap();
            assert_eq!(agent.rel, ".claude/agents");
            assert_eq!(agent.style, HomeStyle::Dir);
            assert_eq!(tool_home(cc, ComponentKind::Command, scope).unwrap().rel, ".claude/commands");
            assert_eq!(tool_home(cc, ComponentKind::Rule, scope).unwrap().rel, ".claude/rules");
            // Hooks merge into settings.json.
            let hook = tool_home(cc, ComponentKind::Hook, scope).unwrap();
            assert_eq!(hook.rel, ".claude/settings.json");
            assert_eq!(hook.style, HomeStyle::SettingsMerge);
        }
        // Skills are never represented in homes (they use tool_skills_dir).
        assert!(tool_home(cc, ComponentKind::Skill, "global").is_none());
    }

    #[test]
    fn codex_homes_are_a_subset_and_respect_scope() {
        let codex = tool_def("codex").unwrap();
        // Commands are global-only for Codex.
        assert_eq!(
            tool_home(codex, ComponentKind::Command, "global").unwrap().rel,
            ".codex/prompts"
        );
        assert!(tool_home(codex, ComponentKind::Command, "project").is_none());
        // Rules append to AGENTS.md at both scopes.
        let rule = tool_home(codex, ComponentKind::Rule, "project").unwrap();
        assert_eq!(rule.rel, "AGENTS.md");
        assert_eq!(rule.style, HomeStyle::AppendFile);
        // Codex supports neither agents nor hooks.
        assert!(tool_home(codex, ComponentKind::Agent, "global").is_none());
        assert!(tool_home(codex, ComponentKind::Hook, "global").is_none());
    }

    #[test]
    fn skill_ledger_entry_round_trips_without_component_kind_key() {
        // A skill entry omits the kind key entirely → byte-compatible with the
        // pre-Phase-0 ledger format.
        let entry = LedgerEntry {
            mode: "symlink".to_string(),
            hash: "abc123".to_string(),
            component_kind: ComponentKind::Skill,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("component_kind"), "skill entry must not write the kind: {json}");

        // A non-skill entry writes the kind, and both directions round-trip.
        let agent_entry = LedgerEntry {
            mode: "copy".to_string(),
            hash: "deadbeef".to_string(),
            component_kind: ComponentKind::Agent,
        };
        let agent_json = serde_json::to_string(&agent_entry).unwrap();
        assert!(agent_json.contains("\"component_kind\":\"agent\""), "{agent_json}");

        // Legacy JSON with no kind key deserializes back to Skill.
        let legacy: LedgerEntry =
            serde_json::from_str(r#"{"mode":"symlink","hash":"x"}"#).unwrap();
        assert_eq!(legacy.component_kind, ComponentKind::Skill);
    }

    // ── Phase 1: pack parse ──────────────────────────────────────────────────

    /// Build a fresh empty temp dir for a pack fixture.
    fn tmp_pack_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let uniq = format!(
            "atlas-pack-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(uniq);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_file(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn comp_names(pack: &Pack, kind: ComponentKind) -> Vec<String> {
        pack.components
            .iter()
            .filter(|c| c.kind == kind)
            .map(|c| c.name.clone())
            .collect()
    }

    #[test]
    fn pack_parse_infers_all_kinds_from_layout() {
        let dir = tmp_pack_dir();
        // A full Claude Code plugin layout, no manifest.
        write_file(&dir.join("skills/foo/SKILL.md"), "---\nname: foo\n---\nbody");
        write_file(&dir.join("skills/bar/SKILL.md"), "---\nname: bar\n---\nbody");
        write_file(&dir.join("skills/not-a-skill/README.md"), "no skill md here");
        write_file(&dir.join("agents/review.md"), "agent");
        write_file(&dir.join("commands/ship.md"), "command");
        write_file(&dir.join("commands/ns/deep.md"), "nested command");
        write_file(&dir.join("hooks/hooks.json"), "{}");
        write_file(&dir.join("rules/style.md"), "rule");
        write_file(&dir.join("scripts/setup.js"), "console.log(1)");
        write_file(&dir.join("docs/ignored.md"), "not a component dir");
        write_file(&dir.join("scripts/.hidden"), "skip dotfiles");

        let pack = pack_parse(&dir).unwrap();
        // No manifest → name from dir basename (sanitized).
        assert_eq!(pack.name, sanitize_name(dir.file_name().unwrap().to_str().unwrap()).unwrap());
        assert!(pack.manifest.is_none());

        // Skills: only dirs with SKILL.md; the README-only dir is excluded.
        let mut skills = comp_names(&pack, ComponentKind::Skill);
        skills.sort();
        assert_eq!(skills, vec!["bar".to_string(), "foo".to_string()]);

        // Agents / rules use the stem.
        assert_eq!(comp_names(&pack, ComponentKind::Agent), vec!["review".to_string()]);
        assert_eq!(comp_names(&pack, ComponentKind::Rule), vec!["style".to_string()]);

        // Commands recurse into namespaces (stem only).
        let mut cmds = comp_names(&pack, ComponentKind::Command);
        cmds.sort();
        assert_eq!(cmds, vec!["deep".to_string(), "ship".to_string()]);

        // Hooks = JSON files (stem).
        assert_eq!(comp_names(&pack, ComponentKind::Hook), vec!["hooks".to_string()]);

        // Scripts keep their extension; dotfiles are skipped.
        assert_eq!(comp_names(&pack, ComponentKind::Script), vec!["setup.js".to_string()]);

        // `docs/` is not a recognized component dir → contributes nothing.
        assert_eq!(pack.components.iter().filter(|c| c.rel_path.starts_with("docs/")).count(), 0);

        // Output is deterministically sorted by (kind, rel_path).
        let mut sorted = pack.components.clone();
        sorted.sort_by(|a, b| (a.kind.as_str(), &a.rel_path).cmp(&(b.kind.as_str(), &b.rel_path)));
        assert_eq!(pack.components, sorted);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_uses_manifest_name_when_present() {
        let dir = tmp_pack_dir();
        write_file(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"name":"My Cool Pack","version":"1.2.0","description":"hi"}"#,
        );
        write_file(&dir.join("agents/a.md"), "agent");

        let pack = pack_parse(&dir).unwrap();
        assert_eq!(pack.name, "my-cool-pack"); // sanitized manifest name wins
        let m = pack.manifest.as_ref().expect("manifest parsed");
        assert_eq!(m.version.as_deref(), Some("1.2.0"));
        assert_eq!(m.description.as_deref(), Some("hi"));
        assert_eq!(comp_names(&pack, ComponentKind::Agent), vec!["a".to_string()]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_tolerates_missing_and_malformed_manifest() {
        // Malformed plugin.json → treated as absent, name falls back to basename.
        let dir = tmp_pack_dir();
        write_file(&dir.join(".claude-plugin/plugin.json"), "{ not json");
        write_file(&dir.join("skills/x/SKILL.md"), "---\nname: x\n---\n");
        let pack = pack_parse(&dir).unwrap();
        assert!(pack.manifest.is_none());
        assert_eq!(comp_names(&pack, ComponentKind::Skill), vec!["x".to_string()]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_empty_pack_yields_no_components() {
        let dir = tmp_pack_dir();
        let pack = pack_parse(&dir).unwrap();
        assert!(pack.components.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_rejects_non_directory() {
        let dir = tmp_pack_dir();
        let file = dir.join("plain.txt");
        write_file(&file, "hi");
        assert!(pack_parse(&file).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    // ── Phase 2: pack install from registry (offline logic) ──────────────────

    #[test]
    fn parse_owner_repo_accepts_shorthand_url_and_extra() {
        assert_eq!(parse_owner_repo("openai/skills").unwrap(), ("openai".into(), "skills".into()));
        // Extra path segments (the skillId) are ignored — we install the repo.
        assert_eq!(
            parse_owner_repo("openai/skills/pdf").unwrap(),
            ("openai".into(), "skills".into())
        );
        assert_eq!(
            parse_owner_repo("https://github.com/vercel-labs/agent-skills.git").unwrap(),
            ("vercel-labs".into(), "agent-skills".into())
        );
        assert_eq!(
            parse_owner_repo("github.com/foo/bar").unwrap(),
            ("foo".into(), "bar".into())
        );
    }

    #[test]
    fn parse_owner_repo_rejects_bad_and_unsafe_sources() {
        assert!(parse_owner_repo("justone").is_err()); // no repo segment
        assert!(parse_owner_repo("").is_err());
        // Argument-injection guard: a leading-dash segment must be rejected.
        assert!(parse_owner_repo("-evil/repo").is_err());
        assert!(parse_owner_repo("owner/--upload-pack").is_err());
        assert!(parse_owner_repo("ow ner/repo").is_err()); // space
        assert!(!is_safe_gh_segment("-x"));
        assert!(is_safe_gh_segment("vercel-labs"));
        assert!(is_safe_gh_segment("agent.skills_v2"));
    }

    #[test]
    fn pack_store_dir_stays_in_base() {
        let root = tmp_pack_dir();
        let dir = pack_store_dir(&root, "my-pack").unwrap();
        assert!(dir.starts_with(packs_base(&root)));
        assert_eq!(dir.file_name().unwrap(), "my-pack");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_lock_round_trips() {
        let root = tmp_pack_dir();
        let mut lock = read_pack_lock(&root); // empty default
        assert!(lock.packs.is_empty());
        lock.packs.insert(
            "demo".into(),
            PackLockEntry {
                source: "o/r".into(),
                commit: "abc".into(),
                content_hash: "h".into(),
                installed_at: 100,
                updated_at: 200,
            },
        );
        write_pack_lock(&root, &lock).unwrap();
        let back = read_pack_lock(&root);
        assert_eq!(back.version, 1);
        let e = back.packs.get("demo").unwrap();
        assert_eq!(e.source, "o/r");
        assert_eq!(e.installed_at, 100);
        fs::remove_dir_all(&root).ok();
    }

    /// Build a minimal pack fixture (a "fetched repo" tree) under a fresh dir.
    fn make_src_pack(name_marker: &str) -> PathBuf {
        let dir = tmp_pack_dir();
        write_file(
            &dir.join(".claude-plugin/plugin.json"),
            &format!(r#"{{"name":"demo-pack","description":"{name_marker}"}}"#),
        );
        write_file(&dir.join("skills/foo/SKILL.md"), "---\nname: foo\n---\nbody");
        write_file(&dir.join("agents/rev.md"), "agent");
        dir
    }

    #[test]
    fn install_pack_fresh_then_already_installed_then_updated() {
        let root = tmp_pack_dir();
        let src = make_src_pack("v1");

        // Fresh.
        let r1 = install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        assert_eq!(r1.state, PackInstallState::Fresh);
        assert_eq!(r1.pack.name, "demo-pack");
        let store = pack_store_dir(&root, "demo-pack").unwrap();
        assert!(store.join("skills/foo/SKILL.md").is_file());
        assert!(store.join("agents/rev.md").is_file());
        // Lock written; .git never copied (none in src anyway).
        let lock = read_pack_lock(&root);
        assert_eq!(lock.packs.get("demo-pack").unwrap().commit, "c1");

        // Re-install identical content → AlreadyInstalled, installed_at preserved.
        let r2 = install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        assert_eq!(r2.state, PackInstallState::AlreadyInstalled);

        // Mutate the source → Updated, installed_at preserved, updated content lands.
        write_file(&src.join("skills/foo/SKILL.md"), "---\nname: foo\n---\nCHANGED");
        let before = read_pack_lock(&root).packs.get("demo-pack").unwrap().installed_at;
        let r3 = install_pack_from_dir(&root, &src, "o/r", "c2", false).unwrap();
        assert_eq!(r3.state, PackInstallState::Updated);
        let entry = read_pack_lock(&root).packs.get("demo-pack").unwrap().clone();
        assert_eq!(entry.installed_at, before); // preserved
        assert_eq!(entry.commit, "c2");
        let stored = fs::read_to_string(store.join("skills/foo/SKILL.md")).unwrap();
        assert!(stored.contains("CHANGED"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn install_pack_conflicts_with_unmanaged_dir_unless_forced() {
        let root = tmp_pack_dir();
        let src = make_src_pack("v1");
        // Pre-create an unmanaged store dir (no lock entry).
        let store = pack_store_dir(&root, "demo-pack").unwrap();
        write_file(&store.join("preexisting.txt"), "not ours");

        let conflict = install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        assert_eq!(conflict.state, PackInstallState::Conflict);
        // Untouched: our file did not overwrite it.
        assert!(store.join("preexisting.txt").is_file());
        assert!(read_pack_lock(&root).packs.is_empty());

        // With force → installs over it as Fresh.
        let forced = install_pack_from_dir(&root, &src, "o/r", "c1", true).unwrap();
        assert_eq!(forced.state, PackInstallState::Fresh);
        assert!(store.join("skills/foo/SKILL.md").is_file());
        assert!(!store.join("preexisting.txt").exists()); // replaced
        assert!(read_pack_lock(&root).packs.contains_key("demo-pack"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn list_installed_packs_reflects_store_and_lock() {
        let root = tmp_pack_dir();
        let src = make_src_pack("v1");
        install_pack_from_dir(&root, &src, "owner/repo", "c1", false).unwrap();

        let listed = list_installed_packs(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pack.name, "demo-pack");
        assert_eq!(listed[0].source, "owner/repo");
        // foo skill + rev agent both surface as components.
        assert!(listed[0].pack.components.iter().any(|c| c.kind == ComponentKind::Skill));
        assert!(listed[0].pack.components.iter().any(|c| c.kind == ComponentKind::Agent));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    // ── Phase 3: per-component projection ────────────────────────────────────

    /// A richer pack fixture: skill + agent + command + rule + hooks + script.
    fn make_full_src_pack() -> PathBuf {
        let dir = tmp_pack_dir();
        write_file(&dir.join(".claude-plugin/plugin.json"), r#"{"name":"demo-pack"}"#);
        write_file(&dir.join("skills/foo/SKILL.md"), "---\nname: foo\n---\nbody");
        write_file(&dir.join("agents/rev.md"), "agent");
        write_file(&dir.join("commands/ship.md"), "command");
        write_file(&dir.join("rules/style.md"), "rule body");
        write_file(
            &dir.join("hooks/hooks.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.js"}]}]}}"#,
        );
        write_file(&dir.join("scripts/setup.js"), "console.log(1)");
        dir
    }

    /// A root with `.claude`/`.codex` present (tools "detected") + the pack installed.
    fn installed_root(src: &Path) -> PathBuf {
        let root = tmp_pack_dir();
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::create_dir_all(root.join(".codex")).unwrap();
        install_pack_from_dir(&root, src, "owner/repo", "c1", false).unwrap();
        root
    }

    #[test]
    fn pack_parse_honors_manifest_declared_paths() {
        // Plugin keeps its real components in non-conventional locations and
        // declares them in the manifest; an unrelated top-level build `scripts/`
        // must NOT be ingested (the impeccable misdetection).
        let dir = tmp_pack_dir();
        write_file(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"name":"mani","skills":"./.claude/skills","hooks":"./plugin/hooks/hooks.json"}"#,
        );
        write_file(&dir.join(".claude/skills/foo/SKILL.md"), "---\nname: foo\n---\nbody");
        write_file(&dir.join("plugin/hooks/hooks.json"), r#"{"hooks":{}}"#);
        write_file(&dir.join("scripts/build.js"), "console.log(1)"); // build tooling, not a component

        let pack = pack_parse(&dir).unwrap();
        assert!(pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Skill && c.name == "foo"));
        assert!(pack.components.iter().any(|c| c.kind == ComponentKind::Hook));
        assert!(
            !pack.components.iter().any(|c| c.kind == ComponentKind::Script),
            "manifest-declared pack must not ingest top-level build scripts"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_falls_back_to_layout_without_manifest_paths() {
        // Manifest present but declares no component paths → top-level inference.
        let dir = tmp_pack_dir();
        write_file(&dir.join(".claude-plugin/plugin.json"), r#"{"name":"lay"}"#);
        write_file(&dir.join("agents/a.md"), "agent");
        write_file(&dir.join("scripts/setup.js"), "x");

        let pack = pack_parse(&dir).unwrap();
        assert!(pack.components.iter().any(|c| c.kind == ComponentKind::Agent));
        assert!(pack.components.iter().any(|c| c.kind == ComponentKind::Script));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_project_claude_links_agent_and_skill_and_records_ledger() {
        let src = make_full_src_pack();
        let root = installed_root(&src);

        let report = project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();

        // Agent file is a symlink in .claude/agents.
        let agent_link = root.join(".claude/agents/rev.md");
        assert!(agent_link.symlink_metadata().unwrap().file_type().is_symlink());
        // Skill projected into .claude/skills/foo and resolves through the link.
        let skill_link = root.join(".claude/skills/foo");
        assert!(skill_link.symlink_metadata().is_ok());
        assert!(skill_link.join("SKILL.md").is_file());
        // Command + rule also landed (dir-style for claude).
        assert!(root.join(".claude/commands/ship.md").symlink_metadata().is_ok());
        assert!(root.join(".claude/rules/style.md").symlink_metadata().is_ok());
        // Hook merged into settings.json.
        assert!(root.join(".claude/settings.json").is_file());

        // Script is skipped, others projected.
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Script && r.status == "skipped"));
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Agent && r.status == "projected"));

        // Ledger recorded the agent + skill entries.
        let proj = read_pack_proj(&root);
        let entries = proj.projections.get("demo-pack").unwrap().get("claude-code").unwrap();
        assert!(entries
            .iter()
            .any(|e| e.kind == ComponentKind::Agent && e.target_rel == ".claude/agents/rev.md"));
        assert!(entries.iter().any(|e| e.kind == ComponentKind::Skill));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_hook_merge_is_idempotent_and_preserves_keys() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        // Pre-existing settings: unrelated top-level key + an unrelated hook entry.
        write_file(
            &root.join(".claude/settings.json"),
            r#"{"model":"opus","hooks":{"PreToolUse":[{"matcher":"X","hooks":[]}]}}"#,
        );

        let kinds = [ComponentKind::Hook];
        project_pack(&root, "global", "demo-pack", "claude-code", Some(&kinds), false).unwrap();

        let read = |root: &Path| -> serde_json::Value {
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap()
        };
        let v = read(&root);
        assert_eq!(v["model"], "opus"); // unrelated key preserved
        let arr = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(arr.iter().any(|e| e["matcher"] == "X")); // foreign hook preserved
        let tagged = arr
            .iter()
            .filter(|e| e.get("_atlasPack").and_then(|t| t.as_str()) == Some("demo-pack"))
            .count();
        assert_eq!(tagged, 1);

        // Re-project → still exactly one tagged entry (no dupes), X still there.
        project_pack(&root, "global", "demo-pack", "claude-code", Some(&kinds), false).unwrap();
        let v2 = read(&root);
        let arr2 = v2["hooks"]["PreToolUse"].as_array().unwrap();
        let tagged2 = arr2
            .iter()
            .filter(|e| e.get("_atlasPack").and_then(|t| t.as_str()) == Some("demo-pack"))
            .count();
        assert_eq!(tagged2, 1);
        assert!(arr2.iter().any(|e| e["matcher"] == "X"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_hook_rewrites_plugin_root_to_store_dir() {
        let src = make_full_src_pack();
        let root = installed_root(&src);

        project_pack(&root, "global", "demo-pack", "claude-code", Some(&[ComponentKind::Hook]), false)
            .unwrap();

        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap();
        let cmd = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();

        let store = root.join(".atlas/packs/demo-pack");
        let store_str = store.to_string_lossy().to_string();
        // The unresolved `${...}` placeholder is gone, replaced by the store dir.
        assert!(!cmd.contains("${CLAUDE_PLUGIN_ROOT}"), "placeholder not rewritten: {cmd}");
        assert!(cmd.contains(&store_str), "command should point at store dir: {cmd}");
        assert!(cmd.ends_with("/scripts/setup.js"));
        // …and the root is exported so runtime env lookups resolve too.
        assert!(
            cmd.starts_with(&format!("CLAUDE_PLUGIN_ROOT={} ", sh_single_quote(&store_str))),
            "command should export plugin root: {cmd}"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_hook_exports_root_for_runtime_env_bootstrap() {
        // ECC-style hook: no literal `${...}` — it reads process.env at runtime
        // (note the inner `process.env.CLAUDE_PLUGIN_ROOT=r` must NOT be mistaken
        // for a leading shell assignment).
        let src = tmp_pack_dir();
        write_file(&src.join(".claude-plugin/plugin.json"), r#"{"name":"boot-pack"}"#);
        write_file(
            &src.join("hooks/hooks.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node -e \"var r=process.env.CLAUDE_PLUGIN_ROOT;process.env.CLAUDE_PLUGIN_ROOT=r;require(r)\""}]}]}}"#,
        );
        let root = installed_root(&src);

        project_pack(&root, "global", "boot-pack", "claude-code", Some(&[ComponentKind::Hook]), false)
            .unwrap();

        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap();
        let cmd = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        let store_str = root.join(".atlas/packs/boot-pack").to_string_lossy().to_string();
        assert!(
            cmd.starts_with(&format!("CLAUDE_PLUGIN_ROOT={} node -e", sh_single_quote(&store_str))),
            "runtime-env hook should be prefixed with the root: {cmd}"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_codex_appends_rule_block_idempotently() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        let kinds = [ComponentKind::Rule];

        project_pack(&root, "global", "demo-pack", "codex", Some(&kinds), false).unwrap();
        let agents_md = root.join("AGENTS.md");
        let start = "<!-- atlas-pack:demo-pack:style START -->";
        let body = fs::read_to_string(&agents_md).unwrap();
        assert_eq!(body.matches(start).count(), 1);
        assert!(body.contains("rule body"));

        // Re-project → block replaced in place (still exactly one).
        project_pack(&root, "global", "demo-pack", "codex", Some(&kinds), false).unwrap();
        let body2 = fs::read_to_string(&agents_md).unwrap();
        assert_eq!(body2.matches(start).count(), 1);

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_unproject_removes_links_hooks_and_rule_blocks() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        project_pack(&root, "global", "demo-pack", "codex", None, false).unwrap();
        assert!(root.join(".claude/agents/rev.md").symlink_metadata().is_ok());
        assert!(root.join("AGENTS.md").is_file());

        // Unproject claude-code: agent link gone, our hook entry stripped.
        unproject_pack(&root, "demo-pack", "claude-code").unwrap();
        assert!(root.join(".claude/agents/rev.md").symlink_metadata().is_err());
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap();
        if let Some(arr) = v["hooks"]["PreToolUse"].as_array() {
            assert!(!arr
                .iter()
                .any(|e| e.get("_atlasPack").and_then(|t| t.as_str()) == Some("demo-pack")));
        }
        // claude-code subtree gone; codex remains.
        let proj = read_pack_proj(&root);
        let tools = proj.projections.get("demo-pack").unwrap();
        assert!(!tools.contains_key("claude-code"));
        assert!(tools.contains_key("codex"));

        // Unproject codex: AGENTS.md block removed, pack subtree empties out.
        unproject_pack(&root, "demo-pack", "codex").unwrap();
        let body = fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default();
        assert!(!body.contains("atlas-pack:demo-pack:style"));
        assert!(read_pack_proj(&root).projections.get("demo-pack").is_none());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_unproject_round_trip() {
        let src = make_full_src_pack();
        let root = installed_root(&src);

        project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        unproject_pack(&root, "demo-pack", "claude-code").unwrap();
        assert!(root.join(".claude/agents/rev.md").symlink_metadata().is_err());

        // Re-project after unproject works again.
        let report = project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        assert!(root.join(".claude/agents/rev.md").symlink_metadata().is_ok());
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Agent && r.status == "projected"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_skips_foreign_dir_conflict_unless_forced() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        // A foreign file already sits at the agent target.
        write_file(&root.join(".claude/agents/rev.md"), "FOREIGN");

        let kinds = [ComponentKind::Agent];
        let report =
            project_pack(&root, "global", "demo-pack", "claude-code", Some(&kinds), false).unwrap();
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Agent && r.status == "conflict"));
        assert_eq!(fs::read_to_string(root.join(".claude/agents/rev.md")).unwrap(), "FOREIGN");

        // Force overwrites with our symlink.
        project_pack(&root, "global", "demo-pack", "claude-code", Some(&kinds), true).unwrap();
        assert!(root.join(".claude/agents/rev.md").symlink_metadata().unwrap().file_type().is_symlink());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    // ── Skills↔Packs companion (pack-provided skills are first-class) ────────

    /// A detected root with `demo-pack` (ships skill `foo`) installed.
    fn root_with_installed_pack() -> PathBuf {
        let root = tmp_root();
        let src = make_src_pack("v1");
        install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        fs::remove_dir_all(&src).ok();
        root
    }

    #[test]
    fn pack_skill_appears_in_list_skills_badged() {
        let root = root_with_installed_pack();
        let listed = list_skills(&root, "global").unwrap();
        let foo = listed
            .iter()
            .find(|s| s.name == "foo")
            .expect("pack-provided skill is listed");
        assert_eq!(foo.pack.as_deref(), Some("demo-pack"));
        assert!(!foo.managed, "pack skill is not canonical-managed");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_skill_resolves_pack_provided_skill() {
        let root = root_with_installed_pack();
        // `foo` lives only in the pack store, not the canonical store.
        assert!(!root.join(".agents/skills/foo").exists());
        let content = read_skill(&root, "foo").unwrap();
        assert_eq!(content.body.trim(), "body");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reconcile_marks_pack_owned_cell() {
        let root = root_with_installed_pack();
        // Pack projects its skill into claude-code → pack ledger owns the target.
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&[ComponentKind::Skill]),
            false,
        )
        .unwrap();
        let view = reconcile(&root, "global", &root).unwrap();
        let foo = view
            .skills
            .iter()
            .find(|s| s.name == "foo")
            .expect("foo row present in reconcile");
        assert_eq!(foo.pack.as_deref(), Some("demo-pack"));
        let cell = foo.cells.iter().find(|c| c.tool == "claude-code").unwrap();
        assert_eq!(cell.status, "pack");
        assert_eq!(cell.pack.as_deref(), Some("demo-pack"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_refuses_pack_owned_target_without_force() {
        let root = root_with_installed_pack();
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&[ComponentKind::Skill]),
            false,
        )
        .unwrap();
        // Author a canonical skill of the same name (no projection yet).
        create_skill(&root, "global", "foo", "authored", "body", &[]).unwrap();
        let def = tool_def("claude-code").unwrap();
        // Without force: refused because the pack owns claude-code/foo.
        let err = project(&root, def, "global", "foo", false).unwrap_err();
        assert!(err.contains("managed by pack"), "got: {err}");
        // With force: the Skills side may take over.
        assert!(project(&root, def, "global", "foo", true).is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_components_list_returns_command_agent_rule_only() {
        let root = tmp_root();
        let src = make_full_src_pack();
        install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        fs::remove_dir_all(&src).ok();

        let comps = pack_components(&root);
        assert!(comps
            .iter()
            .any(|c| c.kind == ComponentKind::Agent && c.name == "rev"));
        assert!(comps
            .iter()
            .any(|c| c.kind == ComponentKind::Command && c.name == "ship"));
        assert!(comps
            .iter()
            .any(|c| c.kind == ComponentKind::Rule && c.name == "style"));
        // Skills, hooks, and scripts are not chat-invokable components.
        assert!(!comps.iter().any(|c| c.kind == ComponentKind::Skill));
        assert!(!comps.iter().any(|c| c.kind == ComponentKind::Hook));
        assert!(!comps.iter().any(|c| c.kind == ComponentKind::Script));
        // The body path points at the component's `.md` and exists on disk.
        let ship = comps.iter().find(|c| c.name == "ship").unwrap();
        assert!(ship.path.ends_with("commands/ship.md"));
        assert!(Path::new(&ship.path).is_file());

        fs::remove_dir_all(&root).ok();
    }
}
