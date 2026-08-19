//! MCP servers for ACP agents (P1.1, `plans/atlas-acp-parity-loop.md`).
//!
//! Atlas has always let users configure MCP servers in
//! `<app_config_dir>/mcp-servers.json`, but only the native (Cersei) agent ever
//! saw them: `session/new` went out as a bare `NewSessionRequest::new(cwd)`, so
//! every ACP agent — Claude Code, Codex, Cursor, Gemini — started with no MCP
//! tools at all. A user who configured a server and then switched agents would
//! find it silently missing, with nothing in the UI to explain why. This module
//! maps the same on-disk config onto the ACP `mcpServers` field so it reaches
//! every agent.
//!
//! ## Why the config type is duplicated here
//!
//! The native agent deserializes this file into `cersei::mcp::McpServerConfig`.
//! `atlas-acp` cannot reuse that type: `atlas-cersei` depends on `atlas-acp`, so
//! importing it back would be a dependency cycle. The shared contract is the
//! *file format*, not the Rust type, so [`McpServerConfig`] below mirrors the
//! same JSON shape. Any field added to one must be added to the other — see the
//! round-trip test that pins the exact on-disk keys.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerSse, McpServerStdio,
};
use serde::{Deserialize, Serialize};

use crate::capabilities::AgentCaps;

/// The file every Atlas MCP consumer reads, relative to the app config dir.
pub const CONFIG_FILE: &str = "mcp-servers.json";

/// One entry of `mcp-servers.json`.
///
/// Mirrors `cersei::mcp::McpServerConfig` field-for-field (see module docs for
/// why it is not that type). `type` defaults to `"stdio"`, matching the native
/// agent's reader, so hand-written configs that omit it keep working.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(rename = "type", default = "default_type")]
    pub server_type: String,
}

fn default_type() -> String {
    "stdio".to_string()
}

/// Read the configured MCP servers. A missing or unparseable file yields none —
/// the same best-effort contract the native agent's loader uses, because a
/// malformed config must not stop a session from opening.
#[must_use]
pub fn load_configs(config_dir: &Path) -> Vec<McpServerConfig> {
    let Ok(raw) = std::fs::read_to_string(config_dir.join(CONFIG_FILE)) else {
        return Vec::new();
    };
    match serde_json::from_str(&raw) {
        Ok(configs) => configs,
        Err(e) => {
            tracing::warn!(
                target: "atlas_acp::mcp",
                error = %e,
                "{CONFIG_FILE} is not valid JSON — no MCP servers will be passed to ACP agents"
            );
            Vec::new()
        }
    }
}

/// Why a configured server was not passed to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Skip {
    /// The agent did not advertise this transport in `mcpCapabilities`.
    Unsupported(&'static str),
    /// The config is incomplete for its declared type.
    Incomplete(&'static str),
}

/// Map the on-disk configs onto ACP `McpServer` values, dropping any the agent
/// cannot accept.
///
/// Transport gating follows `AgentCapabilities.mcpCapabilities`: `http` and
/// `sse` each have an explicit flag, while **stdio has none** — the schema
/// offers no `stdio` bit, which is what makes it the baseline every agent is
/// required to accept. Sending an `http` server to an agent that never
/// advertised `mcpCapabilities.http` would be an over-advertisement in the other
/// direction, so those are dropped with a warning rather than sent hopefully.
#[must_use]
pub fn to_acp_servers(configs: Vec<McpServerConfig>, caps: AgentCaps) -> Vec<McpServer> {
    let mut out = Vec::with_capacity(configs.len());
    for config in configs {
        match map_one(&config, caps) {
            Ok(server) => out.push(server),
            Err(reason) => {
                let detail = match reason {
                    Skip::Unsupported(t) => {
                        format!("agent did not advertise mcpCapabilities.{t}")
                    }
                    Skip::Incomplete(what) => format!("config is missing `{what}`"),
                };
                tracing::warn!(
                    target: "atlas_acp::mcp",
                    server = %config.name,
                    transport = %config.server_type,
                    "skipping MCP server — {detail}"
                );
            }
        }
    }
    out
}

fn map_one(config: &McpServerConfig, caps: AgentCaps) -> Result<McpServer, Skip> {
    // Case-insensitive: the file is hand-edited as often as it is written by the
    // settings UI, and "HTTP" should not silently fall through to stdio.
    match config.server_type.to_ascii_lowercase().as_str() {
        "http" => {
            if !caps.mcp_http {
                return Err(Skip::Unsupported("http"));
            }
            let url = config.url.as_deref().ok_or(Skip::Incomplete("url"))?;
            Ok(McpServer::Http(
                McpServerHttp::new(config.name.clone(), url).headers(headers(&config.env)),
            ))
        }
        "sse" => {
            if !caps.mcp_sse {
                return Err(Skip::Unsupported("sse"));
            }
            let url = config.url.as_deref().ok_or(Skip::Incomplete("url"))?;
            Ok(McpServer::Sse(
                McpServerSse::new(config.name.clone(), url).headers(headers(&config.env)),
            ))
        }
        // Anything else is treated as stdio, matching `default_type` and the
        // native agent's reader — an unknown `type` string is far more likely a
        // typo in a stdio entry than a transport we should refuse outright.
        _ => {
            let command = config
                .command
                .as_deref()
                .ok_or(Skip::Incomplete("command"))?;
            Ok(McpServer::Stdio(
                McpServerStdio::new(config.name.clone(), PathBuf::from(command))
                    .args(config.args.clone())
                    .env(env_vars(&config.env)),
            ))
        }
    }
}

/// `env` doubles as the header map for the HTTP/SSE transports — the on-disk
/// schema has one key-value bag and the native agent uses it the same way.
/// Sorted so the request is deterministic (`HashMap` iteration is not).
fn headers(env: &HashMap<String, String>) -> Vec<HttpHeader> {
    let mut pairs: Vec<_> = env.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
        .into_iter()
        .map(|(name, value)| HttpHeader::new(name.clone(), value.clone()))
        .collect()
}

fn env_vars(env: &HashMap<String, String>) -> Vec<EnvVariable> {
    let mut pairs: Vec<_> = env.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
        .into_iter()
        .map(|(name, value)| EnvVariable::new(name.clone(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(http: bool, sse: bool) -> AgentCaps {
        AgentCaps {
            mcp_http: http,
            mcp_sse: sse,
            ..AgentCaps::default()
        }
    }

    fn stdio_config() -> McpServerConfig {
        McpServerConfig {
            name: "files".into(),
            command: Some("/usr/bin/mcp-files".into()),
            args: vec!["--root".into(), "/tmp".into()],
            env: HashMap::from([("TOKEN".to_string(), "abc".to_string())]),
            url: None,
            server_type: "stdio".into(),
        }
    }

    /// The on-disk keys are a contract shared with the native agent's reader and
    /// with the settings UI. If this drifts, configs silently stop loading for
    /// one of the two consumers.
    #[test]
    fn the_on_disk_shape_matches_the_documented_keys() {
        let parsed: Vec<McpServerConfig> = serde_json::from_str(
            r#"[{"name":"files","command":"/bin/x","args":["-a"],
                 "env":{"K":"V"},"type":"stdio"}]"#,
        )
        .expect("documented shape must parse");
        assert_eq!(parsed[0].name, "files");
        assert_eq!(parsed[0].args, vec!["-a"]);
        assert_eq!(parsed[0].env.get("K").map(String::as_str), Some("V"));
    }

    /// `type` is optional in hand-written configs; the native agent defaults it
    /// to stdio and so must we.
    #[test]
    fn a_config_without_a_type_defaults_to_stdio() {
        let parsed: Vec<McpServerConfig> =
            serde_json::from_str(r#"[{"name":"x","command":"/bin/x"}]"#).unwrap();
        assert_eq!(parsed[0].server_type, "stdio");
        let mapped = to_acp_servers(parsed, caps(false, false));
        assert!(matches!(mapped[0], McpServer::Stdio(_)));
    }

    /// The schema has no `stdio` capability bit, which makes stdio the baseline
    /// every agent must accept — it must survive even all-false capabilities.
    #[test]
    fn stdio_is_passed_to_an_agent_that_advertises_no_mcp_capabilities() {
        let mapped = to_acp_servers(vec![stdio_config()], caps(false, false));
        assert_eq!(mapped.len(), 1);
        let McpServer::Stdio(s) = &mapped[0] else {
            panic!("expected stdio, got {:?}", mapped[0]);
        };
        assert_eq!(s.name, "files");
        assert_eq!(s.command, PathBuf::from("/usr/bin/mcp-files"));
        assert_eq!(s.args, vec!["--root", "/tmp"]);
        assert_eq!(s.env.len(), 1);
        assert_eq!(s.env[0].name, "TOKEN");
    }

    #[test]
    fn http_is_dropped_unless_the_agent_advertised_it() {
        let config = McpServerConfig {
            name: "remote".into(),
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some("https://example.test/mcp".into()),
            server_type: "http".into(),
        };
        assert!(
            to_acp_servers(vec![config.clone()], caps(false, false)).is_empty(),
            "sending http to an agent that never advertised it is an over-advertisement"
        );
        let mapped = to_acp_servers(vec![config], caps(true, false));
        assert!(matches!(mapped[0], McpServer::Http(_)));
    }

    #[test]
    fn sse_is_gated_independently_of_http() {
        let config = McpServerConfig {
            name: "stream".into(),
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some("https://example.test/sse".into()),
            server_type: "sse".into(),
        };
        assert!(to_acp_servers(vec![config.clone()], caps(true, false)).is_empty());
        let mapped = to_acp_servers(vec![config], caps(false, true));
        assert!(matches!(mapped[0], McpServer::Sse(_)));
    }

    #[test]
    fn transport_matching_is_case_insensitive() {
        let config = McpServerConfig {
            server_type: "HTTP".into(),
            ..McpServerConfig {
                name: "remote".into(),
                command: None,
                args: vec![],
                env: HashMap::new(),
                url: Some("https://example.test/mcp".into()),
                server_type: String::new(),
            }
        };
        let mapped = to_acp_servers(vec![config], caps(true, false));
        assert!(
            matches!(mapped.first(), Some(McpServer::Http(_))),
            "\"HTTP\" must not fall through to the stdio branch"
        );
    }

    /// A half-written entry must not abort the whole session — the other servers
    /// still go out.
    #[test]
    fn an_incomplete_entry_is_skipped_without_dropping_its_neighbours() {
        let broken = McpServerConfig {
            name: "broken".into(),
            command: None, // stdio with no command
            args: vec![],
            env: HashMap::new(),
            url: None,
            server_type: "stdio".into(),
        };
        let mapped = to_acp_servers(vec![broken, stdio_config()], caps(false, false));
        assert_eq!(mapped.len(), 1);
        let McpServer::Stdio(s) = &mapped[0] else {
            panic!("expected the good entry to survive");
        };
        assert_eq!(s.name, "files");
    }

    #[test]
    fn a_missing_config_file_yields_no_servers() {
        let dir = std::env::temp_dir().join("atlas-acp-mcp-absent-fixture");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_configs(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A malformed file is a user typo, not a crash: sessions must still open,
    /// just without MCP.
    #[test]
    fn a_malformed_config_file_yields_no_servers() {
        let dir = std::env::temp_dir().join("atlas-acp-mcp-malformed-fixture");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CONFIG_FILE), "{ not json").unwrap();
        assert!(load_configs(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn configs_round_trip_through_the_real_file() {
        let dir = std::env::temp_dir().join("atlas-acp-mcp-roundtrip-fixture");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let want = vec![stdio_config()];
        std::fs::write(
            dir.join(CONFIG_FILE),
            serde_json::to_string(&want).unwrap(),
        )
        .unwrap();
        assert_eq!(load_configs(&dir), want);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
