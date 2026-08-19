//! Argument coercion — the cheapest, highest-value weak-model rescue, applied
//! before anything looks at the arguments.
//!
//! Fixes the classes that make weak BYOK models fail tool calls: stringified
//! JSON tool args, aliased field names, and code-fenced strings.
//!
//! Per tool spec D7 there is now **one table and one function**, driven by each
//! tool's declared schema — rather than a private alias list inside each of the
//! handful of tools that happened to implement it. The guard calls it for every
//! tool, so SDK-provided and MCP-discovered tools get the same treatment;
//! previously they got none.
//!
//! Atlas-owned tools also call it themselves. That is not the old duplication
//! returning: it is one idempotent function, and it keeps a tool called
//! directly — by a test, a benchmark, or the offline eval — behaving the way it
//! does in a session.
//!
//! The schema is what makes one shared alias table safe. An alias `X → Y` fires
//! only when the target tool declares `Y` and does not declare `X`, so mapping
//! `search → old_string` cannot corrupt a tool that has a legitimate `search`
//! field of its own.

use serde_json::{Map, Value};

/// The shared alias table: field names weak models commonly emit instead of the
/// canonical ones. Applied against a tool's declared schema, never blindly.
pub const ALIASES: &[(&str, &str)] = &[
    // Path
    ("filePath", "file_path"),
    ("filepath", "file_path"),
    ("path", "file_path"),
    ("filename", "file_path"),
    ("fileName", "file_path"),
    ("file", "file_path"),
    ("target_file", "file_path"),
    ("notebookPath", "notebook_path"),
    // Directory-shaped tools name the same idea `path`. The schema guard makes
    // the two directions safe together: `path → file_path` fires only for a
    // tool that declares `file_path` and not `path`, and `file_path → path`
    // only for one that declares `path` and not `file_path`. A tool declaring
    // both keeps both. Without the second direction, `List {"file_path": …}`
    // silently walked the project root and reported that as the answer.
    ("dir", "path"),
    ("directory", "path"),
    ("folder", "path"),
    ("file_path", "path"),
    ("filePath", "path"),
    // Edit
    ("oldString", "old_string"),
    ("old_str", "old_string"),
    ("oldText", "old_string"),
    ("search", "old_string"),
    ("newString", "new_string"),
    ("new_str", "new_string"),
    ("newText", "new_string"),
    ("replace", "new_string"),
    ("replacement", "new_string"),
    ("replaceAll", "replace_all"),
    // Write
    ("contents", "content"),
    ("text", "content"),
    ("body", "content"),
    // Skill
    ("name", "skill"),
    ("arguments", "args"),
    // Shell
    ("cmd", "command"),
    ("script", "command"),
    ("shell_command", "command"),
    ("timeout_ms", "timeout"),
];

/// Field names whose value is free text a model may wrap in a code fence.
///
/// `old_string`/`new_string` are deliberately absent: stripping them at
/// dispatch corrupted legitimate edits to markdown whose payload *is* a fenced
/// block — a spurious not-found in the symmetric case, silently de-fenced
/// written content in the asymmetric one. The edit tool owns that rescue now
/// (`edit.rs`), raw-first: the verbatim text is tried before any de-fenced
/// variant, so verbatim means verbatim.
const FENCEABLE: &[&str] = &["content", "patch", "input"];

/// If the tool args arrived as a JSON *string* (some providers double-encode),
/// parse it back into an object. Otherwise return `input` unchanged.
pub fn unwrap_stringified(input: Value) -> Value {
    if let Value::String(s) = &input {
        let trimmed = s.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(parsed @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) {
                return parsed;
            }
        }
    }
    input
}

/// Strip a *fully enclosing* ``` code fence (optionally ```lang) the model
/// wrapped around a value. Conservative: only when the entire string is fenced,
/// so code that merely contains backticks is left intact.
pub fn strip_code_fences(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() < 6 || !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return s.to_string();
    }
    // Drop the opening fence line (``` or ```lang\n ...).
    let after_open = &trimmed[3..];
    let body_start = match after_open.find('\n') {
        Some(nl) => nl + 1,
        None => return s.to_string(),
    };
    let inner = &after_open[body_start..];
    // Drop the trailing ``` (and an optional preceding newline).
    let inner = inner.strip_suffix("```").unwrap_or(inner);
    let inner = inner.strip_suffix('\n').unwrap_or(inner);
    inner.to_string()
}

/// The dispatch-time pass: unwrap double encoding, rename aliases the tool's
/// schema can actually accept, and de-fence free-text fields.
///
/// `schema` is the tool's declared `input_schema`. When it declares no
/// properties (an MCP tool with an opaque schema, say) only the unwrapping step
/// applies, because there is nothing to validate an alias against.
pub fn for_schema(input: Value, schema: &Value) -> Value {
    let mut input = unwrap_stringified(input);
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return input;
    };
    if let Some(obj) = input.as_object_mut() {
        for (alias, canonical) in ALIASES {
            // The alias only fires when the tool actually has the canonical
            // field and does *not* have a field of the alias's own name.
            if !props.contains_key(*canonical) || props.contains_key(*alias) {
                continue;
            }
            if obj.contains_key(*canonical) {
                continue;
            }
            if let Some(v) = obj.remove(*alias) {
                obj.insert((*canonical).to_string(), v);
            }
        }
        for field in FENCEABLE {
            if props.contains_key(*field) {
                defence_field(obj, field);
            }
        }
    }
    input
}

fn defence_field(obj: &mut Map<String, Value>, key: &str) {
    if let Some(Value::String(s)) = obj.get(key) {
        let stripped = strip_code_fences(s);
        if stripped != *s {
            obj.insert(key.to_string(), Value::String(stripped));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema(fields: &[&str]) -> Value {
        let props: serde_json::Map<String, Value> =
            fields.iter().map(|f| ((*f).to_string(), json!({}))).collect();
        json!({ "type": "object", "properties": props })
    }

    #[test]
    fn unwraps_double_encoded_args() {
        let raw = Value::String(r#"{"file_path":"a.rs","old_string":"x"}"#.to_string());
        let got = unwrap_stringified(raw);
        assert_eq!(got["file_path"], "a.rs");
    }

    #[test]
    fn leaves_plain_object() {
        let v = json!({"a": 1});
        assert_eq!(unwrap_stringified(v.clone()), v);
    }

    #[test]
    fn strips_lang_fence() {
        let s = "```rust\nfn a() {}\n```";
        assert_eq!(strip_code_fences(s), "fn a() {}");
    }

    #[test]
    fn strips_bare_fence() {
        let s = "```\nplain\n```";
        assert_eq!(strip_code_fences(s), "plain");
    }

    #[test]
    fn leaves_unfenced() {
        let s = "let x = `tpl`;";
        assert_eq!(strip_code_fences(s), s);
    }

    // ── Schema-driven pass (D7) ─────────────────────────────────────────────

    #[test]
    fn canonical_wins_over_alias() {
        let s = schema(&["file_path"]);
        let got = for_schema(json!({"file_path": "real.rs", "path": "junk.rs"}), &s);
        assert_eq!(got["file_path"], "real.rs");
    }

    #[test]
    fn an_edit_call_is_coerced_end_to_end() {
        let s = schema(&["file_path", "old_string", "new_string"]);
        let raw = Value::String(
            r#"{"filePath":"a.rs","oldString":"```\nold\n```","newString":"new"}"#.to_string(),
        );
        let got = for_schema(raw, &s);
        assert_eq!(got["file_path"], "a.rs");
        // Fences on old_string/new_string survive dispatch untouched: the edit
        // tool owns the rescue, raw-first, so an edit to a markdown file whose
        // payload IS a fenced block matches verbatim.
        assert_eq!(got["old_string"], "```\nold\n```");
        assert_eq!(got["new_string"], "new");
    }

    #[test]
    fn the_two_path_alias_directions_do_not_cancel_out() {
        // `path → file_path` and `file_path → path` both exist. Applied blindly
        // they would chain and leave neither field set; the schema guard means
        // only the direction the tool can accept ever fires.
        let file_shaped = for_schema(json!({"path": "a.rs"}), &schema(&["file_path"]));
        assert_eq!(file_shaped["file_path"], "a.rs");
        let dir_shaped = for_schema(json!({"file_path": "src"}), &schema(&["path"]));
        assert_eq!(dir_shaped["path"], "src");
    }

    #[test]
    fn schema_pass_renames_only_into_declared_fields() {
        let s = schema(&["file_path", "old_string", "new_string"]);
        let got = for_schema(json!({"filePath": "a.rs", "oldText": "x", "newText": "y"}), &s);
        assert_eq!(got["file_path"], "a.rs");
        assert_eq!(got["old_string"], "x");
        assert_eq!(got["new_string"], "y");
    }

    #[test]
    fn an_alias_that_is_the_tools_own_field_never_fires() {
        // A tool that legitimately takes `search` AND `old_string` must keep
        // both. This is what makes one shared alias table safe.
        let s = schema(&["search", "old_string"]);
        let got = for_schema(json!({"search": "query", "old_string": "text"}), &s);
        assert_eq!(got["search"], "query");
        assert_eq!(got["old_string"], "text");
    }

    #[test]
    fn a_tool_that_declares_path_keeps_path() {
        // `List`/`Glob` take `path` as their own field, so `path → file_path`
        // must not fire for them.
        let s = schema(&["path"]);
        let got = for_schema(json!({"dir": "src"}), &s);
        assert_eq!(got["path"], "src");
        assert!(got.get("file_path").is_none());
    }

    #[test]
    fn opaque_schema_still_gets_the_unwrap() {
        // An MCP tool with no declared properties: no aliasing, but a
        // double-encoded argument object is still recovered.
        let got = for_schema(
            Value::String(r#"{"anything":1}"#.to_string()),
            &json!({"type": "object"}),
        );
        assert_eq!(got["anything"], 1);
    }

    #[test]
    fn defences_only_declared_free_text_fields() {
        let s = schema(&["content"]);
        let got = for_schema(json!({"content": "```js\nx\n```"}), &s);
        assert_eq!(got["content"], "x");
    }

    #[test]
    fn shell_aliases_reach_the_command_field() {
        let s = schema(&["command", "timeout"]);
        let got = for_schema(json!({"cmd": "ls", "timeout_ms": 500}), &s);
        assert_eq!(got["command"], "ls");
        assert_eq!(got["timeout"], 500);
    }
}
