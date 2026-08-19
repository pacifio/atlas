//! `Guarded<T>` — the decorator that applies [`ToolPolicy`] to every tool.
//!
//! Applied once, at registry construction, to *every* tool the registry emits:
//! Atlas-authored, SDK-provided, and MCP-discovered alike. No tool implements
//! containment, coercion, or freshness itself, so a tool added later inherits
//! all of it without knowing this module exists — which is the property that
//! makes "installing an MCP server cannot create an unguarded path" true.
//!
//! What happens on every call, in order (tool spec D1):
//!
//! 1. **Coerce** the arguments against the tool's declared schema.
//! 2. **Contain** every path the call names, and rewrite it to its canonical
//!    absolute form, so the tool underneath cannot resolve it differently.
//! 3. **Short-circuit a repeat read** whose answer is already in the
//!    conversation and whose file has not changed.
//! 4. **Check freshness** for a write-class call: refuse if the file was never
//!    read this session, or changed since it was.
//! 5. **Execute**, with `working_dir` normalised to the canonical root.
//! 6. **Record** the read (or refresh the record after a write), and emit one
//!    telemetry line.
//!
//! Classification, the approval cache, and the prompt itself sit in
//! [`ToolPolicy::decide`], which the session's `PermissionPolicy` calls before
//! the runner dispatches anything. That split is deliberate: the runner already
//! hands the tool *input* to the permission policy, so a per-command verdict
//! needs no vendored-runner patch.
//!
//! Sandbox wrapping and denial escalation are **not** here, and cannot be: the
//! guard does not spawn the process, so it has nothing to wrap. They live in
//! the tools that own a subprocess — the shell and the persistent terminal —
//! each of which takes the same policy.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde_json::Value;

use super::policy::{candidate_paths, Freshness, ToolPolicy, PATH_FIELDS};
use super::{coerce, errors};

/// Wrap every tool in `tools` with the shared policy.
pub fn guard_all(tools: Vec<Box<dyn Tool>>, policy: Arc<ToolPolicy>) -> Vec<Box<dyn Tool>> {
    tools
        .into_iter()
        .map(|t| Guarded::wrap(t, policy.clone()))
        .collect()
}

pub struct Guarded {
    inner: Box<dyn Tool>,
    policy: Arc<ToolPolicy>,
}

impl Guarded {
    pub fn wrap(inner: Box<dyn Tool>, policy: Arc<ToolPolicy>) -> Box<dyn Tool> {
        Box::new(Guarded { inner, policy })
    }

    /// Whether this tool can modify the filesystem, and therefore needs the
    /// read-before-edit precondition.
    fn is_write_class(&self) -> bool {
        matches!(
            self.inner.permission_level(),
            PermissionLevel::Write | PermissionLevel::Dangerous
        )
    }
}

#[async_trait]
impl Tool for Guarded {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn description(&self) -> &str {
        self.inner.description()
    }
    fn input_schema(&self) -> Value {
        self.inner.input_schema()
    }
    fn permission_level(&self) -> PermissionLevel {
        self.inner.permission_level()
    }
    fn category(&self) -> ToolCategory {
        self.inner.category()
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let started = Instant::now();
        let name = self.inner.name().to_string();

        // 1. Coerce, driven by the tool's own schema.
        let mut input = coerce::for_schema(input, &self.inner.input_schema());

        // 2. Contain, and rewrite path fields to their canonical absolute form.
        //    The rewrite is what removes the need for the old `CwdTool`
        //    wrapper: an SDK tool that resolves a bare `file_path` now receives
        //    a path that is already absolute, already collapsed, and already
        //    proven to be inside the workspace.
        let raw_paths = candidate_paths(&name, &input);
        let mut canonical: Vec<std::path::PathBuf> = Vec::with_capacity(raw_paths.len());
        for raw in &raw_paths {
            match self.policy.contain(raw) {
                Ok(p) => canonical.push(p),
                Err(c) => {
                    return finish(&self.policy, &name, "denied", started, ToolResult::error(c.to_string()));
                }
            }
        }
        // Only rewrite when the tier actually contains paths. At the
        // approvals-only tier the user has asked Atlas not to bound paths, and
        // silently rewriting one to its symlink-resolved real form would be a
        // surprise with no safety benefit.
        if self.policy.contains_paths() {
            rewrite_paths(&mut input, &self.policy);
        }

        // 3. A repeat read whose answer is already in the conversation. The
        //    policy recorded what the file looked like when the same call was
        //    last answered; if it still looks that way the output would be
        //    byte-identical, and returning it costs another full copy of the
        //    file for nothing. Restricted to `Read` because it is the
        //    tool that returns whole file contents; a repeated `Grep` or `List`
        //    costs a fraction of the same call and its result is cheap enough
        //    that suppressing it would trade tokens for confusion.
        let mut read_signature: Option<(String, std::path::PathBuf)> = None;
        if name == "Read" {
            if let Some(path) = canonical.first() {
                let sig = signature_for(&name, path, &input);
                if self.policy.already_served(&sig, path) {
                    return finish(
                        &self.policy,
                        &name,
                        "repeat",
                        started,
                        ToolResult::success(errors::already_read(&display(
                            path,
                            self.policy.root(),
                        ))),
                    );
                }
                read_signature = Some((sig, path.clone()));
            }
        }

        // 4. Freshness — before execution, so a rejection message and the file
        //    on disk can never disagree.
        if self.is_write_class() {
            for path in &canonical {
                if !path.exists() {
                    continue; // creating a new file: nothing to clobber
                }
                match self.policy.check_fresh(path) {
                    Freshness::Fresh => {}
                    Freshness::NeverRead => {
                        return finish(
                            &self.policy,
                            &name,
                            "unread",
                            started,
                            ToolResult::error(errors::must_read_first(&display(path, self.policy.root()))),
                        );
                    }
                    Freshness::Stale => {
                        return finish(
                            &self.policy,
                            &name,
                            "stale",
                            started,
                            ToolResult::error(errors::file_changed(&display(path, self.policy.root()))),
                        );
                    }
                }
            }
        }

        // 5. Execute with the canonical root as the working directory, so a
        //    tool that joins a relative path lands in the same place the guard
        //    just proved safe.
        let mut inner_ctx = ctx.clone();
        inner_ctx.working_dir = self.policy.root().to_path_buf();
        let result = self.inner.execute(input, &inner_ctx).await;

        // 6/7. Record and report.
        if !result.is_error {
            // Recorded only on success: a read that failed put nothing in the
            // conversation, so repeating it must not be short-circuited.
            if let Some((sig, path)) = read_signature {
                self.policy.record_served(sig, &path);
            }
            for path in &canonical {
                if self.is_write_class() {
                    // Refresh rather than forget: the model knows what it just
                    // wrote, so a follow-up edit in the same turn must not be
                    // refused as stale.
                    self.policy.record_read(path);
                } else if path.is_file() {
                    // A read of any kind registers the path. This is what makes
                    // read-before-edit work in the shell-first tier too.
                    self.policy.record_read(path);
                }
            }
        }
        let outcome = if result.is_error { "error" } else { "ok" };
        finish(&self.policy, &name, outcome, started, result)
    }
}

/// Replace every path field in `input` with its canonical absolute form.
fn rewrite_paths(input: &mut Value, policy: &ToolPolicy) {
    fn rewrite_obj(obj: &mut serde_json::Map<String, Value>, policy: &ToolPolicy) {
        for field in PATH_FIELDS {
            let replacement = obj
                .get(*field)
                .and_then(Value::as_str)
                .map(|raw| policy.resolve(raw).to_string_lossy().into_owned());
            if let Some(abs) = replacement {
                obj.insert((*field).to_string(), Value::String(abs));
            }
        }
    }
    let Some(obj) = input.as_object_mut() else {
        return;
    };
    rewrite_obj(obj, policy);
    if let Some(edits) = obj.get_mut("edits").and_then(Value::as_array_mut) {
        for edit in edits {
            if let Some(e) = edit.as_object_mut() {
                rewrite_obj(e, policy);
            }
        }
    }
}

/// The identity of a read: the tool, the canonical path, and the range asked
/// for. Two calls sharing a signature return byte-identical output as long as
/// the file is unchanged — which is what makes suppressing the second one safe,
/// and what keeps `offset`/`limit` pagination working: page 2 of a file is a
/// different signature from page 1.
fn signature_for(name: &str, path: &Path, input: &Value) -> String {
    let range = |field: &str| {
        input
            .get(field)
            .and_then(Value::as_u64)
            .map(|n| n.to_string())
            .unwrap_or_default()
    };
    format!(
        "{name}\u{1}{}\u{1}{}\u{1}{}",
        path.display(),
        range("offset"),
        range("limit")
    )
}

/// Render `path` relative to the workspace root for a user-facing message.
fn display(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

/// One structured record per tool call: name, tier, outcome, latency. No
/// arguments, no paths, no content — this is what turns "the tools don't work"
/// into a claim someone can act on, and it must not become a way to leak the
/// user's code.
fn finish(
    policy: &ToolPolicy,
    tool: &str,
    outcome: &str,
    started: Instant,
    result: ToolResult,
) -> ToolResult {
    tracing::debug!(
        target: "atlas::tool_call",
        tool,
        tier = policy.tier().as_str(),
        outcome,
        latency_ms = started.elapsed().as_millis() as u64,
        "tool call"
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};
    use serde_json::json;

    /// A tool that records what it was handed and reports success.
    struct Spy {
        name: &'static str,
        level: PermissionLevel,
        seen: std::sync::Mutex<Option<(Value, std::path::PathBuf)>>,
        calls: std::sync::atomic::AtomicUsize,
        fail: bool,
    }

    impl Spy {
        fn new(name: &'static str, level: PermissionLevel) -> Arc<Self> {
            Arc::new(Spy {
                name,
                level,
                seen: std::sync::Mutex::new(None),
                calls: std::sync::atomic::AtomicUsize::new(0),
                fail: false,
            })
        }
        /// A spy whose tool always reports failure.
        fn failing(name: &'static str, level: PermissionLevel) -> Arc<Self> {
            Arc::new(Spy {
                name,
                level,
                seen: std::sync::Mutex::new(None),
                calls: std::sync::atomic::AtomicUsize::new(0),
                fail: true,
            })
        }
        fn last(&self) -> Option<(Value, std::path::PathBuf)> {
            self.seen.lock().unwrap().clone()
        }
        /// How many times the *inner* tool actually ran — the only way to tell
        /// a suppressed call from an executed one.
        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    struct SpyRef(Arc<Spy>);

    #[async_trait]
    impl Tool for SpyRef {
        fn name(&self) -> &str {
            self.0.name
        }
        fn description(&self) -> &str {
            "spy"
        }
        fn input_schema(&self) -> Value {
            json!({"type":"object","properties":{"file_path":{},"old_string":{},"new_string":{},"offset":{},"limit":{}}})
        }
        fn permission_level(&self) -> PermissionLevel {
            self.0.level
        }
        async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
            self.0.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *self.0.seen.lock().unwrap() = Some((input, ctx.working_dir.clone()));
            if self.0.fail {
                ToolResult::error("no such file")
            } else {
                ToolResult::success("done")
            }
        }
    }

    fn wrap(spy: &Arc<Spy>, policy: Arc<ToolPolicy>) -> Box<dyn Tool> {
        Guarded::wrap(Box::new(SpyRef(spy.clone())), policy)
    }

    #[tokio::test]
    async fn a_path_outside_the_workspace_never_reaches_the_tool() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Edit", PermissionLevel::Write);
        let g = wrap(&spy, policy);
        let r = g
            .execute(
                json!({"file_path": "/etc/hosts", "old_string": "a", "new_string": "b"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("outside the workspace"));
        assert!(spy.last().is_none(), "the tool must never have run");
    }

    #[tokio::test]
    async fn relative_paths_arrive_absolute_and_contained() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Read", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy.clone());
        let _ = g
            .execute(
                json!({"file_path": "src/main.rs"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        let (input, wd) = spy.last().expect("tool ran");
        let got = input["file_path"].as_str().unwrap();
        assert!(Path::new(got).is_absolute(), "{got}");
        assert!(got.starts_with(&*policy.root().to_string_lossy()));
        // The working dir handed down is the canonical root, so a tool that
        // joins a relative path lands where the guard proved safe.
        assert_eq!(wd, policy.root());
    }

    #[tokio::test]
    async fn sdk_shaped_aliases_are_coerced_before_containment() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Edit", PermissionLevel::Write);
        let g = wrap(&spy, policy);
        let r = g
            .execute(
                json!({"filePath": "../../etc/hosts", "oldString": "a", "newString": "b"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(r.is_error, "an aliased field must still be contained");
        assert!(spy.last().is_none());
    }

    #[tokio::test]
    async fn write_to_an_unread_file_is_refused_before_execution() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "original").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Edit", PermissionLevel::Write);
        let g = wrap(&spy, policy);
        let r = g
            .execute(
                json!({"file_path": "a.rs", "old_string": "o", "new_string": "n"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("Read"), "{}", r.content);
        assert!(spy.last().is_none(), "the write must not have been attempted");
        // The message and the file on disk agree — the whole point of moving
        // this precondition ahead of execution.
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.rs")).unwrap(), "original");
    }

    #[tokio::test]
    async fn write_to_a_file_changed_since_the_read_is_refused() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "original").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        policy.record_read(&policy.resolve("a.rs"));
        // The user edits in their editor while the agent is thinking.
        std::fs::write(&f, "the user's own work, much longer").unwrap();

        let spy = Spy::new("Edit", PermissionLevel::Write);
        let g = wrap(&spy, policy);
        let r = g
            .execute(
                json!({"file_path": "a.rs", "old_string": "o", "new_string": "n"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("changed"), "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "the user's own work, much longer",
            "the user's work must survive"
        );
    }

    #[tokio::test]
    async fn creating_a_new_file_needs_no_prior_read() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Write", PermissionLevel::Write);
        let g = wrap(&spy, policy);
        let r = g
            .execute(
                json!({"file_path": "new.rs", "old_string": "", "new_string": "x"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(spy.last().is_some());
    }

    #[tokio::test]
    async fn a_read_registers_the_path_so_the_next_edit_is_allowed() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "original").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let reader = Spy::new("Read", PermissionLevel::ReadOnly);
        let writer = Spy::new("Edit", PermissionLevel::Write);
        let ctx = test_ctx(tmp.path().to_path_buf());

        let _ = wrap(&reader, policy.clone())
            .execute(json!({"file_path": "a.rs"}), &ctx)
            .await;
        let r = wrap(&writer, policy)
            .execute(
                json!({"file_path": "a.rs", "old_string": "o", "new_string": "n"}),
                &ctx,
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
    }

    #[tokio::test]
    async fn a_second_edit_in_the_same_turn_is_not_stale() {
        // After a successful write the record is refreshed, not dropped: the
        // model knows what it just wrote.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "one").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        policy.record_read(&policy.resolve("a.rs"));

        struct Writer;
        #[async_trait]
        impl Tool for Writer {
            fn name(&self) -> &str {
                "Edit"
            }
            fn description(&self) -> &str {
                "w"
            }
            fn input_schema(&self) -> Value {
                json!({"type":"object","properties":{"file_path":{},"new_string":{}}})
            }
            fn permission_level(&self) -> PermissionLevel {
                PermissionLevel::Write
            }
            async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
                let p = input["file_path"].as_str().unwrap();
                std::fs::write(p, input["new_string"].as_str().unwrap()).unwrap();
                ToolResult::success("wrote")
            }
        }

        let g = Guarded::wrap(Box::new(Writer), policy);
        let ctx = test_ctx(tmp.path().to_path_buf());
        let first = g
            .execute(json!({"file_path": "a.rs", "new_string": "two"}), &ctx)
            .await;
        assert!(!first.is_error, "{}", first.content);
        let second = g
            .execute(json!({"file_path": "a.rs", "new_string": "three"}), &ctx)
            .await;
        assert!(!second.is_error, "{}", second.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "three");
    }

    #[tokio::test]
    async fn tools_with_no_paths_pass_straight_through() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("WebSearch", PermissionLevel::None);
        let g = wrap(&spy, policy);
        let r = g
            .execute(json!({"query": "rust"}), &test_ctx(tmp.path().to_path_buf()))
            .await;
        assert!(!r.is_error);
        assert!(spy.last().is_some());
    }

    // ── Repeat-read suppression ─────────────────────────────────────────────
    //
    // A one-line edit to a 2000-line file was costing tens of thousands of
    // tokens because the same file was read six times and the registry, which
    // knew it had not changed, said nothing. These pin the boundary: suppress
    // only a call whose output would be byte-identical.

    /// Read `path` through `g`, optionally paginated.
    async fn read_via(
        g: &dyn Tool,
        ctx: &ToolContext,
        path: &str,
        offset: Option<u64>,
    ) -> ToolResult {
        let mut args = json!({ "file_path": path });
        if let Some(o) = offset {
            args["offset"] = json!(o);
        }
        g.execute(args, ctx).await
    }

    #[tokio::test]
    async fn an_identical_repeat_read_of_an_unchanged_file_does_not_run_again() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "fn main() {}").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Read", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy);
        let ctx = test_ctx(tmp.path().to_path_buf());

        let first = read_via(g.as_ref(), &ctx, "a.rs", None).await;
        assert!(!first.is_error, "{}", first.content);
        let second = read_via(g.as_ref(), &ctx, "a.rs", None).await;

        assert_eq!(spy.calls(), 1, "the second read re-ran the tool");
        assert!(!second.is_error, "a repeat read is not a failure");
        assert!(second.content.contains("a.rs"), "{}", second.content);
        assert!(
            second.content.contains("has not changed"),
            "the model must be told why: {}",
            second.content
        );
    }

    #[tokio::test]
    async fn a_repeat_read_is_served_in_full_once_the_file_changes() {
        // The case that makes suppression safe to ship: whoever changed the
        // file — the user, another tool, the agent itself — the next read must
        // see it.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "one").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Read", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy);
        let ctx = test_ctx(tmp.path().to_path_buf());

        let _ = read_via(g.as_ref(), &ctx, "a.rs", None).await;
        std::fs::write(&f, "two, and a different length").unwrap();
        let after = read_via(g.as_ref(), &ctx, "a.rs", None).await;

        assert_eq!(spy.calls(), 2, "a changed file must be read again");
        assert!(!after.content.contains("has not changed"));
    }

    #[tokio::test]
    async fn a_read_after_an_edit_sees_the_edit() {
        // The write path *refreshes* the read record, so a served set keyed on
        // that record would call the file fresh and hide the agent's own edit
        // from it. The served set therefore carries its own snapshot.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "one").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let reader = Spy::new("Read", PermissionLevel::ReadOnly);
        let ctx = test_ctx(tmp.path().to_path_buf());
        let r = wrap(&reader, policy.clone());

        let _ = read_via(r.as_ref(), &ctx, "a.rs", None).await;

        struct Writer;
        #[async_trait]
        impl Tool for Writer {
            fn name(&self) -> &str {
                "Edit"
            }
            fn description(&self) -> &str {
                "w"
            }
            fn input_schema(&self) -> Value {
                json!({"type":"object","properties":{"file_path":{},"new_string":{}}})
            }
            fn permission_level(&self) -> PermissionLevel {
                PermissionLevel::Write
            }
            async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
                std::fs::write(
                    input["file_path"].as_str().unwrap(),
                    input["new_string"].as_str().unwrap(),
                )
                .unwrap();
                ToolResult::success("wrote")
            }
        }
        let w = Guarded::wrap(Box::new(Writer), policy);
        let edit = w
            .execute(json!({"file_path": "a.rs", "new_string": "two"}), &ctx)
            .await;
        assert!(!edit.is_error, "{}", edit.content);

        let verify = read_via(r.as_ref(), &ctx, "a.rs", None).await;
        assert_eq!(reader.calls(), 2, "{}", verify.content);
        assert!(!verify.content.contains("has not changed"), "{}", verify.content);
    }

    #[tokio::test]
    async fn paging_through_a_file_is_never_suppressed() {
        // Page 2 is a different signature from page 1, so a large file can
        // still be read end to end.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("big.rs"), "x".repeat(4096)).unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("Read", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy);
        let ctx = test_ctx(tmp.path().to_path_buf());

        let _ = read_via(g.as_ref(), &ctx, "big.rs", None).await;
        let _ = read_via(g.as_ref(), &ctx, "big.rs", Some(1000)).await;
        let _ = read_via(g.as_ref(), &ctx, "big.rs", Some(2000)).await;
        assert_eq!(spy.calls(), 3, "pagination must not be short-circuited");

        // ...but re-asking for a page already served is.
        let repeat = read_via(g.as_ref(), &ctx, "big.rs", Some(1000)).await;
        assert_eq!(spy.calls(), 3);
        assert!(repeat.content.contains("has not changed"));
    }

    #[tokio::test]
    async fn a_failed_read_is_not_remembered_as_answered() {
        // Nothing reached the conversation, so the retry must actually run.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::failing("Read", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy);
        let ctx = test_ctx(tmp.path().to_path_buf());

        let _ = read_via(g.as_ref(), &ctx, "a.rs", None).await;
        let _ = read_via(g.as_ref(), &ctx, "a.rs", None).await;
        assert_eq!(spy.calls(), 2);
    }

    #[tokio::test]
    async fn only_read_is_suppressed() {
        // Grep and List return a fraction of a file each and are cheap to
        // repeat; suppressing them would buy little and confuse a model that
        // is legitimately re-checking.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x").unwrap();
        let policy = ToolPolicy::contained(tmp.path());
        let spy = Spy::new("List", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy);
        let ctx = test_ctx(tmp.path().to_path_buf());

        let _ = read_via(g.as_ref(), &ctx, "a.rs", None).await;
        let _ = read_via(g.as_ref(), &ctx, "a.rs", None).await;
        assert_eq!(spy.calls(), 2);
    }

    #[tokio::test]
    async fn approvals_only_tier_still_coerces_but_does_not_contain() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::at_tier(tmp.path(), super::super::policy::EnforcementTier::ApprovalsOnly);
        let spy = Spy::new("Read", PermissionLevel::ReadOnly);
        let g = wrap(&spy, policy);
        let r = g
            .execute(
                json!({"filePath": "/etc/hosts"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        let (input, _) = spy.last().expect("tool ran");
        assert_eq!(input["file_path"], "/etc/hosts", "the alias was still applied");
    }
}
