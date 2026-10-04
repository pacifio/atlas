//! Pure classification/measurement of agent tool calls, for analytics.
//!
//! A Rust port of `src/features/chat/lib/tool-files.ts`, which does the same
//! arithmetic for the chat turn card. Rust owns logic here because the analytics
//! middleware runs on the delta pipeline and must not depend on a renderer that
//! may not even be mounted. The TS copy stays as the view layer's own; the two
//! are covered by parity cases below.
//!
//! **Everything in this module is measurement, never content.** It answers "how
//! many files, of what extension, how many lines" — it never yields a path, an
//! argument, or a line of code to its caller. `path_key` exists precisely so a
//! *distinct* file count can be kept without the path leaving this module.
//!
//! TODO(converge): fold `tool-files.ts` into a thin wrapper over these results
//! once the turn card reads its counts from the Rust snapshot.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::Value;

/// The canonical ACP tool kinds (`src/types/acp.ts`). A superset of what the
/// native classifier emits (the native `tool_kind` classifier → read/edit/execute/
/// fetch/other), so ACP agents that use the full set are reported faithfully.
const KINDS: [&str; 10] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
];

/// Tools that mutate files. Mirrors `EDIT_TOOLS` in `tool-files.ts` and
/// `is_file_mutation` in `memory_delta.rs`.
const EDIT_TOOLS: [&str; 9] = [
    "edit",
    "write",
    "multiedit",
    "create_file",
    "create",
    "str_replace",
    "str_replace_editor",
    "apply_patch",
    "notebookedit",
];

/// Keys that hold a file path in tool arguments. The union of `FILE_PATH_KEYS`
/// (TS) and `memory_delta::extract_path`'s probe list.
const PATH_KEYS: [&str; 6] = [
    "file_path",
    "path",
    "filePath",
    "filename",
    "target_file",
    "file",
];

/// Normalise a tool `kind` to one of [`KINDS`], falling back to the tool name.
///
/// Kind first because all three agents set it; the name is only consulted when
/// an agent sends something unrecognised.
pub fn classify_kind(kind: Option<&str>, tool_name: &str) -> &'static str {
    if let Some(k) = kind {
        let k = k.trim().to_ascii_lowercase();
        // `other` is the agent saying it has no category, so the name still
        // gets its say: the native seam sends every MCP call as `other`
        // (`atlas_code.grep` is a search).
        if k != "other" {
            if let Some(found) = KINDS.iter().find(|c| **c == k) {
                return found;
            }
        }
    }
    let n = tool_name.to_ascii_lowercase();
    if is_edit_tool(&n) {
        "edit"
    } else if n.contains("read") || n.contains("cat") {
        "read"
    } else if n.contains("glob")
        || n.contains("grep")
        || n.contains("search")
        || n.contains("list")
        || n.contains("find_files")
    {
        "search"
    } else if n.contains("bash") || n.contains("shell") || n.contains("exec") {
        "execute"
    } else if n.contains("fetch") || n.contains("web") {
        "fetch"
    } else {
        "other"
    }
}

/// True for tools that write files.
pub fn is_edit_tool(tool_name: &str) -> bool {
    let n = tool_name.trim().to_ascii_lowercase();
    EDIT_TOOLS.contains(&n.as_str())
}

fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

/// First non-empty of several alternative keys.
fn first_str<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| as_str(obj.get(*k)))
}

/// Before/after text pairs for an edit tool call. Mirrors `getEditParts`:
/// an `edits[]` array first, then flat `old_string`/`new_string` (in all three
/// casings agents use), then a whole-file write.
pub fn edit_parts(tool_name: &str, args: &Value) -> Vec<(String, String)> {
    const OLD: [&str; 3] = ["old_string", "oldString", "old_str"];
    const NEW: [&str; 3] = ["new_string", "newString", "new_str"];

    let mut parts = Vec::new();
    if let Some(edits) = args.get("edits").and_then(|e| e.as_array()) {
        for e in edits {
            let old = first_str(e, &OLD).unwrap_or("").to_string();
            let neu = first_str(e, &NEW).unwrap_or("").to_string();
            if !old.is_empty() || !neu.is_empty() {
                parts.push((old, neu));
            }
        }
        if !parts.is_empty() {
            return parts;
        }
    }

    let old = first_str(args, &OLD);
    let neu = first_str(args, &NEW);
    if old.is_some() || neu.is_some() {
        return vec![(old.unwrap_or("").to_string(), neu.unwrap_or("").to_string())];
    }

    // Whole-file write/create — only when the tool really is an editor, so a
    // `content` field on some unrelated tool isn't counted as a file rewrite.
    if is_edit_tool(tool_name) {
        if let Some(content) = first_str(args, &["content", "new_content", "text", "file_text"]) {
            return vec![(String::new(), content.to_string())];
        }
    }
    parts
}

/// Changed-line counts for one before/after pair, with the common prefix and
/// suffix trimmed — the same arithmetic `EditDiffView` renders, so the analytics
/// number and the number on screen agree.
fn count_pair(old: &str, neu: &str) -> (u64, u64) {
    // A whole-file create has no prior content. `"".split('\n')` yields one
    // empty line, which would report the new file as having *removed* a line.
    // `tool-files.ts` has that quirk (it only ever feeds a diff view, where it
    // is invisible); an analytics counter cannot afford it.
    if old.is_empty() && !neu.is_empty() {
        return (neu.split('\n').count() as u64, 0);
    }
    let o: Vec<&str> = old.split('\n').collect();
    let n: Vec<&str> = neu.split('\n').collect();
    let mut start = 0usize;
    while start < o.len() && start < n.len() && o[start] == n[start] {
        start += 1;
    }
    let (mut eo, mut en) = (o.len(), n.len());
    while eo > start && en > start && o[eo - 1] == n[en - 1] {
        eo -= 1;
        en -= 1;
    }
    ((en - start) as u64, (eo - start) as u64)
}

/// Total `(added, removed)` lines for an edit tool call.
pub fn count_edit_lines(tool_name: &str, args: &Value) -> (u64, u64) {
    edit_parts(tool_name, args)
        .iter()
        .fold((0, 0), |(a, r), (old, neu)| {
            let (pa, pr) = count_pair(old, neu);
            (a + pa, r + pr)
        })
}

/// The file this tool call touched, from its arguments or its ACP `locations`.
///
/// Returned to the caller **only** so it can be hashed by [`path_key`] and
/// reduced to an extension. It must never reach an event property.
pub fn extract_path(args: &Value, locations: &[Value]) -> Option<String> {
    if let Some(p) = first_str(args, &PATH_KEYS) {
        return Some(p.to_string());
    }
    locations
        .iter()
        .find_map(|l| as_str(l.get("path")))
        .map(str::to_string)
}

/// Lowercased file extension, or `None` when there isn't a plausible one.
///
/// Deliberately strict: at most 8 characters and alphanumeric only. A dotfile
/// like `.env` has no extension by this definition and yields `None` — which is
/// the point, since `env`, `pem` and `key` as "extensions" would say more about
/// the user's secrets than about their language mix. Never the stem, never the
/// directory.
pub fn path_extension(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() {
        return None; // ".env", ".gitignore" — a dotfile, not an extension
    }
    let ext = ext.to_ascii_lowercase();
    if ext.is_empty() || ext.len() > 8 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext)
}

/// A stable, non-reversible digest of a path, for counting *distinct* files
/// without transmitting any.
///
/// Salted per process: the salt is minted at startup and never persisted, so
/// even the digests cannot be correlated across runs, let alone reversed into a
/// path. Nothing derived from this leaves the machine — only the resulting
/// count does.
pub fn path_key(salt: u64, path: &str) -> u64 {
    let mut h = DefaultHasher::new();
    salt.hash(&mut h);
    path.hash(&mut h);
    h.finish()
}

/// Reduce a tool name to something safe to report.
///
/// MCP tool names are chosen by the user and routinely contain a company or
/// internal-service name (`mcp__acme_internal__deploy`), which is exactly the
/// kind of thing that must not end up in an analytics property. Anything
/// MCP-shaped collapses to `"mcp"`; everything else is lowercased, stripped to
/// `[a-z0-9_-]`, and truncated.
pub fn normalise_tool_name(name: &str) -> String {
    let n = name.trim().to_ascii_lowercase();
    if n.starts_with("mcp__") || n.starts_with("mcp_") || n.starts_with("mcp.") {
        return "mcp".to_string();
    }
    let cleaned: String = n
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(48)
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kind_prefers_the_agent_advertised_value() {
        assert_eq!(classify_kind(Some("execute"), "Bash"), "execute");
        assert_eq!(
            classify_kind(Some("switch_mode"), "whatever"),
            "switch_mode"
        );
        // Unknown kind → fall back to the name.
        assert_eq!(classify_kind(Some("bogus"), "Write"), "edit");
        assert_eq!(classify_kind(None, "Grep"), "search");
        assert_eq!(classify_kind(None, "WebFetch"), "fetch");
        assert_eq!(classify_kind(None, "SomethingElse"), "other");
    }

    /// ADR-0015: the native seam sends every MCP call with kind `other`, so
    /// `other` defers to the name, and the code tools count as searches.
    #[test]
    fn an_mcp_call_filed_under_other_is_classified_by_its_name() {
        assert_eq!(classify_kind(Some("other"), "atlas_code.grep"), "search");
        assert_eq!(
            classify_kind(Some("other"), "atlas_code.find_files"),
            "search"
        );
        assert_eq!(
            classify_kind(Some("other"), "mcp__atlas_code__find_files"),
            "search"
        );
        assert_eq!(classify_kind(Some("other"), "atlas_ui.ui_open"), "other");
    }

    /// Parity with `countEditLines` in `tool-files.ts` — the three argument
    /// shapes agents actually send.
    #[test]
    fn count_edit_lines_matches_the_three_argument_shapes() {
        // 1. `edits[]`
        let args = json!({
            "edits": [
                { "old_string": "a\nb", "new_string": "a\nB\nC" },
                { "oldString": "x", "newString": "y" },
            ]
        });
        assert_eq!(count_edit_lines("multiedit", &args), (3, 2));

        // 2. flat old/new
        let args = json!({ "old_string": "one\ntwo", "new_string": "one\ntwo\nthree" });
        assert_eq!(count_edit_lines("edit", &args), (1, 0));

        // 3. whole-file write — 3 added, and notably 0 removed: a file that did
        // not exist cannot have lost a line.
        let args = json!({ "content": "l1\nl2\nl3" });
        assert_eq!(count_edit_lines("write", &args), (3, 0));
        // ...but only for an actual editor tool.
        assert_eq!(count_edit_lines("bash", &args), (0, 0));
    }

    #[test]
    fn common_prefix_and_suffix_are_not_counted() {
        let args = json!({ "old_string": "keep\nold\nkeep2", "new_string": "keep\nnew\nkeep2" });
        assert_eq!(count_edit_lines("edit", &args), (1, 1));
    }

    #[test]
    fn extension_is_strict_and_never_a_dotfile() {
        assert_eq!(path_extension("/a/b/main.RS").as_deref(), Some("rs"));
        assert_eq!(path_extension("x.tsx").as_deref(), Some("tsx"));
        // Dotfiles have no extension here — `.env` must not report as "env".
        assert_eq!(path_extension("/home/me/.env"), None);
        assert_eq!(path_extension(".gitignore"), None);
        // Implausible: too long, or not alphanumeric.
        assert_eq!(path_extension("archive.tar.gz-backup"), None);
        assert_eq!(path_extension("no-extension"), None);
    }

    #[test]
    fn mcp_tool_names_collapse() {
        assert_eq!(normalise_tool_name("mcp__acme_internal__deploy"), "mcp");
        assert_eq!(normalise_tool_name("mcp_linear_issue"), "mcp");
        assert_eq!(normalise_tool_name("Read"), "read");
        assert_eq!(normalise_tool_name("  Web Search!! "), "websearch");
        assert_eq!(normalise_tool_name("!!!"), "unknown");
    }

    #[test]
    fn path_key_is_stable_within_a_run_and_salt_dependent() {
        assert_eq!(path_key(7, "/a/b.rs"), path_key(7, "/a/b.rs"));
        assert_ne!(path_key(7, "/a/b.rs"), path_key(8, "/a/b.rs"));
        assert_ne!(path_key(7, "/a/b.rs"), path_key(7, "/a/c.rs"));
    }

    #[test]
    fn path_comes_from_args_or_locations() {
        assert_eq!(
            extract_path(&json!({ "file_path": "/x/y.rs" }), &[]).as_deref(),
            Some("/x/y.rs")
        );
        assert_eq!(
            extract_path(&json!({}), &[json!({ "path": "/from/loc.ts" })]).as_deref(),
            Some("/from/loc.ts")
        );
        assert_eq!(extract_path(&json!({ "cmd": "ls" }), &[]), None);
    }
}
