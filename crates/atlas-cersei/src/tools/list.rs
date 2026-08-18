//! `List` — gitignore-aware recursive file listing, in-process via the `ignore`
//! crate (ripgrep's own walker). No external `rg`/`grep` binary required.

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use ignore::WalkBuilder;
use serde::Deserialize;
use serde_json::Value;

use super::{abs_path, coerce, errors};

const LIMIT: usize = 400;

const DESCRIPTION: &str = "Lists the files under a directory (recursively), in-process, \
honoring .gitignore and skipping hidden files. Prefer this over shell tools (ls / find) to \
see what files exist — no external tools are required.\n\n\
- path: optional directory (defaults to the project root).";

#[derive(Deserialize)]
struct Input {
    path: Option<String>,
}

pub struct ListTool;

#[async_trait]
impl Tool for ListTool {
    fn name(&self) -> &str {
        "List"
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
                "path": { "type": "string", "description": "Directory to list (default: project root)" }
            }
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "List",
                    &e.to_string(),
                    r#"{"path": "src"}"#,
                ))
            }
        };

        let base = match &input.path {
            Some(p) => abs_path(&ctx.working_dir, p),
            None => ctx.working_dir.clone(),
        };
        let display = base.to_string_lossy().into_owned();
        if !base.exists() {
            return ToolResult::error(format!("Directory not found: {display}"));
        }

        // Gitignore-aware recursive walk on a blocking thread (the `ignore`
        // walker is synchronous). Mirrors `rg --files`: respects .gitignore /
        // .ignore, skips hidden files + the .git dir, and yields files only.
        // Paths are relative to the listed directory for compact output.
        let base_for_walk = base.clone();
        let walked = tokio::task::spawn_blocking(move || {
            let mut out: Vec<String> = Vec::new();
            for entry in WalkBuilder::new(&base_for_walk).hidden(true).build().flatten() {
                if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    let rel = entry
                        .path()
                        .strip_prefix(&base_for_walk)
                        .unwrap_or_else(|_| entry.path())
                        .to_string_lossy()
                        .into_owned();
                    out.push(rel);
                }
            }
            out
        })
        .await;
        // A panicked walk used to become `Vec::new()` and report "No files
        // found" — indistinguishable from an empty directory, and wrong in a
        // way that sends the model looking somewhere else (tool spec D11).
        let mut files = match walked {
            Ok(files) => files,
            Err(e) => {
                return ToolResult::error(format!(
                    "Failed to list {display}: the directory walk did not complete ({e}). This is \
                     not the same as an empty directory — retry, or narrow to a subdirectory."
                ))
            }
        };

        files.sort_unstable();
        if files.is_empty() {
            return ToolResult::success("No files found.".to_string());
        }
        let total = files.len();
        let truncated = total > LIMIT;
        files.truncate(LIMIT);
        let mut body = format!("{total} file(s):\n{}", files.join("\n"));
        if truncated {
            body.push_str(&format!("\n\n(Showing first {LIMIT}. Narrow with a subdirectory path.)"));
        }
        ToolResult::success(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        ListTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn lists_files() {
        let tmp = TmpDir::new();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/a.rs"), "").unwrap();
        std::fs::write(tmp.path().join("README.md"), "").unwrap();
        let r = run(tmp.path(), serde_json::json!({})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("a.rs"));
        assert!(r.content.contains("README.md"));
    }

    #[tokio::test]
    async fn empty_dir() {
        let tmp = TmpDir::new();
        std::fs::create_dir_all(tmp.path().join("empty")).unwrap();
        let r = run(tmp.path(), serde_json::json!({"path": "empty"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("No files found"));
    }
}
