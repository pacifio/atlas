//! Tauri capability files, read as JSON rather than line by line.
//!
//! A shell permission that allows any arguments is the most direct way for
//! webview content to run arbitrary commands. Pretty-printed, its `"args":
//! true` sits several lines below the identifier, beyond any line window, so
//! the capability is parsed at the commit and compared with its parent: only
//! a grant this commit introduces is a finding.

use std::collections::BTreeSet;

use crate::diff::FileStatus;
use crate::finding::{on_line, Class, Finding, Hit, Level, Source};
use crate::map::MappedFile;
use crate::repo::Repo;

pub const RULE_ID: &str = "cfg.capability.shell_any_args";

/// `(identifier, scope name)` for every shell grant with `"args": true`.
fn any_args_grants(json: &serde_json::Value) -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    let Some(permissions) = json.get("permissions").and_then(|p| p.as_array()) else {
        return out;
    };
    for p in permissions {
        let Some(id) = p.get("identifier").and_then(|i| i.as_str()) else {
            continue;
        };
        if !matches!(
            id,
            "shell:allow-execute" | "shell:allow-spawn" | "shell:default"
        ) {
            continue;
        }
        for scope in p
            .get("allow")
            .and_then(|a| a.as_array())
            .into_iter()
            .flatten()
        {
            if scope.get("args").and_then(serde_json::Value::as_bool) == Some(true) {
                let name = scope
                    .get("name")
                    .or_else(|| scope.get("cmd"))
                    .and_then(|n| n.as_str())
                    .unwrap_or_default();
                out.insert((id.to_string(), name.to_string()));
            }
        }
    }
    out
}

fn parse(repo: &dyn Repo, rev: &str, path: &str) -> Option<serde_json::Value> {
    let bytes = repo.file_at(rev, path).ok()??;
    serde_json::from_slice(&bytes).ok()
}

/// Shell grants with any arguments that this commit adds. `None` when the
/// file at the commit is not readable JSON: the line rule then stands alone.
pub fn scan_capability(sha: &str, file: &MappedFile, repo: &dyn Repo) -> Option<Vec<Finding>> {
    let path = file.change.path.as_str();
    let after = any_args_grants(&parse(repo, sha, path)?);
    let before_path = match &file.change.status {
        FileStatus::Renamed { from } => from.as_str(),
        _ => path,
    };
    let before = match (&file.change.status, repo.parent(sha).ok().flatten()) {
        (FileStatus::Added, _) | (_, None) => BTreeSet::new(),
        (_, Some(parent)) => parse(repo, &parent, before_path)
            .map(|v| any_args_grants(&v))
            .unwrap_or_default(),
    };
    let mut out = Vec::new();
    for (id, _name) in after.difference(&before) {
        let needle = format!("\"{id}\"");
        let at = file
            .change
            .added_lines()
            .find(|(_, t)| t.contains(&needle))
            .or_else(|| file.change.added_lines().next());
        let Some((line_no, text)) = at else { continue };
        out.push(on_line(
            Hit {
                class: Class::Permissions,
                level: Level::Critical,
                blocking: true,
                source: Source::Rule,
                rule_id: RULE_ID,
            },
            sha,
            path,
            (line_no, text),
        ));
    }
    Some(out)
}
