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

/// Where `ExaSearch` looks for its key. Named here because whether the tool is
/// registered has to be decided by the same condition the tool itself checks.
const EXA_API_KEY: &str = "EXA_API_KEY";

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
/// `Glob` + `Write` + `NotebookEdit` are the SDK's.
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
        // D13 puts these in a *deferred* tier — described in a searchable
        // catalogue rather than the default list. That machinery does not exist
        // yet, and dropping a capability users have today would be worse, so
        // they sit in the structured tier until it does.
        //
        // `CodeSearch` is BM25 over the working tree — no index, no key, no
        // network — and returns ranked snippets with line numbers, so it often
        // answers a question that would otherwise cost a whole-file `Read`. It
        // earns its place in the list.
        tools.push(Box::new(t::code_search::CodeSearchTool::new()));
        // `ExaSearch` reads its key from the environment and errors at call
        // time without one. It carries the largest schema in the registry and
        // that schema is re-sent on every request of every turn, so registering
        // it unconditionally charges every user for a tool most of them cannot
        // run. Present only when it can actually work.
        if std::env::var_os(EXA_API_KEY).is_some_and(|k| !k.is_empty()) {
            tools.push(Box::new(t::exa_search::ExaSearchTool));
        }
    } else {
        // Shell-first has no structured editor, so the patch tool is the only
        // way to change a file without composing shell redirection by hand —
        // which is exactly the arrangement Codex ships. In the structured tier
        // `Edit` and `Write` cover the same ground with better errors, and a
        // third edit format is one more choice for a weak model to get wrong.
        tools.push(Box::new(t::apply_patch::ApplyPatchTool));
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

    /// Each tool's name, description and schema, as they go on the wire,
    /// largest first.
    fn wire_bytes(tools: &[Box<dyn Tool>]) -> Vec<(String, usize)> {
        let mut sizes: Vec<(String, usize)> = tools
            .iter()
            .map(|t| {
                let payload = serde_json::json!({
                    "name": t.name(),
                    "description": t.description(),
                    "input_schema": t.input_schema(),
                });
                let n = serde_json::to_string(&payload).map(|s| s.len()).unwrap_or(0);
                (t.name().to_string(), n)
            })
            .collect();
        sizes.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        sizes
    }

    #[test]
    fn the_tool_list_stays_within_its_context_budget() {
        // The tool list is re-sent on **every request of every turn**, so its
        // size is multiplied by the number of tool calls: a sixteen-call turn
        // pays for it sixteen times. It reached 12,213 B across 17 tools
        // without anyone noticing, which is part of how a one-line edit came to
        // cost 71k tokens of context; it is 8,593 B across 14 now.
        //
        // This is a budget, not a measurement. It fails when the list grows, so
        // the cost of a new tool is argued for in review instead of appearing
        // silently in everyone's context window.
        const STRUCTURED_MAX_BYTES: usize = 8_800;
        const SHELL_FIRST_MAX_BYTES: usize = 3_900;

        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let caps = ModelCapabilities { accepts_images: true };

        for (label, tier, budget) in [
            ("structured", ToolTier::Structured, STRUCTURED_MAX_BYTES),
            ("shell-first", ToolTier::ShellFirst, SHELL_FIRST_MAX_BYTES),
        ] {
            let tools = atlas_coding_with(None, policy.clone(), tier, caps);
            let sizes = wire_bytes(&tools);
            let bytes: usize = sizes.iter().map(|(_, n)| n).sum();
            let worst: Vec<String> = sizes
                .iter()
                .take(5)
                .map(|(name, n)| format!("{name} {n}B"))
                .collect();
            assert!(
                bytes <= budget,
                "the {label} tool list is {bytes} B (~{} tok) across {} tools, over its {budget} B \
                 budget. Every tool call in every turn pays this. Largest: {}. Shorten a \
                 description, merge an overlapping tool, or defer one — and only raise the budget \
                 with a reason.",
                bytes / 4,
                tools.len(),
                worst.join(", "),
            );
        }
    }

    #[test]
    fn one_way_to_change_a_file_in_the_structured_tier() {
        // `Edit`, `MultiEdit`, `ApplyPatch` and `Write` were four overlapping
        // ways to do the same thing, costing 715 tok of schema in every request
        // and giving a weak model four chances to pick the wrong one.
        // `MultiEdit` is now `Edit`'s `edits` array; the patch tool is gone from
        // the tier where `Edit` and `Write` already cover its ground.
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let structured = names(&atlas_coding_with(
            None,
            policy.clone(),
            ToolTier::Structured,
            ModelCapabilities::default(),
        ));
        for gone in ["MultiEdit", "ApplyPatch"] {
            assert!(!structured.contains(&gone.to_string()), "{gone} is back: {structured:?}");
        }
        for kept in ["Edit", "Write"] {
            assert!(structured.contains(&kept.to_string()), "{kept} is missing: {structured:?}");
        }

        // Shell-first has no structured editor, so the patch tool is the one
        // way to change a file there without hand-composing redirection.
        let shell_first = names(&atlas_coding_with(
            None,
            policy,
            ToolTier::ShellFirst,
            ModelCapabilities::default(),
        ));
        assert!(shell_first.contains(&"ApplyPatch".to_string()), "{shell_first:?}");
    }

    #[tokio::test]
    async fn edit_accepts_the_batch_shape_multi_edit_used_to_own() {
        // Dropping a tool must not drop the capability: a model that batches
        // several replacements into one call still gets one call.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "one\ntwo\n").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let tools = atlas_coding_with(
            None,
            policy.clone(),
            ToolTier::Structured,
            ModelCapabilities::default(),
        );
        let edit = tools.iter().find(|t| t.name() == "Edit").expect("Edit is registered");
        policy.record_read(&policy.resolve("a.rs"));

        let r = edit
            .execute(
                serde_json::json!({
                    "file_path": "a.rs",
                    "edits": [
                        {"old_string": "one", "new_string": "1"},
                        {"old_string": "two", "new_string": "2"}
                    ]
                }),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.rs")).unwrap(), "1\n2\n");
    }

    #[test]
    fn exa_search_is_registered_only_when_it_can_run() {
        // The largest schema in the registry, re-sent on every request, for a
        // tool that errors at call time without a key. Asserted against the
        // environment the test runs in rather than by mutating it: `set_var` is
        // process-global and these tests run in parallel.
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let all = names(&atlas_coding_with(
            None,
            policy,
            ToolTier::Structured,
            ModelCapabilities::default(),
        ));
        let usable = std::env::var(EXA_API_KEY).is_ok_and(|k| !k.is_empty());
        assert_eq!(
            all.contains(&"ExaSearch".to_string()),
            usable,
            "ExaSearch presence must track EXA_API_KEY, got {all:?}"
        );
        // CodeSearch is BM25-only — no key, no index, no network — so it is
        // always available and must not be gated alongside it.
        assert!(all.contains(&"CodeSearch".to_string()), "{all:?}");
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
