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

const DESCRIPTION: &str = "Exact string replacement in a file. Prefer this over shell tools \
(sed/awk/perl) — it is grounded in the real file and tolerates whitespace drift.\n\
- Read the file first. Copy the text AFTER the `N: ` prefix; never include the prefix itself.\n\
- old_string must be unique, or the edit is rejected: add context, or set replace_all.\n\
- Use `edits` to make several replacements to one file in ONE call. They apply in order and \
nothing is written unless every one succeeds. Prefer this over repeated Edit calls.\n\
- Empty old_string creates the file. For a whole-file rewrite use Write.\n\
- ONE of these two shapes, never both:\n\
  {\"file_path\": \"a.rs\", \"old_string\": \"fn a()\", \"new_string\": \"fn b()\"}\n\
  {\"file_path\": \"a.rs\", \"edits\": [{\"old_string\": \"a\", \"new_string\": \"b\"}]}\n\
- Returns a diff of what changed. On failure nothing is written.";

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
pub fn diff_metadata(target: &Path, old_text: &str, new_text: &str) -> Value {
    serde_json::json!({
        "diff": {
            "path": target.to_string_lossy(),
            "oldText": old_text,
            "newText": new_text,
        }
    })
}

/// One replacement. The flat `old_string`/`new_string` form and one entry of
/// `edits` are the same thing, so the executor only ever sees a list.
#[derive(Deserialize)]
struct EditOp {
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize)]
struct Input {
    file_path: String,
    old_string: Option<String>,
    new_string: Option<String>,
    /// `Option` rather than a defaulted `bool` so that "the model set this" is
    /// distinguishable from "the model left it alone" — which is what lets the
    /// top-level flag be *refused* alongside `edits` instead of silently
    /// ignored.
    replace_all: Option<bool>,
    /// Several replacements to the same file in one call. This absorbs what was
    /// a separate `MultiEdit` tool: an identical schema for an identical
    /// operation, costing a second entry in every tool list the model is sent
    /// and a choice it had to get right.
    edits: Option<Vec<EditOp>>,
}

impl Input {
    /// Normalise both accepted shapes to a list.
    ///
    /// Anything ambiguous is **refused, never resolved**. Silently preferring
    /// one shape drops a replacement the model asked for, and it would only
    /// find out by reading the file back — which is exactly the class of
    /// failure the read-before-edit precondition exists to prevent.
    fn ops(self) -> Result<(String, Vec<EditOp>), String> {
        let flat = self.old_string.is_some() || self.new_string.is_some();
        let top_level_replace_all = self.replace_all;
        match self.edits {
            Some(edits) if !edits.is_empty() => {
                if flat {
                    return Err("Edit takes either old_string/new_string or edits, not both. \
                                Move the replacement into the edits array."
                        .to_string());
                }
                if top_level_replace_all.is_some() {
                    return Err("replace_all belongs to one replacement. Set it inside the edits \
                                entry it applies to, not at the top level."
                        .to_string());
                }
                // A lone edit with an empty old_string is the create form and is
                // handled below. Inside a batch it cannot be: the file has to
                // exist for the later edits to match against.
                if edits.len() > 1 {
                    if let Some(i) = edits.iter().position(|e| e.old_string.is_empty()) {
                        return Err(format!(
                            "Edit {} of {} has an empty old_string, which means `create this \
                             file` and cannot be combined with other edits. Create the file in \
                             its own call, then edit it.",
                            i + 1,
                            edits.len()
                        ));
                    }
                }
                Ok((self.file_path, edits))
            }
            _ => match (self.old_string, self.new_string) {
                (Some(old_string), Some(new_string)) => Ok((
                    self.file_path,
                    vec![EditOp {
                        old_string,
                        new_string,
                        replace_all: top_level_replace_all.unwrap_or(false),
                    }],
                )),
                _ => Err(
                    "Edit needs either old_string and new_string, or a non-empty edits array."
                        .to_string(),
                ),
            },
        }
    }
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
                "new_string": { "type": "string", "description": "The replacement text" },
                "replace_all": { "type": "boolean", "description": "Replace all occurrences (default false)", "default": false },
                "edits": {
                    "type": "array",
                    "description": "Several replacements to this file, applied in order. Use instead of old_string/new_string.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": { "type": "string" },
                            "new_string": { "type": "string" },
                            "replace_all": { "type": "boolean", "default": false }
                        },
                        "required": ["old_string", "new_string"]
                    }
                }
            },
            "required": ["file_path"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
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
        let (file_path, ops) = match input.ops() {
            Ok(v) => v,
            Err(e) => return ToolResult::error(e),
        };

        let path = abs_path(&ctx.working_dir, &file_path);
        let rel = display_path(&ctx.working_dir, &path);

        let lock = file_lock(&path);
        let _guard = lock.lock().await;

        // Create-on-empty-old-string (only when the file does not yet exist).
        if ops.len() == 1 && ops[0].old_string.is_empty() {
            let created = &ops[0].new_string;
            if path.exists() {
                return ToolResult::error(format!(
                    "old_string is empty but {rel} already exists. Provide the exact text to \
                     replace, or use Write for an intentional full-file replacement."
                ));
            }
            return match atomic::write(&path, created.as_bytes()).await {
                Ok(()) => ToolResult::success(format!("Created {rel} ({} bytes).", created.len()))
                    .with_metadata(diff_metadata(&path, "", created)),
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

        // Applied in sequence, each against the result of the last, and written
        // only if every one succeeds. A batch that fails halfway must leave the
        // file exactly as it was, or the model is reasoning about a state
        // nothing described to it.
        // `Cow` rather than a clone: the common single-edit call borrows the
        // content it already read instead of copying the whole file to have
        // something to hand the loop.
        let mut result_lf: std::borrow::Cow<'_, str> = std::borrow::Cow::Borrowed(&content_lf);
        for (i, op) in ops.iter().enumerate() {
            let old_lf = op.old_string.replace("\r\n", "\n");
            let mut new_lf = op.new_string.replace("\r\n", "\n");
            // The fence rescue lives here, next to the matcher, raw-first —
            // NOT in coerce at dispatch, where unconditional stripping
            // corrupted legitimate edits to fenced markdown. Two quirk shapes:
            //
            // * new_string alone arrives ```-wrapped. Stripped only when
            //   nothing in play legitimately contains a fence — the moment the
            //   file or old_string has one, the fences are taken verbatim.
            if !old_lf.contains("```") && !result_lf.contains("```") {
                let stripped = coerce::strip_code_fences(&new_lf);
                if stripped != new_lf {
                    new_lf = stripped;
                }
            }
            // * both sides arrive ```-wrapped. The verbatim text is tried
            //   first; only a NotFound falls back to the de-fenced pair, so an
            //   edit whose payload really is a fenced block still matches.
            let attempt = match replace::replace(&result_lf, &old_lf, &new_lf, op.replace_all) {
                Err(replace::ReplaceError::NotFound) => {
                    let stripped_old = coerce::strip_code_fences(&old_lf);
                    if stripped_old != old_lf {
                        let stripped_new = coerce::strip_code_fences(&new_lf);
                        replace::replace(&result_lf, &stripped_old, &stripped_new, op.replace_all)
                    } else {
                        Err(replace::ReplaceError::NotFound)
                    }
                }
                other => other,
            };
            result_lf = match attempt {
                Ok(s) => std::borrow::Cow::Owned(s),
                Err(e) => {
                    let why = match e {
                        replace::ReplaceError::Identical => {
                            "No changes to apply: old_string and new_string are identical."
                                .to_string()
                        }
                        replace::ReplaceError::EmptyOldString => {
                            "old_string is empty. Provide the exact text to replace, or use Write."
                                .to_string()
                        }
                        // Against the content as it stands *after* the earlier
                        // edits — which is what the model has to match next.
                        replace::ReplaceError::NotFound => {
                            errors::edit_not_found(&rel, &old_lf, &result_lf)
                        }
                        replace::ReplaceError::MultipleMatches => errors::edit_ambiguous(&rel),
                        replace::ReplaceError::Disproportionate => {
                            errors::edit_disproportionate(&rel)
                        }
                    };
                    return ToolResult::error(errors::batch_failure(i, ops.len(), &why));
                }
            };
        }

        let diff = mini_diff(&content_lf, &result_lf);
        // Captured before the line endings are restored, so the structured diff
        // is in the same normalised form the UI renders.
        let structured = diff_metadata(&path, &content_lf, &result_lf);

        // Restore line endings + BOM.
        let mut to_write = if crlf {
            result_lf.replace('\n', "\r\n")
        } else {
            result_lf.into_owned()
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

    // ── Batched edits (what used to be a separate MultiEdit tool) ───────────

    #[tokio::test]
    async fn several_edits_land_in_one_call() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "let a = 1;\nlet b = 2;\nlet c = 3;\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "edits": [
                    {"old_string": "let a = 1;", "new_string": "let a = 10;"},
                    {"old_string": "let c = 3;", "new_string": "let c = 30;"}
                ]
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "let a = 10;\nlet b = 2;\nlet c = 30;\n"
        );
    }

    #[tokio::test]
    async fn edits_apply_in_order_against_the_previous_result() {
        // The second edit matches text the first one created, so a parallel
        // application would fail where a sequential one succeeds.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "one\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "edits": [
                    {"old_string": "one", "new_string": "two"},
                    {"old_string": "two", "new_string": "three"}
                ]
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "three\n");
    }

    #[tokio::test]
    async fn a_batch_that_fails_halfway_writes_nothing() {
        // All-or-nothing is the whole reason to batch: a partially applied set
        // leaves the model reasoning about a state nothing described to it.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "keep me\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "edits": [
                    {"old_string": "keep me", "new_string": "changed"},
                    {"old_string": "not in the file", "new_string": "x"}
                ]
            }),
        )
        .await;
        assert!(r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "keep me\n",
            "a failed batch must not leave a partial write"
        );
        assert!(r.content.contains("Edit 2 of 2"), "must locate the failure: {}", r.content);
        assert!(r.content.contains("unchanged"), "{}", r.content);
    }

    #[tokio::test]
    async fn over_specified_input_is_refused_rather_than_silently_resolved() {
        // Preferring one shape would drop a replacement the model asked for,
        // and it would only find out by reading the file back.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x\n").unwrap();

        let both = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "old_string": "x",
                "new_string": "y",
                "edits": [{"old_string": "x", "new_string": "z"}]
            }),
        )
        .await;
        assert!(both.is_error, "{}", both.content);
        assert!(both.content.contains("not both"), "{}", both.content);
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.rs")).unwrap(), "x\n");

        let stray_flag = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "replace_all": true,
                "edits": [{"old_string": "x", "new_string": "z"}]
            }),
        )
        .await;
        assert!(stray_flag.is_error, "{}", stray_flag.content);
        assert!(stray_flag.content.contains("replace_all"), "{}", stray_flag.content);
    }

    #[tokio::test]
    async fn creating_a_file_inside_a_batch_is_a_correctable_error() {
        // An empty old_string means "create this file", which cannot be
        // combined with edits that have to match against its contents. The
        // description promises creation with no caveat, so the refusal has to
        // explain itself rather than surface as "File not found".
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "new.rs",
                "edits": [
                    {"old_string": "", "new_string": "fn a() {}\n"},
                    {"old_string": "a", "new_string": "b"}
                ]
            }),
        )
        .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("empty old_string"), "{}", r.content);
        assert!(!tmp.path().join("new.rs").exists(), "nothing should have been created");
    }

    #[tokio::test]
    async fn a_lone_edits_entry_still_creates_a_file() {
        // One entry is the same thing as the flat form, so it keeps the create
        // behaviour the description promises.
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "new.rs",
                "edits": [{"old_string": "", "new_string": "fn a() {}\n"}]
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("new.rs")).unwrap(),
            "fn a() {}\n"
        );
    }

    #[tokio::test]
    async fn a_lone_failure_is_not_dressed_up_as_a_batch() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "nope", "new_string": "y"}),
        )
        .await;
        assert!(r.is_error);
        assert!(!r.content.contains("of 1"), "{}", r.content);
    }

    #[tokio::test]
    async fn replace_all_works_inside_a_batch() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x x x\ny\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "edits": [
                    {"old_string": "x", "new_string": "z", "replace_all": true},
                    {"old_string": "y", "new_string": "w"}
                ]
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "z z z\nw\n");
    }

    #[tokio::test]
    async fn a_batch_reports_one_diff_covering_every_edit() {
        // The UI counts changed lines from this, so a batch that reported only
        // its last edit would undercount.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "a\nb\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "edits": [
                    {"old_string": "a", "new_string": "A"},
                    {"old_string": "b", "new_string": "B"}
                ]
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        let diff = &r.metadata.as_ref().expect("a diff was reported")["diff"];
        assert_eq!(diff["oldText"], "a\nb\n");
        assert_eq!(diff["newText"], "A\nB\n");
    }

    #[tokio::test]
    async fn neither_shape_is_a_correctable_error() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x\n").unwrap();
        for args in [
            serde_json::json!({"file_path": "a.rs"}),
            serde_json::json!({"file_path": "a.rs", "edits": []}),
            serde_json::json!({"file_path": "a.rs", "old_string": "x"}),
        ] {
            let r = run(tmp.path(), args.clone()).await;
            assert!(r.is_error, "{args} should not have been accepted");
            assert!(r.content.contains("edits"), "must name the alternative: {}", r.content);
        }
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

    // ── Fence handling: verbatim first, rescue second ───────────────────────

    #[tokio::test]
    async fn an_edit_whose_payload_is_a_fenced_block_matches_verbatim() {
        // Replacing a whole fenced block in markdown with plain text — the
        // case dispatch-time stripping corrupted: the de-fenced old matched
        // only the inner line, so the replacement landed inside the fences and
        // left them behind as debris.
        let tmp = TmpDir::new();
        let f = tmp.path().join("README.md");
        std::fs::write(&f, "Intro\n\n```rust\nfn old() {}\n```\n\nOutro\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "README.md",
                "old_string": "```rust\nfn old() {}\n```",
                "new_string": "See the source instead."
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "Intro\n\nSee the source instead.\n\nOutro\n",
            "the fenced block is payload: it must be matched verbatim and fully replaced"
        );
    }

    #[tokio::test]
    async fn a_model_that_wrapped_both_sides_in_fences_is_still_rescued() {
        // The quirk the old dispatch stripping existed for: a rust file with
        // no fences anywhere, and the model ```-wrapped its old and new text.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "fn a() {}\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "old_string": "```rust\nfn a() {}\n```",
                "new_string": "```rust\nfn b() {}\n```"
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "fn b() {}\n");
    }

    #[tokio::test]
    async fn a_fenced_new_string_alone_is_unwrapped_only_outside_fenced_files() {
        // new_string alone arrives wrapped; old matches raw. In a file with no
        // fences this is the quirk — strip. In a file that has fences, the
        // wrapping is taken verbatim, because there is no way to distinguish
        // quirk from intent and corrupting markdown silently is the worse
        // failure.
        let tmp = TmpDir::new();
        let plain = tmp.path().join("a.rs");
        std::fs::write(&plain, "fn a() {}\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "a.rs",
                "old_string": "fn a() {}",
                "new_string": "```rust\nfn b() {}\n```"
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&plain).unwrap(), "fn b() {}\n");

        let md = tmp.path().join("doc.md");
        std::fs::write(&md, "Text\n\n```sh\nls\n```\n\nAdd here:\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "file_path": "doc.md",
                "old_string": "Add here:",
                "new_string": "```sh\npwd\n```"
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            std::fs::read_to_string(&md).unwrap().contains("```sh\npwd\n```"),
            "in a file that already has fences, the replacement is verbatim"
        );
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
