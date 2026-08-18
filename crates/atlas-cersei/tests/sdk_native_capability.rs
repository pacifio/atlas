//! Capability gate + retirement tripwire for the cersei↔Atlas tool handoff.
//!
//! Policy: hand every tool off to the cersei SDK once it's "capable enough"; keep
//! an Atlas reimplementation ONLY while it's provably more capable. This test is
//! the evidence AND the tripwire: it pins the exact gaps that justify each kept
//! Atlas tool, and FAILS when a future SDK bump closes one — telling us to delete
//! that Atlas tool (as we already did for Grep/Glob/Write).
//!
//! Decisions encoded here (cersei 0.2.5):
//!   • Write  → HANDED OFF (SDK FileWriteTool: cwd-wrappable, creates parent dirs).
//!   • Edit   → KEPT: SDK's 5-strategy replacer misses EscapeNormalized +
//!              TrimmedBoundary (real weak-model drift). Tripwire below.
//!   • Bash   → KEPT: SDK flags nonzero-with-output as an error. Tripwire below.
//!   • Read   → KEPT: SDK Read returns raw content (no line numbers / did-you-mean).
//!   • List   → KEPT: no SDK equivalent.
//!
//! Run:  cargo test -p atlas-cersei --test sdk_native_capability -- --nocapture

use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_cersei::tools::{Guarded, ToolPolicy};
use cersei::tools::bash::BashTool;
use cersei::tools::file_edit::FileEditTool;
use cersei::tools::file_read::FileReadTool;
use cersei::tools::file_write::FileWriteTool;
use cersei::tools::permissions::AllowAll;
use cersei::tools::{CostTracker, Extensions, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("atlas-sdkcap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(p.join("src")).unwrap();
        Fixture(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn write(&self, rel: &str, body: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.0.join(rel)).unwrap()
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
        session_id: "sdkcap".into(),
        permissions: Arc::new(AllowAll),
        cost_tracker: Arc::new(CostTracker::new()),
        mcp_manager: None,
        extensions: Extensions::default(),
    }
}

async fn run(tool: &dyn Tool, dir: &Path, args: Value) -> ToolResult {
    tool.execute(args, &ctx(dir)).await
}

/// SDK file tools take a bare `file_path` and ignore `working_dir`. The guard
/// rewrites every path argument to its canonical absolute form before the tool
/// is entered, which is what the registry does for real — and is strictly
/// stronger than the `CwdTool` decorator this replaced, because it applies to
/// every tool rather than the three that were remembered.
///
/// One policy per fixture, not one per tool: the read registry is what makes
/// read-before-edit work, and it is session-scoped. A fresh policy per call
/// would mean every edit looked like the first thing that ever touched the file.
fn read_tool(policy: &Arc<ToolPolicy>) -> Box<dyn Tool> {
    Guarded::wrap(Box::new(FileReadTool), policy.clone())
}
fn write_tool(policy: &Arc<ToolPolicy>) -> Box<dyn Tool> {
    Guarded::wrap(Box::new(FileWriteTool), policy.clone())
}
fn edit_tool(policy: &Arc<ToolPolicy>) -> Box<dyn Tool> {
    Guarded::wrap(Box::new(FileEditTool), policy.clone())
}

// ─────────────────────────── Baseline (must pass) ───────────────────────────

#[tokio::test]
async fn sdk_cwd_read_write_edit_bash_baseline() {
    let fx = Fixture::new();
    let dir = fx.path();
    let policy = ToolPolicy::contained(dir);

    // WRITE (cwd-relative path, absolutised by the guard).
    let r = run(&*write_tool(&policy), dir, json!({"file_path": "src/lib.rs", "content": "pub fn a() -> u8 { 1 }\n"})).await;
    assert!(!r.is_error, "SDK Write (wrapped) cwd-relative failed: {}", r.content);
    assert_eq!(fx.read("src/lib.rs"), "pub fn a() -> u8 { 1 }\n");

    // READ (cwd-relative).
    let r = run(&*read_tool(&policy), dir, json!({"file_path": "src/lib.rs"})).await;
    assert!(!r.is_error, "SDK Read (wrapped) cwd-relative failed: {}", r.content);
    assert!(r.content.contains("pub fn a()"), "SDK Read content missing: {}", r.content);
    eprintln!(
        "[Read] line-numbered output? {}",
        r.content.contains("1: ") || r.content.contains("1:\t")
    );

    // EDIT exact (cwd-relative). The Read above is what satisfies the guard's
    // read-before-edit precondition — as it does in a real turn.
    let r = run(&*edit_tool(&policy), dir, json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "2"})).await;
    assert!(!r.is_error, "SDK Edit (wrapped) exact failed: {}", r.content);
    assert!(fx.read("src/lib.rs").contains("{ 2 }"), "edit not applied: {}", fx.read("src/lib.rs"));

    // BASH cwd + echo.
    let r = run(&BashTool, dir, json!({"command": "echo hello && ls"})).await;
    assert!(!r.is_error, "SDK Bash failed: {}", r.content);
    assert!(r.content.contains("hello"), "bash echo missing: {}", r.content);
    assert!(r.content.contains("src"), "bash did not run in working_dir: {}", r.content);
}

// ───────────── Edit drift ladder — the reason Atlas wrote its own ────────────

/// Each case: seed a file, run SDK Edit with a DRIFTED old_string, report whether
/// the SDK's 5-strategy replacer rescued it. The last 3 are the cases Atlas added
/// strategies 6–9 for.
#[tokio::test]
async fn sdk_edit_drift_ladder_capability_matrix() {
    struct Case {
        name: &'static str,
        seed: &'static str,
        old: &'static str,
        new: &'static str,
        must_contain: &'static str,
        atlas_strategy: &'static str,
    }
    let cases = vec![
        Case {
            name: "exact",
            seed: "let x = 1;\n",
            old: "let x = 1;",
            new: "let x = 9;",
            must_contain: "let x = 9;",
            atlas_strategy: "1 Identity (SDK has)",
        },
        Case {
            name: "line-trimmed (indent drift)",
            seed: "fn f() {\n    let prefix = \"Hello\";\n}\n",
            old: "  let prefix = \"Hello\";", // 2 spaces, file has 4
            new: "    let prefix = \"Hey\";",
            must_contain: "Hey",
            atlas_strategy: "2 LineTrimmed (SDK has)",
        },
        Case {
            name: "indentation-flexible (block indent)",
            seed: "        let a = 1;\n        let b = 2;\n",
            old: "let a = 1;\nlet b = 2;", // no indent at all
            new: "let a = 1;\nlet b = 3;",
            must_contain: "let b = 3;",
            atlas_strategy: "5 IndentationFlexible (SDK has)",
        },
        Case {
            name: "whitespace-normalized (internal spacing)",
            seed: "let   y   =   2;\n",
            old: "let y = 2;", // single spaces, file has runs
            new: "let y = 42;",
            must_contain: "let y = 42;",
            atlas_strategy: "4 WhitespaceNormalized (SDK has)",
        },
        Case {
            name: "ESCAPE-normalized (literal \\n in old_string)",
            seed: "fn g() {\n    do_thing();\n}\n",
            old: "fn g() {\\n    do_thing();\\n}", // model emitted literal backslash-n
            new: "fn g() {\n    do_other();\n}",
            must_contain: "do_other",
            atlas_strategy: "6 EscapeNormalized (ATLAS-ONLY)",
        },
        Case {
            name: "trimmed-boundary (extra surrounding blank lines)",
            seed: "alpha\nbeta\ngamma\n",
            old: "\n\nbeta\n\n", // model wrapped old_string in blank lines
            new: "BETA",
            must_contain: "BETA",
            atlas_strategy: "7 TrimmedBoundary (ATLAS-ONLY)",
        },
    ];

    let fx = Fixture::new();
    let dir = fx.path();
    let policy = ToolPolicy::contained(dir);
    let mut sdk_passes = 0;
    let mut atlas_only_failed_on_sdk = 0;
    eprintln!("\n=== SDK Edit (cersei 0.2.5, 5-strategy) drift capability ===");
    for (i, c) in cases.iter().enumerate() {
        let file = format!("c{i}.txt");
        fx.write(&file, c.seed);
        // Register the read, so what this matrix measures is the SDK
        // replacer's drift tolerance and not the guard's precondition.
        let _ = run(&*read_tool(&policy), dir, json!({"file_path": file.clone()})).await;
        let r = run(
            &*edit_tool(&policy),
            dir,
            json!({"file_path": file, "old_string": c.old, "new_string": c.new}),
        )
        .await;
        let after = fx.read(&file);
        let ok = !r.is_error && after.contains(c.must_contain);
        if ok {
            sdk_passes += 1;
        } else if c.atlas_strategy.contains("ATLAS-ONLY") {
            atlas_only_failed_on_sdk += 1;
        }
        eprintln!(
            "  [{}] {:32} via {:38} -> {}",
            if ok { "PASS" } else { "FAIL" },
            c.name,
            c.atlas_strategy,
            if ok { "" } else { r.content.lines().next().unwrap_or("").trim() }
        );
    }
    eprintln!(
        "SDK passed {}/{} drift cases. ATLAS-ONLY strategies the SDK missed: {}\n",
        sdk_passes,
        cases.len(),
        atlas_only_failed_on_sdk
    );

    // The SDK MUST handle the 4 strategies it advertises (exact + 3 fuzzy here).
    assert!(sdk_passes >= 4, "SDK Edit regressed on its own advertised strategies");

    // RETIREMENT TRIPWIRE: today the SDK misses BOTH Atlas-only strategies, which
    // is why we keep Atlas Edit + replace.rs. If a future cersei bump makes the
    // SDK pass these, this assert fails — that's the signal to DELETE Atlas Edit
    // and hand Edit off to the SDK (like we did for Grep/Glob/Write).
    assert_eq!(
        atlas_only_failed_on_sdk, 2,
        "cersei's Edit now handles {} of the 2 Atlas-only strategies — re-evaluate \
         deleting crates/atlas-cersei/src/tools/edit.rs + replace.rs and using the SDK Edit",
        2 - atlas_only_failed_on_sdk
    );
}

// ───────────── Bash nonzero-with-output (the Atlas behavior delta) ───────────

#[tokio::test]
async fn sdk_bash_nonzero_with_output_behavior() {
    let fx = Fixture::new();
    let dir = fx.path();
    // grep no-match / find-unreadable / diff all exit nonzero but are normal.
    let r = run(&BashTool, dir, json!({"command": "echo found; exit 1"})).await;
    eprintln!(
        "\n=== SDK Bash nonzero-with-output ===\n  is_error={} (Atlas makes this a NON-error)\n  content head: {:?}\n",
        r.is_error,
        r.content.lines().next().unwrap_or("")
    );
    // RETIREMENT TRIPWIRE: today the SDK flags nonzero-with-output as an error
    // (grep no-match / diff / find-unreadable look like failures), which is why
    // we keep Atlas Bash. If a future cersei bump returns it as a non-error, this
    // fails — signal to delete crates/atlas-cersei/src/tools/bash.rs.
    assert!(
        r.is_error,
        "cersei's Bash no longer flags nonzero-with-output as an error — re-evaluate \
         deleting crates/atlas-cersei/src/tools/bash.rs and using the SDK Bash"
    );
}
