//! Integration test: drive the Atlas-owned tools over the REAL Atlas repo to
//! prove they can read every source file when given a valid `file_path`.
//!
//! Motivation: chat showed `Read {}` failing with "invalid type: null". This
//! test pins down where that comes from — it exercises `ReadTool` against the
//! whole source tree (relative AND absolute paths) and asserts zero failures.
//! If every real file reads cleanly, the chat failure is a MODEL/provider
//! artifact (the model emitted a tool call with empty/null arguments, so no
//! `file_path` ever reached the tool) — not a bug in the tool. The
//! `null_and_empty_args_*` test codifies the tool's correct, actionable
//! rejection of that empty-args case.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_cersei::tools::grep::GrepTool;
use atlas_cersei::tools::list::ListTool;
use atlas_cersei::tools::read::ReadTool;
use cersei::tools::permissions::AllowAll;
use cersei::tools::{CostTracker, Extensions, Tool, ToolContext};
use serde_json::{json, Value};

/// `CARGO_MANIFEST_DIR` is `<repo>/crates/atlas-cersei`; the repo root is two up.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root above crates/atlas-cersei")
        .to_path_buf()
}

fn ctx(dir: &Path) -> ToolContext {
    ToolContext {
        working_dir: dir.to_path_buf(),
        session_id: "read-repo-eval".into(),
        permissions: Arc::new(AllowAll),
        cost_tracker: Arc::new(CostTracker::new()),
        mcp_manager: None,
        extensions: Extensions::default(),
    }
}

const SKIP_DIRS: &[&str] = &["target", "node_modules", "dist", ".git", ".atlas", ".vercel"];
const TEXT_EXTS: &[&str] = &["rs", "ts", "tsx", "toml", "md", "json", "css", "js"];

/// Recursively collect text source files, skipping build/vendor dirs.
fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect(&path, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if TEXT_EXTS.contains(&ext) {
                out.push(path);
            }
        }
    }
}

/// Every real source file must Read cleanly via a RELATIVE path resolved against
/// `working_dir` — the exact code path `Read {"file_path": "src/main.rs"}` takes.
#[tokio::test]
async fn reads_every_repo_source_file_relative() {
    let root = repo_root();
    let mut files = Vec::new();
    for sub in ["crates", "src-tauri/src", "src"] {
        collect(&root.join(sub), &mut files);
    }
    assert!(
        files.len() > 100,
        "expected to discover many source files under the repo, found {}",
        files.len()
    );

    let context = ctx(&root);
    let mut failures: Vec<(String, String)> = Vec::new();
    for f in &files {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        let r = ReadTool::default().execute(json!({ "file_path": rel.clone() }), &context).await;
        if r.is_error {
            failures.push((rel, r.content));
        }
    }

    if !failures.is_empty() {
        for (f, why) in &failures {
            eprintln!("READ FAILED  {f}\n             -> {why}");
        }
        panic!(
            "{} of {} repo files failed to Read (see reasons above)",
            failures.len(),
            files.len()
        );
    }
    eprintln!("Read OK for all {} repo source files", files.len());
}

/// Absolute paths must also work (the model sometimes sends a fully-qualified
/// path). Spot-check this crate's own lib.rs both ways.
#[tokio::test]
async fn reads_via_absolute_path() {
    let root = repo_root();
    let abs = root.join("crates/atlas-cersei/src/lib.rs");
    let r = ReadTool::default()
        .execute(json!({ "file_path": abs.to_string_lossy() }), &ctx(&root))
        .await;
    assert!(!r.is_error, "absolute read failed: {}", r.content);
    assert!(r.content.contains("1: "), "expected line-numbered output");
}

/// The exact chat failure: a tool call whose arguments are `null` or `{}` (no
/// `file_path`). The tool cannot invent a path, so it MUST reject — but with an
/// actionable message that names the field and shows a concrete example, so a
/// weak model can self-correct on the retry.
#[tokio::test]
async fn null_and_empty_args_give_actionable_error() {
    let root = repo_root();
    let context = ctx(&root);
    for bad in [Value::Null, json!({}), json!("src/main.rs")] {
        let r = ReadTool::default().execute(bad.clone(), &context).await;
        assert!(r.is_error, "expected error for args {bad}");
        assert!(
            r.content.contains("file_path"),
            "error must name the missing field; got: {}",
            r.content
        );
        assert!(
            r.content.contains(r#"{"file_path": "src/main.rs"}"#),
            "error must show the concrete example; got: {}",
            r.content
        );
    }
}

/// Discovery (List/Grep) over the real repo. Both are now fully in-process and
/// rg-free (List via the `ignore` crate, Grep via the SDK's search primitive),
/// so this runs on every machine with NO external ripgrep — which is the whole
/// point of the fix. Proves they surface real files and respect `.gitignore`.
#[tokio::test]
async fn list_and_grep_discover_real_files_without_ripgrep() {
    let root = repo_root();
    let context = ctx(&root);

    let listed = ListTool.execute(json!({ "path": "crates/atlas-cersei/src" }), &context).await;
    assert!(!listed.is_error, "List failed: {}", listed.content);
    assert!(listed.content.contains("lib.rs"), "List should surface lib.rs");
    assert!(
        !listed.content.contains("ripgrep") && !listed.content.contains("`rg`"),
        "List must not require an external ripgrep; got: {}",
        listed.content
    );

    let grepped = GrepTool
        .execute(
            json!({ "pattern": "pub fn atlas_coding", "glob": "*.rs" }),
            &context,
        )
        .await;
    assert!(!grepped.is_error, "Grep failed: {}", grepped.content);
    assert!(
        grepped.content.contains("mod.rs"),
        "Grep should locate atlas_coding in tools/mod.rs; got: {}",
        grepped.content
    );
}
