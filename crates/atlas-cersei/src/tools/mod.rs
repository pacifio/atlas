//! Atlas-owned coding tools — a from-scratch reimplementation of the basic
//! file/shell tools, modeled on opencode (MIT), so they work reliably across
//! every BYOK model. See `plans/atlas-cersei-tools-from-scratch.md`,
//! `plans/atlas-tool-layer-spec.md`, and `ATTRIBUTION.md`.
//!
//! [`atlas_coding_with`] is the single seam: an explicit, hand-built tool
//! vector used for both the main turn and delegate sub-agents. Building it by
//! hand (rather than filtering `cersei::tools::coding()`) keeps every tool swap
//! a one-line change and avoids name-filter fragility.
//!
//! **Every tool the registry emits is wrapped in [`guard::Guarded`]** — Atlas's
//! own, the SDK's, and MCP-discovered ones alike. That wrapper is where
//! containment, argument coercion, and the read-before-edit precondition live,
//! so a tool added later inherits all of it without knowing the guard exists.
//! Nothing here should ever hand back an unwrapped tool.

pub mod atomic;
pub mod bash;
pub mod classify;
pub mod coerce;
pub mod edit;
pub mod errors;
pub mod guard;
pub mod image;
pub mod list;
pub mod policy;
pub mod read;
pub mod replace;
pub mod sandbox;
pub mod skill;
pub mod terminal;
pub mod tiers;
pub mod truncate;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cersei::tools::Tool;

pub use guard::{guard_all, Guarded};
pub use policy::{Decision, EnforcementTier, Freshness, ToolPolicy};
pub use tiers::{ModelCapabilities, ToolTier};

/// Absolutise a (possibly relative) path against the session working directory.
///
/// This is *not* containment — [`ToolPolicy::contain`] is, and the guard has
/// already applied it and rewritten the argument before any tool runs. This
/// exists so a tool called directly (a test, a benchmark) still resolves
/// relative paths sensibly. It deliberately does not reject anything: a tool
/// that decided for itself what was in bounds is how the containment hole got
/// there in the first place.
pub(crate) fn abs_path(working_dir: &Path, file_path: &str) -> PathBuf {
    let p = Path::new(file_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        working_dir.join(p)
    }
}

/// The coding toolset handed to the Cersei agent (main turn + delegate factory).
///
/// Atlas-owned `Read / Edit / List / Bash` are kept because each is PROVEN more
/// capable than the SDK equivalent (`tests/sdk_native_capability.rs`). `Grep` +
/// `Glob` + `Write` + `MultiEdit` + `NotebookEdit` + `ApplyPatch` are the SDK's.
/// None of them needs a cwd wrapper any more: the guard rewrites every path
/// argument to its canonical absolute form before the tool is entered, which is
/// strictly stronger than what the old `CwdTool` decorator did and applies to
/// every tool rather than the three that were remembered.
///
/// `cancel` is the turn's cancel token, injected into the tools that manage
/// their own subprocesses (Bash), so Stop kills the process group instead of
/// letting the command run to completion after cancel. `tier` and `caps` decide
/// which tools are visible at all.
// Built by successive pushes rather than one `vec![]`: which tools are present
// is conditional on tier, capability and platform, and each entry carries the
// comment saying why it is there.
#[allow(clippy::vec_init_then_push)]
pub fn atlas_coding_with(
    cancel: Option<tokio_util::sync::CancellationToken>,
    policy: Arc<ToolPolicy>,
    tier: ToolTier,
    caps: ModelCapabilities,
) -> Vec<Box<dyn Tool>> {
    use cersei::tools as t;
    let mut tools: Vec<Box<dyn Tool>> = Vec::new();

    // ── Always present, in both tiers ───────────────────────────────────────
    tools.push(Box::new(bash::BashTool {
        cancel,
        policy: Some(policy.clone()),
    }));
    // The persistent terminal: a dev server, a REPL, an interactive installer,
    // or a build too slow for Bash's timeout. It takes the policy for the same
    // reason Bash does — a session that outlives the call must not outrun the
    // sandbox.
    tools.push(Box::new(terminal::TerminalStartTool {
        policy: Some(policy.clone()),
    }));
    tools.push(Box::new(terminal::TerminalWriteTool));
    // `ApplyPatch` already joins working_dir, and the guard now contains the
    // paths inside its patch body as well.
    tools.push(Box::new(t::apply_patch::ApplyPatchTool));
    tools.push(Box::new(t::web_fetch::WebFetchTool));
    tools.push(Box::new(t::web_search::WebSearchTool));

    // Absent rather than failing at call time when the model cannot see.
    if caps.accepts_images {
        tools.push(Box::new(image::ImageViewTool));
    }

    // ── Structured tier: explicit file tools ────────────────────────────────
    if tier.includes_file_tools() {
        tools.push(Box::new(read::ReadTool));
        tools.push(Box::new(edit::EditTool));
        tools.push(Box::new(t::file_write::FileWriteTool));
        tools.push(Box::new(t::multi_edit::MultiEditTool));
        // Native cersei `Grep` + `Glob` (in-process since SDK 0.2.5 — ripgrep's
        // `ignore`/`grep` library crates, no external `rg` binary). This is the
        // fix for the recurring "model shells out to ripgrep and fails on stock
        // machines" issue: the tools work identically everywhere.
        tools.push(Box::new(t::grep_tool::GrepTool));
        tools.push(Box::new(t::glob_tool::GlobTool));
        // `List` stays Atlas-owned (no SDK equivalent) but is rg-free — it
        // walks via the `ignore` crate directly.
        tools.push(Box::new(list::ListTool));
        tools.push(Box::new(t::notebook_edit::NotebookEditTool));
        // D13 puts these three in a *deferred* tier — described in a searchable
        // catalogue rather than the default list. That machinery does not exist
        // yet, and dropping them instead would remove a capability users have
        // today, so they sit in the structured tier until it does.
        tools.push(Box::new(t::code_search::CodeSearchTool::new()));
        tools.push(Box::new(t::exa_search::ExaSearchTool));
    }

    // ── Platform-gated ──────────────────────────────────────────────────────
    // PowerShell was registered on every platform, where it is dead weight in
    // the tool list on macOS and Linux — and tool-list length is precisely what
    // degrades selection on weaker models.
    #[cfg(windows)]
    tools.push(Box::new(t::powershell::PowerShellTool));

    guard_all(tools, policy)
}

/// Minimal self-cleaning temp dir for tests (avoids a `tempfile` dev-dep).
#[cfg(test)]
pub(crate) struct TmpDir(pub std::path::PathBuf);

#[cfg(test)]
impl TmpDir {
    pub fn new() -> Self {
        let p = std::env::temp_dir().join(format!("atlas-cersei-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TmpDir(p)
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A tool context with a permit-everything policy, for tests exercising the
/// tool itself rather than the gate.
///
/// Approval behaviour is deliberately *not* tested through here: it belongs to
/// the gate, and `tests/tool_gate.rs` covers it at that seam by reproducing the
/// runner's dispatch — consult the permission policy, then execute. Bolting a
/// second permission path onto this helper would mean testing a shape the
/// runner does not have.
#[cfg(test)]
pub(crate) fn test_ctx(working_dir: std::path::PathBuf) -> cersei::tools::ToolContext {
    use std::sync::Arc;
    cersei::tools::ToolContext {
        working_dir,
        session_id: "test-session".into(),
        permissions: Arc::new(cersei::tools::permissions::AllowAll),
        cost_tracker: Arc::new(cersei::tools::CostTracker::new()),
        mcp_manager: None,
        extensions: cersei::tools::Extensions::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(tools: &[Box<dyn Tool>]) -> Vec<String> {
        tools.iter().map(|t| t.name().to_string()).collect()
    }

    #[test]
    fn the_structured_tier_has_the_file_tools_and_shell_first_does_not() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let structured = names(&atlas_coding_with(
            None,
            policy.clone(),
            ToolTier::Structured,
            ModelCapabilities::default(),
        ));
        let shell_first = names(&atlas_coding_with(
            None,
            policy,
            ToolTier::ShellFirst,
            ModelCapabilities::default(),
        ));

        for tool in ["Read", "Edit", "List", "Grep", "Glob"] {
            assert!(structured.contains(&tool.to_string()), "structured is missing {tool}");
            assert!(
                !shell_first.contains(&tool.to_string()),
                "shell-first must not carry {tool}"
            );
        }
        for tool in ["Bash", "TerminalStart", "TerminalWrite"] {
            assert!(shell_first.contains(&tool.to_string()), "shell-first is missing {tool}");
            assert!(structured.contains(&tool.to_string()));
        }
        assert!(
            shell_first.len() < structured.len(),
            "the point of the shell-first tier is a shorter list"
        );
    }

    #[test]
    fn the_image_tool_is_absent_for_a_model_that_cannot_see() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let blind = names(&atlas_coding_with(
            None,
            policy.clone(),
            ToolTier::Structured,
            ModelCapabilities { accepts_images: false },
        ));
        assert!(!blind.contains(&"ImageView".to_string()));

        let sighted = names(&atlas_coding_with(
            None,
            policy,
            ToolTier::Structured,
            ModelCapabilities { accepts_images: true },
        ));
        assert!(sighted.contains(&"ImageView".to_string()));
    }

    #[tokio::test]
    async fn every_registered_tool_is_guarded() {
        // The property the whole design rests on: no tool reaches the model
        // without the gate in front of it. Asserted behaviourally — an
        // out-of-workspace path must be refused by *every* tool that takes one.
        let tmp = TmpDir::new();
        let outside = TmpDir::new();
        std::fs::write(outside.path().join("secret.txt"), "shh").unwrap();
        let escape = outside.path().join("secret.txt").to_string_lossy().into_owned();

        let policy = ToolPolicy::contained(tmp.path());
        let tools = atlas_coding_with(
            None,
            policy,
            ToolTier::Structured,
            ModelCapabilities { accepts_images: true },
        );
        let ctx = test_ctx(tmp.path().to_path_buf());

        let mut checked = 0;
        for tool in &tools {
            let schema = tool.input_schema();
            let props = schema.get("properties").and_then(|p| p.as_object());
            let takes_path = props.is_some_and(|p| p.contains_key("file_path"));
            if !takes_path {
                continue;
            }
            let r = tool
                .execute(
                    serde_json::json!({
                        "file_path": escape,
                        "old_string": "a",
                        "new_string": "b",
                        "content": "x",
                        "edits": [],
                    }),
                    &ctx,
                )
                .await;
            assert!(
                r.is_error && r.content.contains("outside the workspace"),
                "{} let a path outside the workspace through: {}",
                tool.name(),
                r.content
            );
            checked += 1;
        }
        assert!(checked >= 4, "only {checked} path-taking tools were exercised");
        assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "shh");
    }

    #[test]
    fn powershell_is_not_registered_off_windows() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let all = names(&atlas_coding_with(
            None,
            policy,
            ToolTier::Structured,
            ModelCapabilities::default(),
        ));
        #[cfg(not(windows))]
        assert!(!all.contains(&"PowerShell".to_string()), "{all:?}");
        #[cfg(windows)]
        assert!(all.contains(&"PowerShell".to_string()));
    }
}
