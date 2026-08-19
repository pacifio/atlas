//! `Grep` — regex search whose default answer is cheap.
//!
//! The SDK tool this replaces had one output shape: every match as
//! `file:line:content`, capped at 250, with nothing saying the cap had been
//! hit. Three things followed from that, and all three reached the user as
//! "the agent burns context and still doesn't know where to edit":
//!
//! * **The cheap question could not be asked.** "Which files mention this?" is
//!   answered by a path list — measured on this repo, 409 tokens instead of
//!   6,495 for the same query. There was no way to ask for it.
//! * **The cap was silent, and picked its 250 by racing threads.** The
//!   primitive quits the parallel walk when a shared counter crosses the cap
//!   and sorts *afterwards*, so the survivors arrive neatly ordered and look
//!   complete. A model told "here are the matches" concluded it had them all.
//! * **A bare match line cannot be edited from.** With no surrounding lines the
//!   model cannot build an `old_string`, so every location question became a
//!   whole-file `Read` — 7,727 tokens where three lines of context cost 399.
//!
//! So: two output modes with the cheap one first, context lines, and a cap that
//! reports the true total. Determinism is bought by scanning to [`SCAN_LIMIT`]
//! rather than the display cap — under that ceiling the walk runs to completion,
//! so the count is exact and the same query twice gives the same answer.
//!
//! Note what this tool deliberately does *not* do: it never calls
//! `record_read`. Context lines are a window, not the file, and letting them
//! satisfy read-before-edit would reopen the staleness hole the shell-read path
//! already had to close.

use async_trait::async_trait;
use cersei::tools::tool_primitives::search as psearch;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

use super::{abs_path, coerce, errors};

/// How many matches the walk collects before it stops.
///
/// Deliberately far above any cap we display. Below this the `ignore` walk runs
/// to completion, so the total is exact and the result order is stable; the
/// primitive's thread-raced early quit only becomes reachable past a point where
/// no answer is useful without narrowing anyway.
const SCAN_LIMIT: usize = 20_000;
/// Files listed in `files` mode before the list is capped.
const FILE_LIMIT: usize = 100;
/// Matches shown in `content` mode when `head_limit` is not given.
const CONTENT_LIMIT: usize = 40;
const CONTEXT_DEFAULT: usize = 2;
const CONTEXT_MAX: usize = 10;

const DESCRIPTION: &str = "Searches file contents by regex, in-process (ripgrep-powered), \
honoring .gitignore. Prefer it over `rg`/`grep` in Bash — no external tools needed.\n\n\
- output_mode \"files\" (default): matching paths with a match count each, densest first. Cheap \
— use it to find where something lives.\n\
- output_mode \"content\": the matching lines grouped by file, with `context` lines around each \
(default 2); match lines marked `12:`, context `12-`. Narrow with `path` first.\n\n\
Locating an edit site takes two calls: default mode for the file, then content mode with that \
`path`.";

#[derive(Deserialize)]
struct Input {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    output_mode: Option<String>,
    context: Option<usize>,
    head_limit: Option<usize>,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default)]
    hidden: bool,
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "Grep"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern to search for" },
                "path": { "type": "string", "description": "File or directory to search (default: project root)" },
                "glob": { "type": "string", "description": "Only search files matching this glob, e.g. *.rs" },
                "output_mode": {
                    "type": "string",
                    "enum": ["files", "content"],
                    "description": "Default \"files\""
                },
                "context": { "type": "integer", "description": "Context lines per match in content mode (default 2, max 10)" },
                "head_limit": { "type": "integer", "description": "Max matches shown in content mode (default 40)" },
                "case_insensitive": { "type": "boolean", "description": "Case-insensitive matching", "default": false },
                "hidden": { "type": "boolean", "description": "Include hidden files", "default": false }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Grep",
                    &e.to_string(),
                    r#"{"pattern": "fn build_system_prompt", "glob": "*.rs"}"#,
                ))
            }
        };

        let content_mode = match input.output_mode.as_deref() {
            None | Some("files") => false,
            Some("content") => true,
            Some(other) => {
                return ToolResult::error(format!(
                    "Unknown output_mode {other:?}. Use \"files\" (paths with counts) or \
                     \"content\" (matching lines with context)."
                ))
            }
        };

        let root = match &input.path {
            Some(p) => abs_path(&ctx.working_dir, p),
            None => ctx.working_dir.clone(),
        };
        if !root.exists() {
            return ToolResult::error(format!("Path not found: {}", root.display()));
        }

        let opts = psearch::GrepOptions {
            glob_filter: input.glob.clone(),
            max_results: Some(SCAN_LIMIT),
            case_insensitive: input.case_insensitive,
            no_ignore: false,
            hidden: input.hidden,
        };

        let matches = match psearch::grep(&input.pattern, &root, opts).await {
            Ok(m) => m,
            Err(e) => {
                return ToolResult::error(format!(
                    "Search failed: {e}\nCheck the regex — literal `(`, `)`, `[`, `?` and `*` \
                     need escaping."
                ))
            }
        };

        if matches.is_empty() {
            return ToolResult::success(no_matches(&input));
        }

        // The primitive sorts by (file, line), so equal paths are already
        // adjacent; BTreeMap keeps the grouping stable regardless.
        let mut by_file: BTreeMap<&Path, Vec<&psearch::SearchMatch>> = BTreeMap::new();
        for m in &matches {
            by_file.entry(m.file.as_path()).or_default().push(m);
        }
        let total_matches = matches.len();
        let total_files = by_file.len();
        // Past the ceiling the walk stopped early, so both totals are floors.
        let scan_capped = total_matches >= SCAN_LIMIT;

        let body = if content_mode {
            render_content(&input, &by_file, &ctx.working_dir, total_matches, total_files, scan_capped)
        } else {
            render_files(&input, &by_file, &ctx.working_dir, total_matches, total_files, scan_capped)
        };
        ToolResult::success(body)
    }
}

/// An empty result is a fork in the road, not a dead end — say which way to go.
fn no_matches(input: &Input) -> String {
    let mut s = format!("No matches for `{}`", input.pattern);
    if let Some(g) = &input.glob {
        s.push_str(&format!(" in files matching `{g}`"));
    }
    if let Some(p) = &input.path {
        s.push_str(&format!(" under `{p}`"));
    }
    s.push_str(
        ".\nThe pattern is a regex: `(`, `)`, `[`, `?`, `*` and `.` are special and need \
         escaping to match literally. If the spelling or casing is uncertain, retry with a \
         shorter fragment or case_insensitive: true.",
    );
    s
}

fn rel<'a>(path: &'a Path, working_dir: &Path) -> std::borrow::Cow<'a, str> {
    path.strip_prefix(working_dir)
        .unwrap_or(path)
        .to_string_lossy()
}

/// `files` mode: paths with counts, densest first.
///
/// Count order rather than path order because the question this mode answers is
/// "where does this actually live" — the definition site is usually the file
/// with the most hits, and a model that reads only the first line of the list
/// should land there. Ties break on path so the output stays deterministic.
fn render_files(
    input: &Input,
    by_file: &BTreeMap<&Path, Vec<&psearch::SearchMatch>>,
    working_dir: &Path,
    total_matches: usize,
    total_files: usize,
    scan_capped: bool,
) -> String {
    let mut rows: Vec<(usize, std::borrow::Cow<'_, str>)> = by_file
        .iter()
        .map(|(p, ms)| (ms.len(), rel(p, working_dir)))
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let shown = rows.len().min(FILE_LIMIT);
    let about = if scan_capped { "at least " } else { "" };
    let mut out = format!(
        "{about}{total_matches} match(es) for `{}` in {about}{total_files} file(s):\n",
        input.pattern
    );
    for (count, path) in rows.iter().take(shown) {
        out.push_str(&format!("{path} ({count})\n"));
    }
    if rows.len() > shown {
        out.push_str(&format!(
            "\n(Showing the {shown} densest of {} files. Narrow with `path` or `glob`.)\n",
            rows.len()
        ));
    }
    if scan_capped {
        out.push_str(&format!(
            "\n(The search stopped after {SCAN_LIMIT} matches, so these totals are lower bounds. \
             Narrow the pattern.)\n"
        ));
    }
    out.push_str(
        "\nTo see the matching lines, search again with output_mode \"content\" and a `path` \
         from this list.",
    );
    out
}

/// `content` mode: matching lines grouped under each file, with context.
fn render_content(
    input: &Input,
    by_file: &BTreeMap<&Path, Vec<&psearch::SearchMatch>>,
    working_dir: &Path,
    total_matches: usize,
    total_files: usize,
    scan_capped: bool,
) -> String {
    let context = input.context.unwrap_or(CONTEXT_DEFAULT).min(CONTEXT_MAX);
    let limit = input.head_limit.unwrap_or(CONTENT_LIMIT).max(1);

    let mut out = String::new();
    let mut used = 0usize;
    let mut files_shown = 0usize;

    for (path, ms) in by_file.iter() {
        if used >= limit {
            break;
        }
        let take = (limit - used).min(ms.len());
        let shown = &ms[..take];
        used += take;
        files_shown += 1;

        out.push_str(&format!("{}\n", rel(path, working_dir)));
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let lines: Vec<&str> = text.lines().collect();
                out.push_str(&windows(shown, &lines, context));
            }
            // Unreadable at context time (deleted, permissions, non-UTF8): the
            // match line itself is still true and still locates the hit.
            Err(_) => {
                for m in shown {
                    out.push_str(&format!("{}: {}\n", m.line_number, m.line_content));
                }
            }
        }
        out.push('\n');
    }

    if used < total_matches {
        out.push_str(&format!(
            "(Showing {used} of {}{total_matches} match(es) across {files_shown} of \
             {}{total_files} file(s). Narrow with `path` or `glob`, or raise `head_limit`.)\n",
            if scan_capped { "at least " } else { "" },
            if scan_capped { "at least " } else { "" },
        ));
    }
    if scan_capped {
        out.push_str(&format!(
            "(The search stopped after {SCAN_LIMIT} matches, so those totals are lower bounds.)\n"
        ));
    }
    out
}

/// Render one file's matches as context windows, merging overlaps.
///
/// Two matches three lines apart with `context: 2` cover the same ground twice;
/// printed naively the shared lines appear twice and the model pays for them
/// twice. Overlapping windows are merged and non-adjacent ones separated by
/// `--`, which is ripgrep's own convention.
fn windows(ms: &[&psearch::SearchMatch], lines: &[&str], context: usize) -> String {
    let hit: std::collections::BTreeSet<usize> = ms.iter().map(|m| m.line_number).collect();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for &n in &hit {
        let start = n.saturating_sub(context).max(1);
        let end = (n + context).min(lines.len());
        match spans.last_mut() {
            // `+ 1` so windows that merely touch still merge — a one-line gap
            // between them would otherwise print a `--` around a single line.
            Some(last) if start <= last.1 + 1 => last.1 = last.1.max(end),
            _ => spans.push((start, end)),
        }
    }

    let mut out = String::new();
    for (i, (start, end)) in spans.iter().enumerate() {
        if i > 0 {
            out.push_str("--\n");
        }
        for n in *start..=*end {
            let Some(text) = lines.get(n - 1) else { continue };
            let mark = if hit.contains(&n) { ':' } else { '-' };
            out.push_str(&format!("{n}{mark} {text}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        GrepTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    fn repo() -> TmpDir {
        let tmp = TmpDir::new();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        // Three hits here, so this is the densest file.
        std::fs::write(
            tmp.path().join("src/dense.rs"),
            "alpha\nNEEDLE one\nbravo\nNEEDLE two\ncharlie\ndelta\necho\nfox\ngolf\nNEEDLE three\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("src/sparse.rs"), "hotel\nNEEDLE lone\nindia\n").unwrap();
        tmp
    }

    #[tokio::test]
    async fn the_default_mode_returns_paths_not_lines() {
        // The whole point of the default: answer "which files" without paying
        // for every matching line. If source text leaks in, the saving is gone.
        let tmp = repo();
        let r = run(tmp.path(), serde_json::json!({"pattern": "NEEDLE"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("dense.rs"), "{}", r.content);
        assert!(r.content.contains("sparse.rs"), "{}", r.content);
        assert!(
            !r.content.contains("NEEDLE one"),
            "default mode leaked matching lines: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn files_mode_puts_the_densest_file_first() {
        let tmp = repo();
        let r = run(tmp.path(), serde_json::json!({"pattern": "NEEDLE"})).await;
        let dense = r.content.find("dense.rs").unwrap();
        let sparse = r.content.find("sparse.rs").unwrap();
        assert!(dense < sparse, "densest file was not first: {}", r.content);
        assert!(r.content.contains("dense.rs (3)"), "{}", r.content);
    }

    #[tokio::test]
    async fn content_mode_shows_the_lines_around_a_match() {
        // This is what removes the follow-up whole-file Read: the model can see
        // enough around the hit to build an edit without reading the file.
        let tmp = repo();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE lone", "output_mode": "content"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("2: NEEDLE lone"), "{}", r.content);
        assert!(r.content.contains("1- hotel"), "missing before-context: {}", r.content);
        assert!(r.content.contains("3- india"), "missing after-context: {}", r.content);
    }

    #[tokio::test]
    async fn overlapping_context_windows_are_merged() {
        // Matches on lines 2 and 4 with context 2 both cover line 3. Printed
        // naively the model pays for it twice.
        let tmp = repo();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE", "output_mode": "content", "path": "src/dense.rs"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            r.content.matches("bravo").count(),
            1,
            "shared context line printed twice: {}",
            r.content
        );
        // Line 10's window is disjoint from the first, so it is separated.
        assert!(r.content.contains("--"), "disjoint windows not separated: {}", r.content);
    }

    #[tokio::test]
    async fn a_capped_content_result_reports_the_true_total() {
        // The defect this replaces: 250 of 390 returned as though it were all
        // of them. A cap the model cannot see is a wrong answer, not a saving.
        let tmp = repo();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE", "output_mode": "content", "head_limit": 1}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("Showing 1 of 4 match(es)"),
            "capped result did not report the true total: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn an_uncapped_result_claims_no_cap() {
        let tmp = repo();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE lone", "output_mode": "content"}),
        )
        .await;
        assert!(!r.content.contains("Showing"), "spurious cap notice: {}", r.content);
    }

    #[tokio::test]
    async fn no_matches_says_how_to_retry() {
        let tmp = repo();
        let r = run(tmp.path(), serde_json::json!({"pattern": "ABSENT"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("No matches"), "{}", r.content);
        assert!(r.content.contains("case_insensitive"), "{}", r.content);
    }

    #[tokio::test]
    async fn an_unknown_output_mode_is_refused() {
        // Silently falling back to the default would hand back paths to a model
        // that asked for lines, which reads as the tool ignoring its argument.
        let tmp = repo();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE", "output_mode": "files_with_matches"}),
        )
        .await;
        assert!(r.is_error, "unknown mode was accepted: {}", r.content);
        assert!(r.content.contains("output_mode"), "{}", r.content);
    }

    #[tokio::test]
    async fn a_model_that_says_file_path_still_searches_that_directory() {
        // Same alias slip `List` already had to absorb.
        let tmp = repo();
        std::fs::create_dir_all(tmp.path().join("other")).unwrap();
        std::fs::write(tmp.path().join("other/elsewhere.rs"), "NEEDLE far\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE", "file_path": "other"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("elsewhere.rs"), "{}", r.content);
        assert!(
            !r.content.contains("dense.rs"),
            "searched the project root instead of the requested path: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn a_glob_restricts_the_search() {
        let tmp = repo();
        std::fs::write(tmp.path().join("src/notes.md"), "NEEDLE in prose\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"pattern": "NEEDLE", "glob": "*.md"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("notes.md"), "{}", r.content);
        assert!(!r.content.contains("dense.rs"), "{}", r.content);
    }

    #[tokio::test]
    async fn an_invalid_regex_is_reported_with_the_reason() {
        let tmp = repo();
        let r = run(tmp.path(), serde_json::json!({"pattern": "(unclosed"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("Search failed"), "{}", r.content);
    }

    #[tokio::test]
    async fn context_is_clamped_rather_than_trusted() {
        // A model asking for 500 lines of context around every match would undo
        // the whole point; clamp instead of refusing, so the call still works.
        let tmp = repo();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "pattern": "NEEDLE lone", "output_mode": "content", "context": 500
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("2: NEEDLE lone"), "{}", r.content);
    }
}
