//! Plugin descriptors. Each describes a spawnable agent and how Atlas should
//! treat its persistent transcripts.
//!
//! Wraps `atlas_acp::AgentRegistry::known_specs()` — i.e. whatever the user
//! installed from the ACP registry — and adds Atlas metadata (transcript kind,
//! capability flags) on top. There is no plugin list to add to: an ACP agent
//! enters the catalog by being installed, and the only entry not sourced that
//! way is the native in-process agent appended at the end.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSpec {
    /// Identifier matching `atlas_acp::AgentSpec::spec_id`.
    pub plugin_id: String,
    pub display_name: String,
    /// Shell-words–parseable command. Informational; spawning goes through
    /// atlas-acp which already owns the command.
    pub command: String,
    pub transcript: TranscriptKind,
    /// Whether the agent supports `session/set_mode`.
    pub supports_modes: bool,
    /// Whether the agent supports `session/set_model` style notifications.
    pub supports_models: bool,
    /// True for every ACP agent (all of which are registry-installed), false
    /// only for the native in-process agent.
    #[serde(default)]
    pub external: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TranscriptKind {
    /// No on-disk transcript — sessions are in-memory only and die with the process.
    None,
    /// Canonical Claude Code JSONL at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
    ClaudeJsonl,
    /// Native Cersei agent — JSON transcript under the app config dir, replayed
    /// via `CerseiRuntime::replay_session`.
    CerseiJson,
}

/// Plugin catalog: every registry-installed ACP agent, plus the native cersei
/// agent. Nothing here is hardcoded — an empty install store yields a catalog
/// of exactly one entry, the native agent.
pub fn builtin_plugins(acp: &atlas_acp::AgentRegistry) -> Vec<PluginSpec> {
    let mut plugins: Vec<PluginSpec> = acp
        .known_specs()
        .into_iter()
        .map(|s| PluginSpec {
            plugin_id: s.spec_id.clone(),
            display_name: s.display_name.clone(),
            command: s.command.clone(),
            transcript: classify_transcript(&s.spec_id),
            supports_modes: true,
            supports_models: true,
            external: true,
        })
        .collect();
    // The native in-process agent (no subprocess command).
    plugins.push(PluginSpec {
        plugin_id: atlas_cersei::CERSEI_PLUGIN_ID.to_string(),
        display_name: atlas_cersei::CERSEI_DISPLAY_NAME.to_string(),
        command: "in-process".to_string(),
        transcript: TranscriptKind::CerseiJson,
        supports_modes: true,
        supports_models: true,
        external: false,
    });
    plugins
}

pub fn find_plugin(acp: &atlas_acp::AgentRegistry, plugin_id: &str) -> Option<PluginSpec> {
    builtin_plugins(acp).into_iter().find(|p| p.plugin_id == plugin_id)
}

/// Which on-disk transcript format (if any) an agent writes. This is a
/// capability question, not an identity one: any adapter fronting the Claude
/// Code CLI writes the canonical `~/.claude/projects` JSONL, whatever id the
/// registry gives it.
fn classify_transcript(spec_id: &str) -> TranscriptKind {
    if spec_id.starts_with("claude") {
        TranscriptKind::ClaudeJsonl
    } else {
        TranscriptKind::None
    }
}
