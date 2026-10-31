//! What the Session behind a Checkpoint did: the facts no PR scanner has.
//!
//! Which sensitive files the agent read, which URLs it fetched, which commands
//! it ran, and which files it wrote. Everything comes from the checkpoint
//! store, where values are already redacted, so nothing here ever needs or
//! sees a raw secret. Attribution is per file in this version.

use std::collections::HashSet;
use std::sync::LazyLock;

use atlas_checkpoint::tools::{extract_paths, ToolName};
use atlas_checkpoint::Store;
use regex::Regex;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Provenance {
    /// Sensitive paths the agent read, in first-seen order.
    pub sensitive_reads: Vec<String>,
    pub fetched_urls: Vec<String>,
    /// Shell commands the agent ran, each cut to [`COMMAND_CHARS`].
    pub commands: Vec<String>,
    /// Project-relative paths the agent wrote content to.
    pub agent_written: HashSet<String>,
}

pub const COMMAND_CHARS: usize = 200;

/// A file whose contents are credentials or keys.
pub fn is_sensitive_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let in_dir = |dir: &str| path.split('/').any(|s| s == dir);
    if name == ".env" {
        return true;
    }
    if let Some(suffix) = name.strip_prefix(".env.") {
        return !matches!(suffix, "example" | "sample" | "template" | "dist");
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e);
    matches!(ext, Some("pem" | "key" | "p12" | "pfx"))
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || in_dir(".ssh")
        || (in_dir(".aws") && name == "credentials")
        || matches!(name, ".npmrc" | ".pypirc" | "credentials.json" | ".netrc")
}

/// Shell commands that print or load a file.
static READ_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[;&|(]\s*|\s)(?:cat|less|more|head|tail|bat|source|strings)\b([^;&|)]*)")
        .expect("read-command pattern compiles")
});

pub fn from_store(store: &Store, session_id: &str) -> atlas_checkpoint::Result<Provenance> {
    let mut p = Provenance::default();
    let push_read = |path: String, p: &mut Provenance| {
        if is_sensitive_path(&path) && !p.sensitive_reads.contains(&path) {
            p.sensitive_reads.push(path);
        }
    };

    for call in store.tool_calls_for_session(session_id)? {
        let args: serde_json::Value = call
            .arguments
            .as_deref()
            .and_then(|a| serde_json::from_str(a).ok())
            .unwrap_or(serde_json::Value::Null);
        match call.tool_name {
            ToolName::Read => {
                let locations = call.locations.as_array().cloned().unwrap_or_default();
                for path in extract_paths(&locations, &[], &args) {
                    push_read(path, &mut p);
                }
            }
            ToolName::Bash => {
                let command = args
                    .get("command")
                    .and_then(|c| c.as_str())
                    .map(str::to_string)
                    .or_else(|| call.arguments.clone())
                    .unwrap_or_default();
                for caps in READ_COMMAND.captures_iter(&command) {
                    for token in caps[1].split_whitespace().filter(|t| !t.starts_with('-')) {
                        push_read(token.trim_matches(['"', '\'']).to_string(), &mut p);
                    }
                }
                if !command.is_empty() {
                    p.commands
                        .push(command.chars().take(COMMAND_CHARS).collect());
                }
            }
            ToolName::Fetch => {
                if let Some(url) = args.get("url").and_then(|u| u.as_str()) {
                    p.fetched_urls.push(url.to_string());
                }
            }
            _ => {}
        }
    }

    for touch in store.latest_file_touches(session_id)? {
        if touch.sha256_after.is_some() {
            p.agent_written.insert(touch.path);
        }
    }
    Ok(p)
}
