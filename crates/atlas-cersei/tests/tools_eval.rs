//! Offline, deterministic eval for the Atlas-owned coding tools (Step 9 of
//! `plans/atlas-cersei-tools-from-scratch.md`). No API keys, no network — it
//! scripts a realistic read → edit(drifted) → grep → bash task over a fixture
//! repo and scores the new tools. This is the standing regression gate that
//! proves the drift-recovery win rather than asserting it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_cersei::tools::{Guarded, ToolPolicy};
use atlas_cersei::tools::{
    bash::BashTool, edit::EditTool, grep::GrepTool, list::ListTool, read::ReadTool,
};
use cersei::tools::file_write::FileWriteTool; // SDK-native Write (handed off, guarded)
use cersei::tools::permissions::AllowAll;
use cersei::tools::{CostTracker, Extensions, Tool, ToolContext, ToolResult};
use serde_json::json;

/// Self-cleaning temp dir (no `tempfile` dev-dep).
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("atlas-cersei-eval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(p.join("src")).unwrap();
        // A small, realistic source file the task will read + edit.
        std::fs::write(
            p.join("src/lib.rs"),
            "pub fn greet(name: &str) -> String {\n    let prefix = \"Hello\";\n    format!(\"{prefix}, {name}!\")\n}\n",
        )
        .unwrap();
        std::fs::write(p.join("README.md"), "# Fixture\n").unwrap();
        Fixture(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn ctx(dir: &Path) -> ToolContext {
    ToolContext {
        working_dir: dir.to_path_buf(),
        session_id: "eval".into(),
        permissions: Arc::new(AllowAll),
        cost_tracker: Arc::new(CostTracker::new()),
        mcp_manager: None,
        extensions: Extensions::default(),
    }
}

async fn run(tool: &dyn Tool, dir: &Path, args: serde_json::Value) -> ToolResult {
    tool.execute(args, &ctx(dir)).await
}

#[tokio::test]
async fn scripted_read_edit_grep_bash_task() {
    let fx = Fixture::new();
    let dir = fx.path();
    let mut score = 0;
    let total = 5;

    // 1. READ the file (grounded, line-numbered).
    let r = run(&ReadTool::default(), dir, json!({"file_path": "src/lib.rs"})).await;
    if !r.is_error && r.content.contains("1: pub fn greet") {
        score += 1;
    } else {
        eprintln!("READ failed: {}", r.content);
    }

    // 2. EDIT with DRIFTED indentation — the model sent the line with the wrong
    //    indent (2 spaces instead of 4). The SDK's exact-match Edit would reject
    //    this; the replacer's LineTrimmed strategy must rescue it.
    let r = run(
        &EditTool,
        dir,
        json!({
            "file_path": "src/lib.rs",
            "old_string": "  let prefix = \"Hello\";",
            "new_string": "    let prefix = \"Hey\";"
        }),
    )
    .await;
    let edited = std::fs::read_to_string(dir.join("src/lib.rs")).unwrap();
    if !r.is_error && edited.contains("let prefix = \"Hey\";") && edited.contains("    let prefix") {
        score += 1;
    } else {
        eprintln!("EDIT(drifted) failed: {} | file:\n{}", r.content, edited);
    }

    // 3. GREP for the changed symbol, over the two calls the tool documents:
    //    the cheap default names the file, then content mode shows the line.
    //    Scored as one step because neither half alone lets the model edit —
    //    the first carries no code, the second needs a `path` to stay cheap.
    let found = run(&GrepTool, dir, json!({"pattern": "Hey", "glob": "*.rs"})).await;
    let lines = run(
        &GrepTool,
        dir,
        json!({"pattern": "Hey", "output_mode": "content", "path": "src/lib.rs"}),
    )
    .await;
    if !found.is_error
        && found.content.contains("lib.rs")
        && !lines.is_error
        && lines.content.contains("Hey")
    {
        score += 1;
    } else {
        eprintln!("GREP failed: {} | {}", found.content, lines.content);
    }

    // 4. BASH run in the project root (a real command, deterministic output).
    let r = run(&BashTool::default(), dir, json!({"command": "echo built-ok"})).await;
    if !r.is_error && r.content.contains("built-ok") {
        score += 1;
    } else {
        eprintln!("BASH failed: {}", r.content);
    }

    // 5. WRITE a new file, then LIST must surface it (gitignore-aware rg).
    let write = Guarded::wrap(Box::new(FileWriteTool), ToolPolicy::contained(dir));
    let _ = run(&*write, dir, json!({"file_path": "src/util.rs", "content": "pub fn id() {}\n"})).await;
    let r = run(&ListTool, dir, json!({})).await;
    if !r.is_error && r.content.contains("util.rs") && r.content.contains("lib.rs") {
        score += 1;
    } else {
        eprintln!("WRITE+LIST failed: {}", r.content);
    }

    eprintln!("tools_eval score: {score}/{total}");
    assert_eq!(score, total, "scripted tool task did not fully pass");

    // Final-state checks: the edit landed and the new file exists.
    assert!(edited.contains("Hey"));
    assert!(dir.join("src/util.rs").exists());
}

/// Gated BYOK matrix harness — runs real per-model comparisons of the Atlas
/// tools vs the SDK baseline. Skipped by default; only meaningful with provider
/// keys. Mirrors the `ATLAS_MINILM_DIR`-style opt-in.
///
/// TODO(step9): drive a `cersei::Agent` per BYOK model from
/// `~/Library/Application Support/dev.atlas.ide/byok-keys.json` (path via env
/// `ATLAS_BYOK_KEYS`) on the scripted task above and compare drift-recovery rate
/// against `cersei::tools::coding()`.
#[tokio::test]
#[ignore = "requires ATLAS_BYOK_KEYS (provider keys); offline gate is scripted_read_edit_grep_bash_task"]
async fn byok_matrix_stub() {
    if std::env::var("ATLAS_BYOK_KEYS").is_err() {
        eprintln!("ATLAS_BYOK_KEYS unset — skipping BYOK matrix.");
        return;
    }
    // Intentionally unimplemented until the gated matrix lands.
}
