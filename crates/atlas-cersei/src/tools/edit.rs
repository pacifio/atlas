//! `Edit` — targeted string replacement with the opencode fallback ladder.
//!
//! Pipeline (see `plans/atlas-cersei-edit-solution.md`):
//!   coerce args (strip fences, dealias keys, unwrap stringified JSON)
//!   →   resolve file_path against ctx.working_dir
//!   →   line-ending + BOM sandwich (normalize to \n for matching, restore on write)
//!   →   per-file lock, keyed on the *canonical* path
//!   →   [`replace`](super::replace::replace) driver (exact+LineTrimmed auto-apply,
//!       guarded fuzzy tail, disproportionate-match guard)
//!   →   on success: atomic write + short diff preview + structured diff
//!   →   on safe failure: corrective error with real nearby lines (+ Write steer
//!       for small files).
//!
//! Three durability fixes live here (tool spec D2, D4, D12):
//!
//! * The per-file lock is keyed on the canonical path. It used to be keyed on
//!   the raw resolved path, so `a.rs`, `./a.rs` and `/abs/a.rs` took three
//!   different mutexes and the serialisation guarantee did not hold.
//! * Writes go through a temporary file and a rename, so a crash mid-write can
//!   no longer truncate a source file.
//! * The real before/after is emitted as structured metadata, not just
//!   formatted into a display string and dropped.
//!
//! The read-before-edit and staleness preconditions are *not* here: they belong
//! to the guard, which enforces them before this tool is ever entered.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::{abs_path, atomic, coerce, errors, replace};

const DESCRIPTION: &str = "Performs exact string replacements in files. Prefer this over \
shell tools (sed/awk/perl) for editing — it is grounded in the real file and tolerates minor \
indentation/whitespace drift.\n\n\
Usage:\n\
- Read the file first; copy the text to replace EXACTLY as it appears AFTER the `N: ` line-number \
prefix in Read output. Never include any part of the `N: ` prefix in old_string or new_string.\n\
- old_string must be unique in the file, or the edit is rejected as ambiguous — add surrounding \
context, or set replace_all=true to change every occurrence (useful for renames).\n\
- new_string must differ from old_string. To replace a whole file, use Write instead.\n\
- If old_string is empty and the file does not exist, the file is created with new_string.";

/// Per-file edit lock so concurrent edits to the same file serialize.
static LOCKS: LazyLock<DashMap<PathBuf, Arc<Mutex<()>>>> = LazyLock::new(DashMap::new);

/// Above this many tracked files, unheld locks are dropped. Without eviction
/// the map grew for the life of the process.
const LOCK_CAPACITY: usize = 512;

/// The lock key for `path`.
///
/// Canonicalised so that every spelling of one file maps to one mutex —
/// `a.rs`, `./a.rs` and the absolute path must not take three different locks.
/// Falls back to the given path when the file does not exist yet (a create),
/// which is safe because a create races nothing that already exists.
fn lock_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn file_lock(path: &Path) -> Arc<Mutex<()>> {
    let key = lock_key(path);
    if LOCKS.len() > LOCK_CAPACITY {
        // Only entries nobody is holding: `strong_count == 1` means the map is
        // the sole owner, so no task is inside the critical section.
        LOCKS.retain(|_, v| Arc::strong_count(v) > 1);
    }
    LOCKS.entry(key).or_default().clone()
}

const BOM: &str = "\u{feff}";

fn detect_crlf(s: &str) -> bool {
    s.contains("\r\n")
}

/// Render `abs` relative to `working_dir` for display, falling back to `abs`.
fn display_path(working_dir: &Path, abs: &Path) -> String {
    abs.strip_prefix(working_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| abs.to_string_lossy().into_owned())
}

/// Compact line diff: common prefix/suffix elided, changed region shown -/+.
fn mini_diff(old: &str, new: &str) -> String {
    let o: Vec<&str> = old.split('\n').collect();
    let n: Vec<&str> = new.split('\n').collect();
    let mut p = 0;
    while p < o.len() && p < n.len() && o[p] == n[p] {
        p += 1;
    }
    let mut s = 0;
    while s < o.len() - p && s < n.len() - p && o[o.len() - 1 - s] == n[n.len() - 1 - s] {
        s += 1;
    }
    let removed = &o[p..o.len() - s];
    let added = &n[p..n.len() - s];
    let mut out = Vec::new();
    for l in removed.iter().take(12) {
        out.push(format!("- {l}"));
    }
    if removed.len() > 12 {
        out.push(format!("  … (-{} more)", removed.len() - 12));
    }
    for l in added.iter().take(12) {
        out.push(format!("+ {l}"));
    }
    if added.len() > 12 {
        out.push(format!("  … (+{} more)", added.len() - 12));
    }
    out.join("\n")
}

/// The structured half of an edit result.
///
/// Emitted as tool metadata so the session layer can hand the UI a real
/// before/after instead of re-deriving one from raw tool input. The field names
/// match the ACP `diff` content block, so the adapter is a rename-free pass
/// through.
pub fn diff_metadata(abs_path: &Path, old_text: &str, new_text: &str) -> Value {
    serde_json::json!({
        "diff": {
            "path": abs_path.to_string_lossy(),
            "oldText": old_text,
            "newText": new_text,
        }
    })
}

#[derive(Deserialize)]
struct Input {
    file_path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        "Edit"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path to the file (absolute, or relative to the project root)" },
                "old_string": { "type": "string", "description": "The exact text to replace" },
                "new_string": { "type": "string", "description": "The replacement text (must differ from old_string)" },
                "replace_all": { "type": "boolean", "description": "Replace all occurrences (default false)", "default": false }
            },
            "required": ["file_path", "old_string", "new_string"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::coerce_edit_args(input);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Edit",
                    &e.to_string(),
                    r#"{"file_path": "src/main.rs", "old_string": "<exact text to replace>", "new_string": "<replacement>"}"#,
                ))
            }
        };

        let path = abs_path(&ctx.working_dir, &input.file_path);
        let rel = display_path(&ctx.working_dir, &path);

        let lock = file_lock(&path);
        let _guard = lock.lock().await;

        // Create-on-empty-old-string (only when the file does not yet exist).
        if input.old_string.is_empty() {
            if path.exists() {
                return ToolResult::error(format!(
                    "old_string is empty but {rel} already exists. Provide the exact text to \
                     replace, or use Write for an intentional full-file replacement."
                ));
            }
            return match atomic::write(&path, input.new_string.as_bytes()).await {
                Ok(()) => ToolResult::success(format!(
                    "Created {rel} ({} bytes).",
                    input.new_string.len()
                ))
                .with_metadata(diff_metadata(&path, "", &input.new_string)),
                Err(e) => ToolResult::error(errors::write_failed(&rel, &e.to_string())),
            };
        }

        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return ToolResult::error(format!("File not found: {rel}"));
            }
            Err(e) => return ToolResult::error(format!("Failed to read {rel}: {e}")),
        };

        // Line-ending + BOM sandwich: normalize to \n for matching, restore on write.
        let had_bom = raw.starts_with(BOM);
        let content = raw.strip_prefix(BOM).unwrap_or(&raw);
        let crlf = detect_crlf(content);
        let content_lf = content.replace("\r\n", "\n");
        let old_lf = input.old_string.replace("\r\n", "\n");
        let new_lf = input.new_string.replace("\r\n", "\n");

        let result_lf = match replace::replace(&content_lf, &old_lf, &new_lf, input.replace_all) {
            Ok(s) => s,
            Err(replace::ReplaceError::Identical) => {
                return ToolResult::error(
                    "No changes to apply: old_string and new_string are identical.".to_string(),
                );
            }
            Err(replace::ReplaceError::EmptyOldString) => {
                return ToolResult::error(
                    "old_string is empty. Provide the exact text to replace, or use Write."
                        .to_string(),
                );
            }
            Err(replace::ReplaceError::NotFound) => {
                return ToolResult::error(errors::edit_not_found(&rel, &old_lf, &content_lf));
            }
            Err(replace::ReplaceError::MultipleMatches) => {
                return ToolResult::error(errors::edit_ambiguous(&rel));
            }
            Err(replace::ReplaceError::Disproportionate) => {
                return ToolResult::error(errors::edit_disproportionate(&rel));
            }
        };

        let diff = mini_diff(&content_lf, &result_lf);
        // Captured before the line endings are restored, so the structured diff
        // is in the same normalised form the UI renders.
        let structured = diff_metadata(&path, &content_lf, &result_lf);

        // Restore line endings + BOM.
        let mut to_write = if crlf {
            result_lf.replace('\n', "\r\n")
        } else {
            result_lf
        };
        if had_bom {
            to_write.insert_str(0, BOM);
        }

        match atomic::write(&path, to_write.as_bytes()).await {
            Ok(()) => ToolResult::success(format!("The file {rel} has been updated.\n{diff}"))
                .with_metadata(structured),
            Err(e) => ToolResult::error(errors::write_failed(&rel, &e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        EditTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn exact_edit() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "fn a() {}\nfn b() {}\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "fn a() {}", "new_string": "fn z() {}"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "fn z() {}\nfn b() {}\n");
    }

    #[tokio::test]
    async fn drifted_indent_edit_succeeds() {
        // File is tab-indented; the model sent spaces. Exact byte match misses
        // it (tab != spaces, and the line is not a substring); LineTrimmed
        // rescues it and yields the verbatim (tab-indented) slice.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "fn main() {\n\tlet x = 1;\n}\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "    let x = 1;", "new_string": "\tlet x = 2;"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "fn main() {\n\tlet x = 2;\n}\n");
    }

    #[tokio::test]
    async fn ambiguous_returns_corrective_error() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x = 1\ny = 2\nx = 1\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "x = 1", "new_string": "x = 9"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("multiple matches"));
        // File unchanged.
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "x = 1\ny = 2\nx = 1\n");
    }

    #[tokio::test]
    async fn replace_all_renames() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "foo();\nfoo();\nbar();\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "foo", "new_string": "baz", "replace_all": true}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "baz();\nbaz();\nbar();\n");
    }

    #[tokio::test]
    async fn create_guard_empty_old_existing_file() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "data\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "", "new_string": "new"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("already exists"));
    }

    #[tokio::test]
    async fn empty_old_creates_new_file() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "sub/new.txt", "old_string": "", "new_string": "hello"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(tmp.path().join("sub/new.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn crlf_preserved() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.txt");
        std::fs::write(&f, "a\r\nb\r\nc\r\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.txt", "old_string": "b", "new_string": "B"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "a\r\nB\r\nc\r\n");
    }

    #[tokio::test]
    async fn missing_file_errors() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "nope.rs", "old_string": "x", "new_string": "y"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("File not found"));
    }

    // ── D12: the structured diff is emitted, not just formatted ─────────────

    #[tokio::test]
    async fn a_successful_edit_carries_a_structured_diff() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "let x = 1;\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "let x = 1;", "new_string": "let x = 2;"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        let meta = r.metadata.expect("structured diff must be emitted");
        assert_eq!(meta["diff"]["oldText"], "let x = 1;\n");
        assert_eq!(meta["diff"]["newText"], "let x = 2;\n");
        assert!(meta["diff"]["path"].as_str().unwrap().ends_with("a.rs"));
    }

    #[tokio::test]
    async fn a_created_file_carries_an_empty_before() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "new.txt", "old_string": "", "new_string": "hello"}),
        )
        .await;
        let meta = r.metadata.expect("structured diff must be emitted");
        assert_eq!(meta["diff"]["oldText"], "");
        assert_eq!(meta["diff"]["newText"], "hello");
    }

    #[tokio::test]
    async fn a_failed_edit_carries_no_diff() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "nope", "new_string": "y"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.metadata.is_none(), "a rejected edit changed nothing");
    }

    // ── D2/D4: durability ───────────────────────────────────────────────────

    #[tokio::test]
    async fn every_spelling_of_one_file_takes_one_lock() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x").unwrap();
        let a = lock_key(&tmp.path().join("a.rs"));
        let b = lock_key(&tmp.path().join("./a.rs"));
        let c = lock_key(Path::new(&f.to_string_lossy().into_owned()));
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert!(Arc::ptr_eq(&file_lock(&f), &file_lock(&tmp.path().join("./a.rs"))));
    }

    #[tokio::test]
    async fn concurrent_edits_to_one_file_serialise() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "0\n").unwrap();
        // Two edits reaching the same file by different spellings. With the old
        // raw-path key these took different mutexes and could interleave.
        let dir = tmp.path().to_path_buf();
        let one = {
            let dir = dir.clone();
            tokio::spawn(async move {
                EditTool
                    .execute(
                        serde_json::json!({"file_path": "a.rs", "old_string": "0", "new_string": "1"}),
                        &test_ctx(dir),
                    )
                    .await
            })
        };
        let two = {
            let abs = f.to_string_lossy().into_owned();
            tokio::spawn(async move {
                EditTool
                    .execute(
                        serde_json::json!({"file_path": abs, "old_string": "0", "new_string": "2"}),
                        &test_ctx(dir),
                    )
                    .await
            })
        };
        let (a, b) = (one.await.unwrap(), two.await.unwrap());
        // Exactly one wins; the other finds its old_string gone. Either way the
        // file holds one complete value, never a mixture.
        let final_text = std::fs::read_to_string(&f).unwrap();
        assert!(final_text == "1\n" || final_text == "2\n", "{final_text:?}");
        assert!(a.is_error != b.is_error, "exactly one edit should apply");
    }

    #[tokio::test]
    async fn writes_leave_no_temp_files() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "one\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "one", "new_string": "two"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        let stray: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".atlas-"))
            .collect();
        assert!(stray.is_empty(), "{stray:?}");
    }
}
