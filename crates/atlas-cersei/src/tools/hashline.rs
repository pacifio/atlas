//! M6 — hashline-class editing (after oh-my-pi's `packages/hashline`, the
//! one reference addition with a measured mechanism).
//!
//! Exact-string replacement asks a weak model to reproduce bytes it has
//! already seen; line-addressed editing asks it only to point. Reads carry
//! a 4-hex whole-file tag (`[src/foo.rs#1A2B]`) over trailing-whitespace-
//! normalized content; edits address line numbers and quote the tag. Three
//! guards keep pointing honest:
//!
//! - **Tag check** — the quoted tag must match the file as it is now.
//!   Stale → fail closed, echoing the current content of every addressed
//!   range with fresh numbers and the fresh tag, so a straight retry works.
//! - **Seen-line guard** — an edit may only address lines that were
//!   actually displayed (the policy's ledger records what each read
//!   showed). A rejection inlines the missing lines for the same reason.
//! - **Post-edit echo** — the result carries the fresh tag and a
//!   renumbered preview, so chained edits need no re-read.
//!
//! Selected per model by `ModelProfile::edit_mode`; the ladder (`Edit`)
//! stays the frontier default.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::atomic;
use super::policy::ToolPolicy;

/// 4-hex whole-file tag: FNV-1a 32 over trailing-whitespace-normalized
/// lines, folded to 16 bits. FNV keeps it deterministic across processes
/// (a session can outlive one).
pub fn file_tag(content: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    // Neither a BOM nor the choice of line terminator is content the model
    // addressed, and the two sides of the check see different forms: `Read`
    // hashes the file as it sits on disk, while the editor hashes the
    // LF-normalised, BOM-stripped text it edits. Folding both here is what
    // keeps the tag agreeing across that seam. (`str::lines` already drops the
    // `\r` of a CRLF terminator; `trim_end` covers a stray one.)
    let content = content.strip_prefix(super::edit::BOM).unwrap_or(content);
    for line in content.lines() {
        for b in line.trim_end().bytes() {
            hash ^= u32::from(b);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        hash ^= u32::from(b'\n');
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{:04X}", (hash ^ (hash >> 16)) & 0xFFFF)
}

/// What a hashline read displayed: the file's tag at that moment and the
/// 1-based inclusive line ranges shown.
#[derive(Debug, Clone, Default)]
pub struct SeenLines {
    pub tag: String,
    pub ranges: Vec<(usize, usize)>,
}

impl SeenLines {
    pub fn covers(&self, start: usize, end: usize) -> bool {
        self.ranges.iter().any(|(a, b)| *a <= start && end <= *b)
    }

    /// Merge a newly displayed range (same tag) or reset to it (tag moved).
    pub fn note(&mut self, tag: &str, start: usize, end: usize) {
        if self.tag != tag {
            self.tag = tag.to_string();
            self.ranges.clear();
        }
        self.ranges.push((start, end));
    }
}

/// One line-addressed operation.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum HashlineOp {
    /// Replace lines `start_line..=end_line` with `text`.
    Replace {
        start_line: usize,
        end_line: usize,
        text: String,
    },
    /// Insert `text` after line `line` (0 = at the top of the file).
    InsertAfter { line: usize, text: String },
    /// Delete lines `start_line..=end_line`.
    Delete { start_line: usize, end_line: usize },
}

impl HashlineOp {
    /// The 1-based inclusive range of existing lines this op touches.
    /// Inserts touch the anchor line only (or line 1 for top-of-file).
    pub fn touched(&self) -> (usize, usize) {
        match self {
            HashlineOp::Replace { start_line, end_line, .. }
            | HashlineOp::Delete { start_line, end_line } => (*start_line, *end_line),
            HashlineOp::InsertAfter { line, .. } => {
                let l = (*line).max(1);
                (l, l)
            }
        }
    }
}

/// Apply `ops` to `lines` (1-based addressing). Validates bounds and
/// overlaps; returns the edited lines or a message naming the bad op.
pub fn apply_ops(lines: &[String], ops: &[HashlineOp]) -> Result<Vec<String>, String> {
    if ops.is_empty() {
        return Err("`edits` is empty — nothing to do.".into());
    }
    let n = lines.len();
    for op in ops {
        match op {
            HashlineOp::Replace { start_line, end_line, .. }
            | HashlineOp::Delete { start_line, end_line } => {
                if *start_line == 0 || *start_line > *end_line || *end_line > n {
                    return Err(format!(
                        "invalid line range {start_line}..{end_line} (file has {n} lines)"
                    ));
                }
            }
            HashlineOp::InsertAfter { line, .. } => {
                if *line > n {
                    return Err(format!("insert_after line {line} is past the end ({n} lines)"));
                }
            }
        }
    }
    // Reject overlapping replace/delete ranges: the result depends on
    // application order, which the model didn't specify.
    let mut spans: Vec<(usize, usize)> = ops
        .iter()
        .filter(|o| !matches!(o, HashlineOp::InsertAfter { .. }))
        .map(|o| o.touched())
        .collect();
    spans.sort();
    for pair in spans.windows(2) {
        if pair[1].0 <= pair[0].1 {
            return Err(format!(
                "edits overlap (lines {}..{} and {}..{}) — one edit per region",
                pair[0].0, pair[0].1, pair[1].0, pair[1].1
            ));
        }
    }

    // Apply bottom-up so earlier line numbers stay valid.
    let mut ordered: Vec<&HashlineOp> = ops.iter().collect();
    ordered.sort_by_key(|o| std::cmp::Reverse(o.touched().0));
    let mut out: Vec<String> = lines.to_vec();
    for op in ordered {
        match op {
            HashlineOp::Replace { start_line, end_line, text } => {
                let new: Vec<String> = text.lines().map(String::from).collect();
                out.splice(start_line - 1..*end_line, new);
            }
            HashlineOp::Delete { start_line, end_line } => {
                out.splice(start_line - 1..*end_line, std::iter::empty::<String>());
            }
            HashlineOp::InsertAfter { line, text } => {
                let new: Vec<String> = text.lines().map(String::from).collect();
                out.splice(*line..*line, new);
            }
        }
    }
    Ok(out)
}

/// Render `lines[start..=end]` (1-based, clamped) as numbered rows.
fn numbered(lines: &[String], start: usize, end: usize) -> String {
    let start = start.max(1);
    let end = end.min(lines.len());
    (start..=end)
        .map(|i| format!("{i}: {}", lines[i - 1]))
        .collect::<Vec<_>>()
        .join("\n")
}

const DESCRIPTION: &str = "Edits a file by line number, validated by the file tag from Read.\n\
- Quote `tag` exactly as the last Read showed it (`[path#TAG]`). A stale tag fails \
the edit and shows the current lines — retry with what it shows.\n\
- Only lines a Read displayed can be edited.\n\
- Ops: replace (start_line..end_line -> text), insert_after (line, text; line 0 = top), \
delete (start_line..end_line). Line numbers refer to the file BEFORE this call; \
multiple ops must not overlap.\n\
- The result echoes the fresh tag and renumbered lines — no re-read needed to chain edits.";

/// The line-addressed editor. Registered instead of `Edit` when the model's
/// profile selects `EditMode::Hashline`.
pub struct HashlineEditTool {
    pub policy: Arc<ToolPolicy>,
}

#[derive(Deserialize)]
struct EditInput {
    file_path: String,
    tag: String,
    edits: Vec<HashlineOp>,
}

#[async_trait]
impl Tool for HashlineEditTool {
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
                "file_path": { "type": "string" },
                "tag": { "type": "string", "description": "The 4-hex file tag from the last Read." },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": { "type": "string", "enum": ["replace", "insert_after", "delete"] },
                            "start_line": { "type": "integer" },
                            "end_line": { "type": "integer" },
                            "line": { "type": "integer" },
                            "text": { "type": "string" }
                        },
                        "required": ["op"]
                    }
                }
            },
            "required": ["file_path", "tag", "edits"]
        })
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let parsed: EditInput = match serde_json::from_value(input) {
            Ok(p) => p,
            Err(e) => return ToolResult::error(format!("Invalid input: {e}")),
        };
        let path = PathBuf::from(&parsed.file_path);
        let rel = display_rel(&path, self.policy.root());

        // Per-file lock, keyed on the canonical path, taken before the read.
        // The runner runs a tool batch in parallel and every hashline profile
        // allows parallel calls, so without this two edits to one file both
        // read the same content, both pass the same tag check, and the second
        // write discards the first — with both results reporting success. The
        // loser now re-reads post-write content and fails the tag check, which
        // is the retry path this mode is built around.
        let lock = super::edit::file_lock(&path);
        let _guard = lock.lock().await;

        let raw = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => return ToolResult::error(format!("Failed to read {rel}: {e}")),
        };
        // Line-ending + BOM sandwich, exactly as `edit.rs` does it: address and
        // edit in LF, restore on write. `lines()` strips the `\r` of a CRLF
        // terminator, so joining with "\n" rewrote every line ending in the
        // file — whole-file churn in git from a one-line edit, and a diff
        // claiming every line changed.
        let had_bom = raw.starts_with(super::edit::BOM);
        let stripped = raw.strip_prefix(super::edit::BOM).unwrap_or(&raw);
        let crlf = super::edit::detect_crlf(stripped);
        let content = stripped.replace("\r\n", "\n");
        let lines: Vec<String> = content.lines().map(String::from).collect();
        let current_tag = file_tag(&content);

        // Tag check — fail closed with the fresh state inlined.
        if !parsed.tag.eq_ignore_ascii_case(&current_tag) {
            let mut msg = format!(
                "Stale tag: you quoted #{}, the file is now [{}#{}]. Current content of the \
                 addressed lines:\n",
                parsed.tag, rel, current_tag
            );
            for op in &parsed.edits {
                let (s, e) = op.touched();
                msg.push_str(&numbered(&lines, s.saturating_sub(2), e + 2));
                msg.push('\n');
            }
            msg.push_str("Retry with tag ");
            msg.push_str(&current_tag);
            msg.push_str(" and these line numbers.");
            self.note_seen(&path, &current_tag, &parsed.edits, &lines);
            return ToolResult::error(msg);
        }

        // Seen-line guard — reject, inlining what was never displayed.
        let seen = self.policy.hashline_seen(&path);
        let mut unseen: Vec<(usize, usize)> = Vec::new();
        for op in &parsed.edits {
            let (s, e) = op.touched();
            let visible = seen
                .as_ref()
                .is_some_and(|sl| sl.tag == current_tag && sl.covers(s, e.min(lines.len().max(1))));
            if !visible {
                unseen.push((s, e));
            }
        }
        if !unseen.is_empty() {
            let mut msg = format!(
                "Lines you addressed were never displayed by a Read. Here they are \
                 ([{rel}#{current_tag}]):\n"
            );
            for (s, e) in &unseen {
                msg.push_str(&numbered(&lines, s.saturating_sub(2), e + 2));
                msg.push('\n');
            }
            msg.push_str("Retry the same edit — these lines now count as displayed.");
            self.note_seen(&path, &current_tag, &parsed.edits, &lines);
            return ToolResult::error(msg);
        }

        let new_lines = match apply_ops(&lines, &parsed.edits) {
            Ok(l) => l,
            Err(e) => return ToolResult::error(e),
        };
        let mut new_content = new_lines.join("\n");
        if content.ends_with('\n') || new_content.is_empty() {
            new_content.push('\n');
        }
        // The tag and the echoed preview describe the LF form the model
        // addressed; only the bytes on disk get the original terminators back.
        let mut to_write = if crlf {
            new_content.replace('\n', "\r\n")
        } else {
            new_content.clone()
        };
        if had_bom {
            to_write.insert_str(0, super::edit::BOM);
        }
        if let Err(e) = atomic::write(&path, to_write.as_bytes()).await {
            return ToolResult::error(format!("Failed to write {rel}: {e}"));
        }

        // Post-edit echo: fresh tag + renumbered preview around the first
        // edited region, and the ledger learns the new state.
        let new_tag = file_tag(&new_content);
        let first = parsed.edits.iter().map(|o| o.touched().0).min().unwrap_or(1);
        let preview_end = (first + 8).min(new_lines.len());
        let preview = numbered(&new_lines, first.saturating_sub(2), preview_end);
        {
            let mut sl = SeenLines { tag: new_tag.clone(), ranges: Vec::new() };
            sl.note(&new_tag, first.saturating_sub(2).max(1), preview_end.max(1));
            self.policy.record_hashline_seen(&path, sl);
        }
        ToolResult::success(format!(
            "Applied {} edit(s). [{rel}#{new_tag}]\n{preview}",
            parsed.edits.len()
        ))
        .with_metadata(serde_json::json!({
            "diff": { "path": parsed.file_path, "oldText": content, "newText": new_content }
        }))
    }
}

impl HashlineEditTool {
    /// After echoing fresh context in a rejection, those lines count as
    /// displayed — that is what makes a straight retry succeed.
    fn note_seen(&self, path: &Path, tag: &str, ops: &[HashlineOp], lines: &[String]) {
        let mut sl = self.policy.hashline_seen(path).unwrap_or_default();
        for op in ops {
            let (s, e) = op.touched();
            sl.note(tag, s.saturating_sub(2).max(1), (e + 2).min(lines.len().max(1)));
        }
        self.policy.record_hashline_seen(path, sl);
    }
}

fn display_rel(path: &Path, root: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(String::from).collect()
    }

    /// Scratch dir removed on drop (house idiom — no tempfile dependency).
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("atlas-hashline-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_edits_to_one_file_cannot_lose_one_another() {
        // The runner executes a tool batch in parallel (`join_all`), and every
        // profile that selects hashline also resolves `parallel_tools: true`.
        // Without a per-file lock both calls read the same content, both pass
        // the same tag check, and the second `atomic::write` discards the
        // first's edit — while both results report success with a fresh tag.
        // `edit.rs` has taken this lock since it was written.
        let tmp = Scratch::new();
        let path = tmp.0.join("a.rs");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let tag = file_tag(&std::fs::read_to_string(&path).unwrap());

        let policy = ToolPolicy::contained(tmp.0.clone());
        // Both lines count as displayed, so the seen-line guard is not what is
        // under test here.
        let mut sl = SeenLines { tag: tag.clone(), ranges: Vec::new() };
        sl.note(&tag, 1, 3);
        policy.record_hashline_seen(&path, sl);

        let tool = Arc::new(HashlineEditTool { policy });
        let ctx = Arc::new(crate::tools::test_ctx(tmp.0.clone()));
        let call = |line: usize, text: &str| {
            let tool = Arc::clone(&tool);
            let ctx = Arc::clone(&ctx);
            let input = serde_json::json!({
                "file_path": path.to_string_lossy(),
                "tag": tag,
                "edits": [{"op": "replace", "start_line": line, "end_line": line, "text": text}]
            });
            async move { tool.execute(input, &ctx).await }
        };
        let (a, b) = tokio::join!(call(1, "ONE"), call(3, "THREE"));

        let after = std::fs::read_to_string(&path).unwrap();
        let landed = [&a, &b].iter().filter(|r| !r.is_error).count();
        // Whichever runs second sees content whose tag has moved and fails
        // closed — the retry path the model already knows how to follow. What
        // must never happen is two successes with only one edit on disk.
        for r in [&a, &b] {
            if !r.is_error {
                continue;
            }
            assert!(
                r.content.contains("Stale tag"),
                "the loser must fail closed on the tag, not silently: {}",
                r.content
            );
        }
        let edits_on_disk =
            after.contains("ONE") as usize + after.contains("THREE") as usize;
        assert_eq!(
            landed, edits_on_disk,
            "a reported success was lost: results said {landed} landed, disk has \
             {edits_on_disk} ({after:?})"
        );
    }

    #[test]
    fn the_tag_ignores_trailing_whitespace_and_is_4_hex() {
        let a = file_tag("fn main() {}\nlet x = 1;\n");
        let b = file_tag("fn main() {}   \nlet x = 1;\t\n");
        assert_eq!(a, b, "trailing whitespace must not move the tag");
        assert_eq!(a.len(), 4);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, file_tag("fn main() {}\nlet x = 2;\n"), "content moves the tag");
    }

    #[test]
    fn the_tag_ignores_the_bom_and_the_line_terminator() {
        // Read hashes the file as it sits on disk; the editor hashes the
        // LF-normalised, BOM-stripped text it addresses. If those disagree,
        // every edit to a CRLF or BOM'd file fails as a stale tag forever.
        let lf = file_tag("a\nb\n");
        assert_eq!(lf, file_tag("a\r\nb\r\n"), "CRLF must not move the tag");
        assert_eq!(lf, file_tag("\u{feff}a\nb\n"), "a BOM must not move the tag");
        assert_eq!(lf, file_tag("\u{feff}a\r\nb\r\n"), "nor the two together");
    }

    #[test]
    fn ops_apply_bottom_up_with_stable_addressing() {
        let src = lines("one\ntwo\nthree\nfour\nfive");
        let out = apply_ops(
            &src,
            &[
                HashlineOp::Replace { start_line: 2, end_line: 2, text: "TWO".into() },
                HashlineOp::Delete { start_line: 4, end_line: 4 },
                HashlineOp::InsertAfter { line: 5, text: "six".into() },
            ],
        )
        .unwrap();
        assert_eq!(out, lines("one\nTWO\nthree\nfive\nsix"));
    }

    #[test]
    fn inserts_at_top_and_multi_line_replacements_work() {
        let src = lines("a\nb");
        let out = apply_ops(
            &src,
            &[
                HashlineOp::InsertAfter { line: 0, text: "header".into() },
                HashlineOp::Replace { start_line: 2, end_line: 2, text: "b1\nb2".into() },
            ],
        )
        .unwrap();
        assert_eq!(out, lines("header\na\nb1\nb2"));
    }

    #[test]
    fn bad_ranges_and_overlaps_are_rejected_with_names() {
        let src = lines("a\nb\nc");
        let err = apply_ops(&src, &[HashlineOp::Delete { start_line: 2, end_line: 9 }]).unwrap_err();
        assert!(err.contains("invalid line range"), "{err}");
        let err = apply_ops(
            &src,
            &[
                HashlineOp::Replace { start_line: 1, end_line: 2, text: "x".into() },
                HashlineOp::Delete { start_line: 2, end_line: 3 },
            ],
        )
        .unwrap_err();
        assert!(err.contains("overlap"), "{err}");
    }

    #[test]
    fn seen_lines_cover_merge_and_reset_on_tag_change() {
        let mut sl = SeenLines::default();
        sl.note("AAAA", 1, 10);
        sl.note("AAAA", 20, 30);
        assert!(sl.covers(5, 9));
        assert!(sl.covers(20, 30));
        assert!(!sl.covers(9, 21), "a gap is not covered");
        sl.note("BBBB", 1, 3);
        assert_eq!(sl.tag, "BBBB");
        assert!(!sl.covers(20, 30), "old tag's ranges are gone");
    }
}
