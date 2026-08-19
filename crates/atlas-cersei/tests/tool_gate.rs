//! The gate, end to end: permission decision → tool dispatch → filesystem.
//!
//! This is the first test in the repository that exercises the **real
//! permission path**. Every existing tool test used a permit-everything policy,
//! so approval behaviour — the thing users actually complain about — was
//! entirely uncovered.
//!
//! It reproduces the agent runner's dispatch shape faithfully:
//!
//! ```text
//! runner: permission_policy.check(request)   →   Allow / Deny
//!         tool.execute(input, ctx)           →   ToolResult
//! ```
//!
//! and asserts on what the user can observe: whether they were interrupted,
//! what the model was told, and what is on disk afterwards.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use atlas_cersei::tools::{
    atlas_coding_with, ModelCapabilities, ToolPolicy, ToolTier,
};
use cersei::tools::permissions::{PermissionDecision, PermissionPolicy, PermissionRequest};
use cersei::tools::{CostTracker, Extensions, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

// ─── Fixture ────────────────────────────────────────────────────────────────

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("atlas-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::write(p.join("src/lib.rs"), "pub fn a() -> u8 { 1 }\n").unwrap();
        Fixture(p)
    }
    fn path(&self) -> &Path {
        &self.0
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

/// What the user sees and does. Counts prompts so a test can assert on how
/// often they were interrupted, which is the whole point of classification.
struct Gate {
    policy: Arc<ToolPolicy>,
    prompts: AtomicUsize,
    answer: PermissionDecision,
}

impl Gate {
    fn new(policy: Arc<ToolPolicy>, answer: PermissionDecision) -> Arc<Self> {
        Arc::new(Gate {
            policy,
            prompts: AtomicUsize::new(0),
            answer,
        })
    }
    fn prompts(&self) -> usize {
        self.prompts.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl PermissionPolicy for Gate {
    async fn check(&self, request: &PermissionRequest) -> PermissionDecision {
        match self.policy.decide(
            &request.tool_name,
            request.permission_level,
            &request.tool_input,
        ) {
            atlas_cersei::tools::Decision::Allow => PermissionDecision::Allow,
            atlas_cersei::tools::Decision::Deny { reason } => PermissionDecision::Deny(reason),
            atlas_cersei::tools::Decision::Prompt { cache_key, .. } => {
                self.prompts.fetch_add(1, Ordering::SeqCst);
                if matches!(self.answer, PermissionDecision::AllowForSession) {
                    self.policy.remember_approval(cache_key.as_deref());
                }
                self.answer.clone()
            }
        }
    }
}

struct Session {
    policy: Arc<ToolPolicy>,
    gate: Arc<Gate>,
    tools: Vec<Box<dyn Tool>>,
    ctx: ToolContext,
}

impl Session {
    fn new(dir: &Path, answer: PermissionDecision) -> Self {
        Self::with_tier(dir, answer, ToolTier::Structured)
    }

    fn with_tier(dir: &Path, answer: PermissionDecision, tier: ToolTier) -> Self {
        let policy = ToolPolicy::contained(dir);
        let gate = Gate::new(policy.clone(), answer);
        let tools = atlas_coding_with(
            None,
            policy.clone(),
            tier,
            ModelCapabilities { accepts_images: true },
            atlas_cersei::profile::EditMode::Replace,
        );
        let ctx = ToolContext {
            working_dir: policy.root().to_path_buf(),
            session_id: format!("gate-{}", uuid::Uuid::new_v4()),
            permissions: gate.clone(),
            cost_tracker: Arc::new(CostTracker::new()),
            mcp_manager: None,
            extensions: Extensions::default(),
        };
        Session {
            policy,
            gate,
            tools,
            ctx,
        }
    }

    /// One dispatch, exactly as the runner does it: consult the permission
    /// policy, then execute only if it allowed.
    async fn call(&self, name: &str, input: Value) -> ToolResult {
        let Some(tool) = self.tools.iter().find(|t| t.name() == name) else {
            panic!("no tool named {name}");
        };
        let request = PermissionRequest {
            tool_name: name.to_string(),
            tool_input: input.clone(),
            permission_level: tool.permission_level(),
            description: format!("Execute tool '{name}'"),
            id: "1".to_string(),
        };
        match self.ctx.permissions.check(&request).await {
            PermissionDecision::Deny(reason) => {
                ToolResult::error(format!("Permission denied: {reason}"))
            }
            _ => tool.execute(input, &self.ctx).await,
        }
    }
}

// ─── Approvals ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_read_only_command_never_interrupts_the_user() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Deny("no".into()));
    for cmd in ["ls", "git status", "grep -rn pub src", "cat src/lib.rs"] {
        let r = s.call("Bash", json!({ "command": cmd })).await;
        assert!(!r.is_error, "{cmd}: {}", r.content);
    }
    assert_eq!(
        s.gate.prompts(),
        0,
        "exploration must not be death by dialog"
    );
}

#[tokio::test]
async fn allow_for_this_session_actually_remembers() {
    // The defect users hit: "Allow for this session" was advisory, nothing
    // stored it, and the identical command prompted again on the very next call.
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::AllowForSession);
    for _ in 0..3 {
        let r = s.call("Bash", json!({"command": "touch built.marker"})).await;
        assert!(!r.is_error, "{}", r.content);
    }
    assert_eq!(s.gate.prompts(), 1, "approving once must mean once");
}

#[tokio::test]
async fn a_different_command_is_not_covered_by_an_earlier_approval() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::AllowForSession);
    let _ = s.call("Bash", json!({"command": "touch a"})).await;
    let _ = s.call("Bash", json!({"command": "touch b"})).await;
    assert_eq!(s.gate.prompts(), 2, "approval is per command, not blanket");
}

#[tokio::test]
async fn a_destructive_command_asks_every_single_time() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::AllowForSession);
    for _ in 0..3 {
        let _ = s.call("Bash", json!({"command": "rm -rf build"})).await;
    }
    assert_eq!(
        s.gate.prompts(),
        3,
        "a broad approval must not cover a narrow disaster"
    );
}

#[tokio::test]
async fn rejecting_a_command_means_it_does_not_run() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Deny("user said no".into()));
    let r = s
        .call("Bash", json!({"command": "touch should-not-exist"}))
        .await;
    assert!(r.is_error, "{}", r.content);
    assert!(!fx.path().join("should-not-exist").exists());
}

// ─── Containment ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_path_outside_the_workspace_is_refused_before_the_user_is_asked() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let r = s
        .call(
            "Edit",
            json!({"file_path": "../../../etc/hosts", "old_string": "a", "new_string": "b"}),
        )
        .await;
    assert!(r.is_error, "{}", r.content);
    assert!(r.content.contains("outside the workspace"), "{}", r.content);
    assert_eq!(
        s.gate.prompts(),
        0,
        "a prompt that will be denied anyway is a bad prompt"
    );
}

#[tokio::test]
async fn a_symlink_out_of_the_workspace_is_treated_as_outside_it() {
    let fx = Fixture::new();
    let outside = Fixture::new();
    std::fs::write(outside.path().join("secret"), "keys").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), fx.path().join("link")).unwrap();
    #[cfg(not(unix))]
    return;

    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let r = s.call("Read", json!({"file_path": "link/secret"})).await;
    assert!(r.is_error, "{}", r.content);
    assert!(!r.content.contains("keys"), "the file was read anyway");
}

// ─── Read before edit, and staleness ────────────────────────────────────────

#[tokio::test]
async fn an_edit_to_an_unread_file_fails_before_the_write_lands() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let r = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "2"}),
        )
        .await;
    assert!(r.is_error, "{}", r.content);
    // The message and the disk must agree. Previously the guard ran *after*
    // execution, so the model was told the edit was rejected while the write
    // had already landed.
    assert_eq!(fx.read("src/lib.rs"), "pub fn a() -> u8 { 1 }\n");
}

#[tokio::test]
async fn read_then_edit_works() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let r = s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    assert!(!r.is_error, "{}", r.content);
    let r = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "2"}),
        )
        .await;
    assert!(!r.is_error, "{}", r.content);
    assert_eq!(fx.read("src/lib.rs"), "pub fn a() -> u8 { 2 }\n");
}

#[tokio::test]
async fn a_shell_read_satisfies_the_precondition_too() {
    // The shell-first tier has no Read tool. Because the guard sees every call,
    // a provably read-only shell command registers the files it named — so
    // read-before-edit works in both tiers with one mechanism.
    //
    // This test used to call `policy.record_read()` directly and assert on the
    // result, which proved only that the registry works. The mechanism it
    // claimed to cover did not exist.
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);

    let unread = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "3"}),
        )
        .await;
    assert!(unread.is_error, "the precondition must start unsatisfied");

    let cat = s.call("Bash", json!({"command": "cat src/lib.rs"})).await;
    assert!(!cat.is_error, "{}", cat.content);

    let r = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "3"}),
        )
        .await;
    assert!(!r.is_error, "a shell read did not satisfy the precondition: {}", r.content);
    assert_eq!(fx.read("src/lib.rs"), "pub fn a() -> u8 { 3 }\n");
}

#[tokio::test]
async fn a_shell_command_that_writes_does_not_count_as_having_read() {
    // The registration is gated on a provably read-only classification, so a
    // command that could have changed the file cannot also vouch for it.
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let wrote = s
        .call("Bash", json!({"command": "echo x >> src/lib.rs"}))
        .await;
    assert!(!wrote.is_error, "{}", wrote.content);

    let r = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "3"}),
        )
        .await;
    assert!(r.is_error, "a write must not satisfy read-before-edit");
    assert!(r.content.contains("Read"), "{}", r.content);
}

#[tokio::test]
async fn the_users_concurrent_edit_is_never_silently_overwritten() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let r = s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    assert!(!r.is_error, "{}", r.content);

    // The user saves the file in their editor while the agent is thinking.
    std::fs::write(
        fx.path().join("src/lib.rs"),
        "pub fn a() -> u8 { 1 } // my own careful work\n",
    )
    .unwrap();

    let r = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "2"}),
        )
        .await;
    assert!(r.is_error, "{}", r.content);
    assert!(r.content.contains("changed"), "{}", r.content);
    assert_eq!(
        fx.read("src/lib.rs"),
        "pub fn a() -> u8 { 1 } // my own careful work\n",
        "the user's work must survive"
    );
}

// ─── Structured results ─────────────────────────────────────────────────────

#[tokio::test]
async fn an_edit_reports_a_real_before_and_after() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let _ = s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    let r = s
        .call(
            "Edit",
            json!({"file_path": "src/lib.rs", "old_string": "1", "new_string": "2"}),
        )
        .await;
    let meta = r.metadata.expect("structured diff");
    assert_eq!(meta["diff"]["oldText"], "pub fn a() -> u8 { 1 }\n");
    assert_eq!(meta["diff"]["newText"], "pub fn a() -> u8 { 2 }\n");
}

// ─── The tool list itself ───────────────────────────────────────────────────

#[tokio::test]
async fn no_registered_tool_can_reach_outside_the_workspace() {
    // The property the design rests on, asserted over the whole registry rather
    // than over a list someone has to remember to update.
    let fx = Fixture::new();
    let outside = Fixture::new();
    std::fs::write(outside.path().join("secret"), "keys").unwrap();
    let escape = outside
        .path()
        .join("secret")
        .to_string_lossy()
        .into_owned();

    let s = Session::new(fx.path(), PermissionDecision::Allow);
    let mut exercised = 0;
    for tool in &s.tools {
        let schema = tool.input_schema();
        let takes_path = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .is_some_and(|p| p.contains_key("file_path"));
        if !takes_path {
            continue;
        }
        let r = s
            .call(
                tool.name(),
                json!({
                    "file_path": escape,
                    "old_string": "keys",
                    "new_string": "stolen",
                    "content": "stolen",
                }),
            )
            .await;
        assert!(
            r.is_error && r.content.contains("outside the workspace"),
            "{} reached outside the workspace: {}",
            tool.name(),
            r.content
        );
        exercised += 1;
    }
    assert!(exercised >= 4, "only {exercised} path-taking tools exist?");
    assert_eq!(outside.read("secret"), "keys");
}

#[tokio::test]
async fn shell_first_can_still_update_an_existing_file() {
    // The shell-first tier has no Read and no Edit, so the patch tool is its
    // only structured editor. Containing patch paths made the guard's
    // read-before-edit precondition reachable for the first time — and nothing
    // in that tier can satisfy it.
    let fx = Fixture::new();
    let s = Session::with_tier(fx.path(), PermissionDecision::Allow, ToolTier::ShellFirst);
    let cat = s.call("Bash", json!({"command": "cat src/lib.rs"})).await;
    assert!(!cat.is_error, "{}", cat.content);

    let patch = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-pub fn a() -> u8 { 1 }\n+pub fn a() -> u8 { 2 }\n";
    let r = s.call("ApplyPatch", json!({ "patch": patch })).await;
    assert!(!r.is_error, "shell-first lost its only editor: {}", r.content);
    assert!(fx.read("src/lib.rs").contains("{ 2 }"), "{}", fx.read("src/lib.rs"));
}

#[tokio::test]
async fn a_patch_cannot_write_outside_the_workspace() {
    // `no_registered_tool_can_reach_outside_the_workspace` only exercises tools
    // that declare `file_path`. ApplyPatch declares only `patch`, so the one
    // tool whose write target hides inside free text was never covered — and
    // the guard extracted paths using the *Codex* patch dialect
    // (`*** Add File:`) while the registered tool parses unified diff.
    let fx = Fixture::new();
    let name = format!("escape-{}.txt", uuid::Uuid::new_v4());
    let escaped = fx.path().parent().unwrap().join(&name);
    // The patch tool lives in the shell-first tier, where it is the only way to
    // change a file without hand-composing shell redirection.
    let s = Session::with_tier(fx.path(), PermissionDecision::Allow, ToolTier::ShellFirst);

    let patch = format!("--- a/{name}\n+++ b/../{name}\n@@ -0,0 +1 @@\n+pwned\n");
    let r = s.call("ApplyPatch", json!({ "patch": patch })).await;

    let landed = escaped.exists();
    let _ = std::fs::remove_file(&escaped);
    assert!(!landed, "a patch wrote to {} — outside the workspace", escaped.display());
    assert!(r.is_error, "the escape must be refused, got: {}", r.content);
}

#[tokio::test]
async fn the_enforcement_tier_is_reportable_to_the_user() {
    // Silent degradation is the failure this design exists to prevent, so the
    // tier in force has to be something the UI can render.
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);
    assert!(!s.policy.tier().as_str().is_empty());
    assert!(s.policy.tier().describe().len() > 20);
}

// ─── M3: ground truth after edit ────────────────────────────────────────────

/// An edit that breaks the file's syntax gets a parse-probe block appended
/// to its (successful) result; an identical follow-up finding is not
/// repeated while it's still visible; and clean edits stay silent.
#[tokio::test]
async fn a_syntax_breaking_edit_reports_ground_truth_once() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);

    // Read first (read-before-edit), then break the syntax.
    s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    let r = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "pub fn a() -> u8 { 1 }", "new_string": "pub fn a( -> u8 { 1 }"}]
            }),
        )
        .await;
    assert!(!r.is_error, "{}", r.content);
    assert!(
        r.content.contains("[ground truth after edit]"),
        "no probe block: {}",
        r.content
    );
    assert!(r.content.contains("[syntax] src/lib.rs:"), "{}", r.content);

    // A second edit that leaves the same (identical) findings appends
    // nothing new — the block is already visible in fresh messages.
    s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    let r2 = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "{ 1 }", "new_string": "{ 2 }"}]
            }),
        )
        .await;
    assert!(!r2.is_error, "{}", r2.content);
    assert!(
        !r2.content.contains("[ground truth after edit]"),
        "identical findings repeated: {}",
        r2.content
    );

    // Fixing the file goes back to silence.
    let r3 = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "pub fn a( -> u8 { 2 }", "new_string": "pub fn a() -> u8 { 2 }"}]
            }),
        )
        .await;
    assert!(!r3.is_error, "{}", r3.content);
    assert!(
        !r3.content.contains("[ground truth after edit]"),
        "clean edit still reported: {}",
        r3.content
    );
}

/// The project's `.atlas/check.json` command runs after a successful edit
/// and its failure tail is appended; the same failure is not repeated.
#[tokio::test]
async fn the_project_check_command_reports_failures_after_edits() {
    let fx = Fixture::new();
    std::fs::create_dir_all(fx.path().join(".atlas")).unwrap();
    std::fs::write(
        fx.path().join(".atlas/check.json"),
        r#"{"command": "echo the-check-failed >&2; exit 1", "timeout_secs": 5}"#,
    )
    .unwrap();
    let s = Session::new(fx.path(), PermissionDecision::Allow);

    s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    let r = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "{ 1 }", "new_string": "{ 3 }"}]
            }),
        )
        .await;
    assert!(!r.is_error, "{}", r.content);
    assert!(r.content.contains("[check] "), "{}", r.content);
    assert!(r.content.contains("the-check-failed"), "{}", r.content);

    // Identical findings → no repeat.
    let r2 = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "{ 3 }", "new_string": "{ 4 }"}]
            }),
        )
        .await;
    assert!(!r2.content.contains("the-check-failed"), "{}", r2.content);

    // After the ledger empties (compaction/cancel path), the still-failing
    // check is reported again — the suppression only holds while the block
    // is visible.
    s.policy.forget_served();
    let r3 = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "{ 4 }", "new_string": "{ 5 }"}]
            }),
        )
        .await;
    assert!(r3.content.contains("the-check-failed"), "{}", r3.content);
}

/// A read-class tool never triggers the probe, and a failed edit doesn't
/// either — ground truth is only appended to successful writes.
#[tokio::test]
async fn reads_and_failed_edits_get_no_ground_truth_block() {
    let fx = Fixture::new();
    let s = Session::new(fx.path(), PermissionDecision::Allow);

    let r = s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    assert!(!r.content.contains("[ground truth after edit]"));

    // A failed edit (old_string not present) gets no probe — the file
    // didn't change, so there is no new ground truth to report.
    let r = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "edits": [{"old_string": "no such text anywhere", "new_string": "pub fn b("}]
            }),
        )
        .await;
    assert!(r.is_error, "{}", r.content);
    assert!(!r.content.contains("[ground truth after edit]"));
}

// ─── M6: hashline edit mode ─────────────────────────────────────────────────

fn hashline_session(dir: &Path) -> Session {
    let policy = ToolPolicy::contained(dir);
    let gate = Gate::new(policy.clone(), PermissionDecision::Allow);
    let tools = atlas_coding_with(
        None,
        policy.clone(),
        ToolTier::Structured,
        ModelCapabilities { accepts_images: true },
        atlas_cersei::profile::EditMode::Hashline,
    );
    let ctx = ToolContext {
        working_dir: policy.root().to_path_buf(),
        session_id: format!("gate-{}", uuid::Uuid::new_v4()),
        permissions: gate.clone(),
        cost_tracker: Arc::new(CostTracker::new()),
        mcp_manager: None,
        extensions: Extensions::default(),
    };
    Session { policy, gate, tools, ctx }
}

fn tag_from(read_result: &str) -> String {
    let header = read_result.lines().next().unwrap_or_default();
    header
        .rsplit('#')
        .next()
        .unwrap_or_default()
        .trim_end_matches(']')
        .to_string()
}

/// The full hashline loop: a tagged read, a line-addressed edit validated by
/// the tag, and a result that echoes the fresh tag so the next edit can
/// chain without a re-read.
#[tokio::test]
async fn hashline_reads_tag_and_line_edits_apply_and_chain() {
    let fx = Fixture::new();
    std::fs::write(
        fx.path().join("src/lib.rs"),
        "pub fn a() -> u8 { 1 }\npub fn b() -> u8 { 2 }\npub fn c() -> u8 { 3 }\n",
    )
    .unwrap();
    let s = hashline_session(fx.path());

    let r = s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    assert!(!r.is_error, "{}", r.content);
    assert!(r.content.starts_with('['), "tag header missing: {}", r.content);
    assert!(r.content.contains("#"), "{}", r.content);
    let tag = tag_from(&r.content);
    assert_eq!(tag.len(), 4, "{}", r.content);

    let r = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "tag": tag,
                "edits": [{"op": "replace", "start_line": 2, "end_line": 2,
                           "text": "pub fn b() -> u8 { 20 }"}]
            }),
        )
        .await;
    assert!(!r.is_error, "{}", r.content);
    assert!(fx.read("src/lib.rs").contains("{ 20 }"));
    assert!(r.content.contains('#'), "fresh tag echoed: {}", r.content);

    // Chain a second edit straight from the echoed tag — no re-read.
    let fresh = tag_from(r.content.lines().next().unwrap());
    let r2 = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "tag": fresh,
                "edits": [{"op": "delete", "start_line": 3, "end_line": 3}]
            }),
        )
        .await;
    assert!(!r2.is_error, "{}", r2.content);
    assert!(!fx.read("src/lib.rs").contains("fn c"), "{}", fx.read("src/lib.rs"));
}

/// A misquoted tag fails closed and echoes the current lines + tag;
/// retrying with what the rejection showed succeeds. (A file changed on
/// disk is caught earlier, by the mtime freshness guard — the tag check is
/// the layer for a model that misquotes or hallucinates the tag.)
#[tokio::test]
async fn a_stale_hashline_tag_fails_closed_with_recovery_context() {
    let fx = Fixture::new();
    let s = hashline_session(fx.path());
    let r = s.call("Read", json!({"file_path": "src/lib.rs"})).await;
    let real = tag_from(&r.content);
    let wrong = if real == "0000" { "FFFF" } else { "0000" };

    let r = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "tag": wrong,
                "edits": [{"op": "replace", "start_line": 1, "end_line": 1, "text": "x"}]
            }),
        )
        .await;
    assert!(r.is_error, "{}", r.content);
    assert!(r.content.contains("Stale tag"), "{}", r.content);
    assert!(r.content.contains("{ 1 }"), "current content inlined: {}", r.content);

    // Retry with the tag the rejection named.
    // The fresh tag rides in the `[path#TAG]` form, after the quoted one.
    let fresh: String = r
        .content
        .split("#")
        .last()
        .unwrap()
        .chars()
        .take(4)
        .collect();
    assert_eq!(fresh, real, "the rejection names the real tag");
    let r2 = s
        .call(
            "Edit",
            json!({
                "file_path": "src/lib.rs",
                "tag": fresh,
                "edits": [{"op": "replace", "start_line": 1, "end_line": 1,
                           "text": "pub fn a() -> u8 { 10 }"}]
            }),
        )
        .await;
    assert!(!r2.is_error, "{}", r2.content);
    assert!(fx.read("src/lib.rs").contains("{ 10 }"));
}

/// Lines never displayed cannot be edited; the rejection inlines them so a
/// straight retry succeeds.
#[tokio::test]
async fn hashline_rejects_undisplayed_lines_then_a_retry_succeeds() {
    let fx = Fixture::new();
    std::fs::write(
        fx.path().join("src/lib.rs"),
        (1..=40).map(|i| format!("// line {i}\n")).collect::<String>(),
    )
    .unwrap();
    let s = hashline_session(fx.path());

    // Display only lines 1-5.
    let r = s
        .call("Read", json!({"file_path": "src/lib.rs", "offset": 1, "limit": 5}))
        .await;
    let tag = tag_from(&r.content);

    let edit = json!({
        "file_path": "src/lib.rs",
        "tag": tag,
        "edits": [{"op": "replace", "start_line": 30, "end_line": 30, "text": "// changed"}]
    });
    let r = s.call("Edit", edit.clone()).await;
    assert!(r.is_error, "{}", r.content);
    assert!(r.content.contains("never displayed"), "{}", r.content);
    assert!(r.content.contains("line 30"), "missing lines inlined: {}", r.content);

    let r2 = s.call("Edit", edit).await;
    assert!(!r2.is_error, "the rejection made the lines visible: {}", r2.content);
    assert!(fx.read("src/lib.rs").contains("// changed"));
}
