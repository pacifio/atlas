//! `ToolPolicy` — the single pre-execution decision point for every tool.
//!
//! This is the one new seam introduced by `plans/atlas-tool-layer-spec.md` (D1).
//! It owns everything that was previously scattered across individual tools or
//! missing entirely:
//!
//! * the workspace root and the canonicalisation routine (D2),
//! * the read registry, which gives staleness detection *and* read-before-edit
//!   in both tool tiers (D3),
//! * schema-driven argument coercion (D7),
//! * command classification and the approval cache (D8),
//! * sandbox selection and the enforcement ladder (harness spec D3),
//! * the session-scoped spill directory used by output truncation (D6).
//!
//! Two callers use it, and between them they implement the ordering fixed in
//! D1 — `coerce → contain → freshness → classify → cache → prompt →
//! sandbox-wrap → execute → detect denial → record`:
//!
//! * [`ToolPolicy::decide`] is called from the session's `PermissionPolicy`,
//!   which the agent runner consults *before* dispatching a tool. It runs
//!   coerce → contain → classify → cache and returns whether to prompt.
//! * [`super::guard::Guarded`] wraps every registered tool and runs
//!   coerce → contain → freshness → sandbox-wrap → execute → record.
//!
//! Splitting it this way means no vendored runner patch is needed to get a
//! *per-command* permission verdict: the runner already hands the tool input to
//! the policy, so classification has everything it needs.
//!
//! The decision half is a pure function over its inputs plus the two caches, so
//! a new rule can be tested without an agent, a provider, or a network.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use cersei::tools::PermissionLevel;
use dashmap::DashMap;
use serde_json::Value;

use super::classify::{self, Risk};
use super::sandbox::{self, Sandbox};

/// Directory (relative to the workspace root) holding spill files. Inside the
/// workspace on purpose: containment must permit the model to read a file the
/// truncation notice told it about (tool spec story 14). Each session gets its
/// own subdirectory, so one session's teardown cannot delete another's.
pub const SPILL_DIR: &str = ".atlas/tool-output";

/// The strongest enforcement the host actually provides, resolved at runtime.
///
/// The ladder degrades rather than failing, and the tier in force is reported
/// to the UI, because silent degradation is the failure this design exists to
/// prevent (harness spec D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnforcementTier {
    /// OS sandbox + containment + approvals.
    Sandboxed,
    /// Containment + approvals. The sandbox is unavailable on this host.
    Contained,
    /// Approvals only. Nothing selects this yet — the containment toggle it
    /// exists for is not a setting a user can reach. Constructible via
    /// [`ToolPolicy::at_tier`] so the behaviour is pinned before it is wired.
    ApprovalsOnly,
    /// Today's behaviour. Never selected automatically; the floor.
    Legacy,
}

impl EnforcementTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sandboxed => "sandboxed",
            Self::Contained => "contained",
            Self::ApprovalsOnly => "approvals-only",
            Self::Legacy => "legacy",
        }
    }

    /// One line for the session UI. Users are told what is protecting them.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Sandboxed => {
                "OS sandbox + workspace containment + approvals — shell commands run confined."
            }
            Self::Contained => {
                "Workspace containment + approvals — no OS sandbox on this host, so shell \
                 commands are bounded by approval rather than by the kernel."
            }
            Self::ApprovalsOnly => {
                "Approvals only — workspace containment is disabled, so file tools may reach \
                 any path you can write."
            }
            Self::Legacy => "Unrestricted — no containment and no approvals.",
        }
    }

    fn contains_paths(self) -> bool {
        matches!(self, Self::Sandboxed | Self::Contained)
    }
}

/// What the policy decided about one tool call, before anything executed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Run it. No prompt.
    Allow,
    /// Ask the user. `cache_key` is what "Allow for this session" stores; it is
    /// `None` for a decision that must never be cached (tool spec story 22).
    Prompt {
        reason: String,
        risk: Risk,
        cache_key: Option<String>,
    },
    /// Refused before reaching the OS.
    Deny { reason: String },
}

/// Why a path was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Containment {
    pub raw: String,
    pub resolved: PathBuf,
    pub root: PathBuf,
}

impl std::fmt::Display for Containment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Path '{}' resolves to {}, which is outside the workspace ({}). \
             Tools may only reach paths under the workspace root.",
            self.raw,
            self.resolved.display(),
            self.root.display()
        )
    }
}

/// What the read registry knows about a file at the moment a tool read it.
///
/// Modification time and length, which is what every editor uses to detect an
/// external change. A content hash was considered and dropped: on every
/// filesystem Atlas ships to, `mtime` has nanosecond granularity, so the case a
/// hash would additionally catch — a same-length rewrite inside one clock tick
/// — does not arise, and hashing would cost a second full read of every file on
/// the hot path.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReadRecord {
    mtime: Option<SystemTime>,
    len: u64,
}

/// Result of consulting the read registry before a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freshness {
    /// Never read this session — the read-before-edit precondition fails.
    NeverRead,
    /// Read, but the file changed since. Editing would clobber that change.
    Stale,
    /// Read and unchanged.
    Fresh,
}

/// The gate. One instance per session, shared by the permission policy and by
/// every [`super::guard::Guarded`] tool in that session's registry.
pub struct ToolPolicy {
    /// Canonicalised workspace root. Every contained path must live under it.
    root: PathBuf,
    /// Names this policy's spill subdirectory. Two sessions open on the same
    /// workspace must not delete each other's retained output.
    session: String,
    tier: EnforcementTier,
    sandbox: Option<Sandbox>,
    /// Approval cache — the thing that makes "Allow for this session" a fact
    /// rather than a no-op. Keyed by [`Self::cache_key`].
    approvals: DashMap<String, ()>,
    /// Read registry, keyed by canonical path.
    reads: DashMap<PathBuf, ReadRecord>,
    /// Set once the session's spill directory has been created, so the common
    /// path does not stat it on every truncation.
    spill_ready: AtomicBool,
}

impl ToolPolicy {
    /// Build a policy for `root`, resolving the strongest tier this host
    /// supports. `root` is canonicalised; if that fails (the directory does not
    /// exist) the path is used lexically and containment still works.
    ///
    /// `session` names this policy's spill subdirectory and nothing else; any
    /// value unique per session will do.
    pub fn new(root: impl Into<PathBuf>, session: impl Into<String>) -> Arc<Self> {
        let root = root.into();
        let root = root.canonicalize().unwrap_or(root);
        let sandbox = sandbox::detect(&root);
        let tier = if sandbox.is_some() {
            EnforcementTier::Sandboxed
        } else {
            EnforcementTier::Contained
        };
        Arc::new(Self {
            root,
            session: session.into(),
            tier,
            sandbox,
            approvals: DashMap::new(),
            reads: DashMap::new(),
            spill_ready: AtomicBool::new(false),
        })
    }

    /// A policy that contains paths but never sandboxes. Used on hosts without
    /// a sandbox, and by tests that want containment without spawning
    /// `sandbox-exec`.
    pub fn contained(root: impl Into<PathBuf>) -> Arc<Self> {
        Self::contained_for(root, uuid::Uuid::new_v4().to_string())
    }

    /// [`Self::contained`] with an explicit session name.
    pub fn contained_for(root: impl Into<PathBuf>, session: impl Into<String>) -> Arc<Self> {
        let root = root.into();
        let root = root.canonicalize().unwrap_or(root);
        Arc::new(Self {
            root,
            session: session.into(),
            tier: EnforcementTier::Contained,
            sandbox: None,
            approvals: DashMap::new(),
            reads: DashMap::new(),
            spill_ready: AtomicBool::new(false),
        })
    }

    /// A policy at a caller-chosen tier. `ApprovalsOnly` and `Legacy` are only
    /// reachable this way — never selected automatically.
    pub fn at_tier(root: impl Into<PathBuf>, tier: EnforcementTier) -> Arc<Self> {
        Self::at_tier_for(root, tier, uuid::Uuid::new_v4().to_string())
    }

    /// [`Self::at_tier`] with an explicit session name.
    pub fn at_tier_for(
        root: impl Into<PathBuf>,
        tier: EnforcementTier,
        session: impl Into<String>,
    ) -> Arc<Self> {
        let root = root.into();
        let root = root.canonicalize().unwrap_or(root);
        let sandbox = if tier == EnforcementTier::Sandboxed {
            sandbox::detect(&root)
        } else {
            None
        };
        Arc::new(Self {
            root,
            session: session.into(),
            tier: if tier == EnforcementTier::Sandboxed && sandbox.is_none() {
                EnforcementTier::Contained
            } else {
                tier
            },
            sandbox,
            approvals: DashMap::new(),
            reads: DashMap::new(),
            spill_ready: AtomicBool::new(false),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn tier(&self) -> EnforcementTier {
        self.tier
    }

    /// Whether the tier in force bounds file paths to the workspace.
    pub fn contains_paths(&self) -> bool {
        self.tier.contains_paths()
    }

    pub fn sandbox(&self) -> Option<&Sandbox> {
        self.sandbox.as_ref()
    }

    // ── Containment (D2) ────────────────────────────────────────────────────

    /// Resolve `raw` against the workspace root and refuse anything that
    /// escapes it.
    ///
    /// Four normalisations, in order, each of which closes a real hole:
    ///
    /// 1. **Absolutise.** A relative path is joined onto the root. An absolute
    ///    path is *not* passed through — that was the defect.
    /// 2. **Collapse `.` and `..` lexically.** Done without touching the
    ///    filesystem so it works for a path that does not exist yet (a create).
    /// 3. **Resolve symlinks** on the longest existing ancestor, so a link
    ///    inside the workspace pointing outside it is treated as outside.
    /// 4. **Compare against the canonical root.**
    ///
    /// Steps 1–3 are lifted from `atlas_checkpoint::tools::resolve_path`, whose
    /// tests already cover traversal and home-directory escape; step 3 is added
    /// here because containment (unlike checkpoint linking) must not be
    /// defeatable by indirection.
    pub fn contain(&self, raw: &str) -> Result<PathBuf, Containment> {
        let resolved = self.resolve(raw);
        if !self.tier.contains_paths() || resolved.starts_with(&self.root) {
            Ok(resolved)
        } else {
            Err(Containment {
                raw: raw.to_string(),
                resolved,
                root: self.root.clone(),
            })
        }
    }

    /// The canonical path for `raw`, without the containment verdict. Used for
    /// lock and registry keys, where the same file reached three ways must
    /// produce one key.
    pub fn resolve(&self, raw: &str) -> PathBuf {
        let candidate = PathBuf::from(raw);
        let absolute = if candidate.is_absolute() {
            candidate
        } else {
            self.root.join(candidate)
        };
        resolve_symlinks(&lexically_normalize(&absolute))
    }

    // ── Read registry (D3) ──────────────────────────────────────────────────

    /// Record that a tool read `path`. Called by the guard for every read-class
    /// call, which is what makes read-before-edit work in the shell-first tier
    /// too: a shell command that names a path registers it.
    pub fn record_read(&self, path: &Path) {
        let meta = std::fs::metadata(path).ok();
        self.reads.insert(
            path.to_path_buf(),
            ReadRecord {
                mtime: meta.as_ref().and_then(|m| m.modified().ok()),
                len: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            },
        );
    }

    /// Consult the registry before a write.
    pub fn check_fresh(&self, path: &Path) -> Freshness {
        let Some(record) = self.reads.get(path) else {
            return Freshness::NeverRead;
        };
        let Ok(meta) = std::fs::metadata(path) else {
            // The file vanished since the read. Refusing beats writing over
            // whatever replaced it.
            return Freshness::Stale;
        };
        let same_len = meta.len() == record.len;
        let same_mtime = match (meta.modified().ok(), record.mtime) {
            (Some(now), Some(then)) => now == then,
            // No mtime on either side — length is all we have.
            _ => true,
        };
        if same_len && same_mtime {
            Freshness::Fresh
        } else {
            Freshness::Stale
        }
    }

    /// Forget a path's read record. Called after a successful write so the
    /// writing tool re-registers the post-write state rather than leaving a
    /// record that now describes the old content.
    pub fn forget_read(&self, path: &Path) {
        self.reads.remove(path);
    }

    // ── Approvals + classification (D8) ─────────────────────────────────────

    /// The full pre-execution decision, called from the session's
    /// `PermissionPolicy` before the runner dispatches the tool.
    ///
    /// `input` is the *raw* tool input; coercion is applied here so that the
    /// decision sees the same fields the tool will.
    pub fn decide(&self, tool_name: &str, level: PermissionLevel, input: &Value) -> Decision {
        let coerced = super::coerce::for_schema(input.clone(), &path_probe_schema(tool_name));

        // Containment first: a path outside the workspace is refused before the
        // user is asked about it, so a prompt is never followed by a denial.
        if self.tier.contains_paths() {
            for raw in candidate_paths(tool_name, &coerced) {
                if let Err(c) = self.contain(&raw) {
                    return Decision::Deny {
                        reason: c.to_string(),
                    };
                }
            }
        }

        // An escalation re-ask: the sandbox already refused this command once
        // and the user is being asked whether to run it unconfined. Always a
        // prompt, never cacheable.
        if coerced.get(ESCALATION_MARKER).and_then(Value::as_bool) == Some(true) {
            return Decision::Prompt {
                reason: "Run this command outside the sandbox, just this once?".to_string(),
                risk: Risk::Destructive,
                cache_key: None,
            };
        }

        // Shell commands are classified per call. This is what replaces "every
        // Bash command gets one verdict": the risk comes from the command, not
        // from a constant on the tool.
        if let Some(command) = shell_command(tool_name, &coerced) {
            // An empty `TerminalWrite` sends nothing — it polls for output.
            if command.is_empty() {
                return Decision::Allow;
            }
            let verdict = classify::classify(command);
            return match verdict.risk {
                // Provably read-only and fully parsed — skip the prompt.
                Risk::Safe => Decision::Allow,
                // Destructive: prompt every time, and never cache the answer,
                // so a broad earlier approval cannot cover a narrow disaster.
                Risk::Destructive => Decision::Prompt {
                    reason: verdict.reason,
                    risk: Risk::Destructive,
                    cache_key: None,
                },
                Risk::Normal => {
                    let key = Self::cache_key(tool_name, &coerced);
                    if self.approvals.contains_key(&key) {
                        Decision::Allow
                    } else {
                        Decision::Prompt {
                            reason: verdict.reason,
                            risk: Risk::Normal,
                            cache_key: Some(key),
                        }
                    }
                }
            };
        }

        // Non-shell tools: read-only work never prompts; everything else uses
        // the cache.
        if matches!(level, PermissionLevel::None | PermissionLevel::ReadOnly) {
            return Decision::Allow;
        }
        let key = Self::cache_key(tool_name, &coerced);
        if self.approvals.contains_key(&key) {
            Decision::Allow
        } else {
            Decision::Prompt {
                reason: format!("{tool_name} modifies your workspace."),
                risk: Risk::Normal,
                cache_key: Some(key),
            }
        }
    }

    /// Store a "Allow for this session" answer. A `None` key (a destructive
    /// command) is ignored, which is what makes story 22 hold.
    pub fn remember_approval(&self, cache_key: Option<&str>) {
        if let Some(key) = cache_key {
            self.approvals.insert(key.to_string(), ());
        }
    }

    #[cfg(test)]
    pub(crate) fn approval_count(&self) -> usize {
        self.approvals.len()
    }

    /// What "Allow for this session" remembers.
    ///
    /// For a shell tool it is the command text, so approving `cargo build` does
    /// not also approve `rm -rf target`. For a file tool it is the tool name
    /// plus the target path, so approving an edit to one file does not approve
    /// edits everywhere.
    fn cache_key(tool_name: &str, input: &Value) -> String {
        if let Some(cmd) = shell_command(tool_name, input) {
            return format!("{tool_name}\u{1}{}", cmd.trim());
        }
        let paths = candidate_paths(tool_name, input).join("\u{1}");
        format!("{tool_name}\u{1}{paths}")
    }

    // ── Spill directory (D6) ────────────────────────────────────────────────

    /// This session's directory for full copies of truncated output, inside the
    /// workspace so the gate permits the model to read them.
    pub fn spill_dir(&self) -> PathBuf {
        let dir = self.root.join(SPILL_DIR).join(&self.session);
        if !self.spill_ready.swap(true, Ordering::SeqCst) {
            let _ = std::fs::create_dir_all(&dir);
        }
        dir
    }

    /// Remove this session's spill files. Called at session teardown so long
    /// sessions do not fill the user's disk (story 15). Scoped to this session's
    /// subdirectory: a second session open on the same workspace keeps its own.
    pub fn cleanup(&self) {
        if self.spill_ready.load(Ordering::SeqCst) {
            let _ = std::fs::remove_dir_all(self.spill_dir());
            // Prune the parent when this was the last session using it.
            let _ = std::fs::remove_dir(self.root.join(SPILL_DIR));
        }
    }
}

// ── Path helpers ────────────────────────────────────────────────────────────

/// Collapse `.` and `..` without touching the filesystem.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve symlinks on the longest existing ancestor of `path`, then re-append
/// the components that do not exist yet.
///
/// `std::fs::canonicalize` alone is not usable here: it requires the whole path
/// to exist, and a create-new-file edit names a path that does not.
fn resolve_symlinks(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            let mut out = real;
            for segment in tail.iter().rev() {
                out.push(segment);
            }
            return out;
        }
        let Some(name) = existing.file_name().map(|s| s.to_os_string()) else {
            return path.to_path_buf();
        };
        tail.push(name);
        if !existing.pop() {
            return path.to_path_buf();
        }
    }
}

/// Marker a tool sets when re-asking after the sandbox refused a command.
///
/// A granted escalation applies to that one call and is never cached (D1), so
/// the decision it produces carries no cache key however the user answers.
pub const ESCALATION_MARKER: &str = "__atlas_escalation";

/// Field names that carry a filesystem path, after dealiasing.
pub const PATH_FIELDS: &[&str] = &["file_path", "path", "notebook_path"];

/// A schema stand-in used when the policy coerces input without a live tool to
/// ask. Declares the canonical path fields so the alias table can fire.
fn path_probe_schema(tool_name: &str) -> Value {
    let mut props = serde_json::Map::new();
    for f in PATH_FIELDS {
        props.insert((*f).to_string(), Value::Null);
    }
    if is_shell_tool(tool_name) {
        props.insert("command".to_string(), Value::Null);
        props.insert("input".to_string(), Value::Null);
    } else {
        // Edit-shaped tools; harmless for tools that do not declare them,
        // because `for_schema` only renames into fields that are present.
        for f in ["old_string", "new_string", "replace_all", "content"] {
            props.insert(f.to_string(), Value::Null);
        }
    }
    serde_json::json!({ "type": "object", "properties": Value::Object(props) })
}

fn is_shell_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "Bash"
            | "bash"
            | "Shell"
            | "shell"
            | "PowerShell"
            | "powershell"
            | "Terminal"
            | "TerminalStart"
            | "TerminalWrite"
    )
}

/// The command text for a shell-class tool, or `None` for everything else.
///
/// `TerminalWrite` is included deliberately. Its `input` is typed into a live
/// shell, so it *is* command execution — treating it as opaque data would make
/// the persistent terminal a way to run anything under one approval.
pub fn shell_command<'a>(tool_name: &str, input: &'a Value) -> Option<&'a str> {
    if !is_shell_tool(tool_name) {
        return None;
    }
    input
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| input.get("cmd").and_then(Value::as_str))
        .or_else(|| input.get("input").and_then(Value::as_str))
}

/// Every filesystem path this tool call names, as written by the model.
///
/// Covers the declared path fields, the nested `edits` array `MultiEdit` uses,
/// and the `*** Add/Update/Delete File:` headers inside an apply-patch body —
/// the last of which is the only place a write target hides inside free text.
pub fn candidate_paths(tool_name: &str, input: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let Some(obj) = input.as_object() else {
        return out;
    };
    for field in PATH_FIELDS {
        if let Some(s) = obj.get(*field).and_then(Value::as_str) {
            out.push(s.to_string());
        }
    }
    if let Some(edits) = obj.get("edits").and_then(Value::as_array) {
        for e in edits {
            for field in PATH_FIELDS {
                if let Some(s) = e.get(*field).and_then(Value::as_str) {
                    out.push(s.to_string());
                }
            }
        }
    }
    if tool_name.eq_ignore_ascii_case("applypatch") || tool_name.eq_ignore_ascii_case("apply_patch")
    {
        for value in obj.values() {
            if let Some(text) = value.as_str() {
                out.extend(patch_paths(text));
            }
        }
    }
    out
}

/// Pull the file paths out of an apply-patch body.
fn patch_paths(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("*** ")?;
            for verb in ["Add File:", "Update File:", "Delete File:", "Move to:"] {
                if let Some(p) = rest.strip_prefix(verb) {
                    let p = p.trim();
                    if !p.is_empty() {
                        return Some(p.to_string());
                    }
                }
            }
            None
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::TmpDir;
    use serde_json::json;

    fn policy(root: &Path) -> Arc<ToolPolicy> {
        ToolPolicy::contained(root)
    }

    // ── Containment ─────────────────────────────────────────────────────────

    #[test]
    fn relative_resolves_under_root() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let got = p.contain("src/main.rs").unwrap();
        assert!(got.starts_with(p.root()));
        assert!(got.ends_with("src/main.rs"));
    }

    #[test]
    fn absolute_outside_root_denied() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let err = p.contain("/etc/hosts").unwrap_err();
        assert_eq!(err.raw, "/etc/hosts");
        assert!(err.to_string().contains("outside the workspace"));
    }

    #[test]
    fn traversal_collapsed_and_denied() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        assert!(p.contain("../../etc/passwd").is_err());
        assert!(p.contain("src/../../../etc/passwd").is_err());
    }

    #[test]
    fn traversal_that_stays_inside_is_allowed() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let got = p.contain("src/../lib/x.rs").unwrap();
        assert!(got.starts_with(p.root()));
        assert!(got.ends_with("lib/x.rs"));
    }

    #[test]
    fn absolute_inside_root_allowed() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let inside = p.root().join("a.rs");
        assert!(p.contain(&inside.to_string_lossy()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escaping_root_denied() {
        let tmp = TmpDir::new();
        let outside = TmpDir::new();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("link")).unwrap();
        let p = policy(tmp.path());
        assert!(
            p.contain("link/secret.txt").is_err(),
            "a symlink out of the workspace must be treated as outside it"
        );
    }

    #[test]
    fn same_file_three_spellings_one_key() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "x").unwrap();
        let p = policy(tmp.path());
        let a = p.resolve("a.rs");
        let b = p.resolve("./a.rs");
        let c = p.resolve(&p.root().join("a.rs").to_string_lossy());
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn approvals_only_tier_does_not_contain() {
        let tmp = TmpDir::new();
        let p = ToolPolicy::at_tier(tmp.path(), EnforcementTier::ApprovalsOnly);
        assert!(p.contain("/etc/hosts").is_ok());
    }

    // ── Read registry ───────────────────────────────────────────────────────

    #[test]
    fn write_with_no_read_record_is_never_read() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(p.check_fresh(&p.resolve("a.rs")), Freshness::NeverRead);
    }

    #[test]
    fn fresh_after_read() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x").unwrap();
        let key = p.resolve("a.rs");
        p.record_read(&key);
        assert_eq!(p.check_fresh(&key), Freshness::Fresh);
    }

    #[test]
    fn stale_when_content_changed_under_us() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x").unwrap();
        let key = p.resolve("a.rs");
        p.record_read(&key);
        // The user edits in their editor while the agent is thinking.
        std::fs::write(&f, "user's work").unwrap();
        assert_eq!(p.check_fresh(&key), Freshness::Stale);
    }

    #[test]
    fn stale_by_metadata_when_no_content_recorded() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x").unwrap();
        let key = p.resolve("a.rs");
        // A shell read registers the path.
        p.record_read(&key);
        std::fs::write(&f, "much longer content").unwrap();
        assert_eq!(p.check_fresh(&key), Freshness::Stale);
    }

    #[test]
    fn vanished_file_is_stale_not_fresh() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x").unwrap();
        let key = p.resolve("a.rs");
        p.record_read(&key);
        std::fs::remove_file(&f).unwrap();
        assert_eq!(p.check_fresh(&key), Freshness::Stale);
    }

    // ── Classification + cache ──────────────────────────────────────────────

    #[test]
    fn read_only_command_skips_the_prompt() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let d = p.decide("Bash", PermissionLevel::Execute, &json!({"command": "git status"}));
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn redirect_fails_closed_and_prompts() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let d = p.decide("Bash", PermissionLevel::Execute, &json!({"command": "ls > out.txt"}));
        assert!(matches!(d, Decision::Prompt { .. }), "{d:?}");
    }

    #[test]
    fn nothing_is_ever_blocked_by_classification() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        for cmd in [
            "rm -rf /",
            "gh repo fork",
            "cargo build --features fork",
            "chown -R me .",
            ":(){ :|:& };:",
        ] {
            let d = p.decide("Bash", PermissionLevel::Execute, &json!({"command": cmd}));
            assert!(
                !matches!(d, Decision::Deny { .. }),
                "classification must never produce a block: {cmd} -> {d:?}"
            );
        }
    }

    #[test]
    fn cache_hit_suppresses_the_repeat_prompt() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let input = json!({"command": "npm install"});
        let Decision::Prompt { cache_key, .. } =
            p.decide("Bash", PermissionLevel::Execute, &input)
        else {
            panic!("expected a prompt");
        };
        p.remember_approval(cache_key.as_deref());
        assert_eq!(
            p.decide("Bash", PermissionLevel::Execute, &input),
            Decision::Allow
        );
    }

    #[test]
    fn a_different_command_still_prompts() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let Decision::Prompt { cache_key, .. } =
            p.decide("Bash", PermissionLevel::Execute, &json!({"command": "npm install"}))
        else {
            panic!("expected a prompt");
        };
        p.remember_approval(cache_key.as_deref());
        let d = p.decide("Bash", PermissionLevel::Execute, &json!({"command": "npm publish"}));
        assert!(matches!(d, Decision::Prompt { .. }), "{d:?}");
    }

    #[test]
    fn destructive_prompts_every_time_and_is_never_cached() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let input = json!({"command": "rm -rf build"});
        let Decision::Prompt { cache_key, risk, .. } =
            p.decide("Bash", PermissionLevel::Execute, &input)
        else {
            panic!("expected a prompt");
        };
        assert_eq!(risk, Risk::Destructive);
        assert!(cache_key.is_none(), "a destructive command must not be cacheable");
        p.remember_approval(cache_key.as_deref());
        assert_eq!(p.approval_count(), 0);
        assert!(matches!(
            p.decide("Bash", PermissionLevel::Execute, &input),
            Decision::Prompt { .. }
        ));
    }

    #[test]
    fn containment_denial_beats_the_prompt() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let d = p.decide(
            "Edit",
            PermissionLevel::Write,
            &json!({"file_path": "/etc/hosts", "old_string": "a", "new_string": "b"}),
        );
        assert!(matches!(d, Decision::Deny { .. }), "{d:?}");
    }

    #[test]
    fn aliased_path_field_is_still_contained() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        // The model wrote `filePath`, not `file_path`. Coercion at the gate
        // means containment still sees it.
        let d = p.decide(
            "Edit",
            PermissionLevel::Write,
            &json!({"filePath": "/etc/hosts", "oldString": "a", "newString": "b"}),
        );
        assert!(matches!(d, Decision::Deny { .. }), "{d:?}");
    }

    #[test]
    fn read_only_tool_never_prompts() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        assert_eq!(
            p.decide("Read", PermissionLevel::ReadOnly, &json!({"file_path": "a.rs"})),
            Decision::Allow
        );
    }

    #[test]
    fn apply_patch_paths_are_contained() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let patch = "*** Begin Patch\n*** Add File: ../../../etc/evil\n+x\n*** End Patch";
        let d = p.decide("ApplyPatch", PermissionLevel::Write, &json!({"input": patch}));
        assert!(matches!(d, Decision::Deny { .. }), "{d:?}");
    }

    #[test]
    fn the_persistent_terminal_is_classified_like_any_other_shell() {
        // It was not: the name list said "Terminal" while the registry emits
        // "TerminalStart", so no command was ever classified and every start
        // shared one cache key — approve `npm run dev` once and `rm -rf ~` ran
        // unprompted for the rest of the session.
        let tmp = TmpDir::new();
        let p = policy(tmp.path());

        assert_eq!(
            p.decide("TerminalStart", PermissionLevel::Execute, &json!({"command": "git status"})),
            Decision::Allow,
            "a read-only command should not prompt here either"
        );

        let Decision::Prompt { cache_key, .. } = p.decide(
            "TerminalStart",
            PermissionLevel::Execute,
            &json!({"command": "npm run dev"}),
        ) else {
            panic!("expected a prompt");
        };
        p.remember_approval(cache_key.as_deref());

        // The approval must cover that command and nothing else.
        assert!(
            matches!(
                p.decide("TerminalStart", PermissionLevel::Execute, &json!({"command": "rm -rf /"})),
                Decision::Prompt { .. }
            ),
            "one terminal approval must not cover every later command"
        );
    }

    #[test]
    fn terminal_input_is_treated_as_command_execution() {
        // Text written into a live shell *is* a command. An empty write sends
        // nothing, so it polls without asking.
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        assert_eq!(
            p.decide("TerminalWrite", PermissionLevel::Execute, &json!({"session_id": "s", "input": ""})),
            Decision::Allow
        );
        assert!(matches!(
            p.decide(
                "TerminalWrite",
                PermissionLevel::Execute,
                &json!({"session_id": "s", "input": "rm -rf /\n"})
            ),
            Decision::Prompt { risk: Risk::Destructive, cache_key: None, .. }
        ));
    }

    #[test]
    fn an_escalation_is_always_asked_and_never_remembered() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let input = json!({ super::ESCALATION_MARKER: true, "command": "ls /etc" });
        for _ in 0..3 {
            let Decision::Prompt { cache_key, .. } =
                p.decide("Bash", PermissionLevel::Dangerous, &input)
            else {
                panic!("an escalation must always prompt");
            };
            assert!(cache_key.is_none(), "an escalation grant must not be cached");
            p.remember_approval(cache_key.as_deref());
        }
        assert_eq!(p.approval_count(), 0);
    }

    #[test]
    fn each_tier_yields_the_expected_decision_for_the_same_input() {
        let tmp = TmpDir::new();
        let escape = json!({"file_path": "/etc/hosts", "old_string": "a", "new_string": "b"});
        let cases = [
            (EnforcementTier::Contained, true),
            (EnforcementTier::ApprovalsOnly, false),
            (EnforcementTier::Legacy, false),
        ];
        for (tier, should_deny) in cases {
            let p = ToolPolicy::at_tier(tmp.path(), tier);
            let denied = matches!(
                p.decide("Edit", PermissionLevel::Write, &escape),
                Decision::Deny { .. }
            );
            assert_eq!(
                denied,
                should_deny,
                "{tier:?} should {} an out-of-workspace path",
                if should_deny { "deny" } else { "permit" }
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_workspace_reached_through_a_symlink_still_works() {
        // A project directory that is itself a symlink must not have every one
        // of its own files rejected as "outside the workspace".
        let base = TmpDir::new();
        let real = base.path().join("real-proj");
        std::fs::create_dir_all(real.join("src")).unwrap();
        std::fs::write(real.join("src/a.rs"), "x").unwrap();
        let link = base.path().join("linked-proj");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let p = ToolPolicy::contained(&link);
        assert!(p.contain("src/a.rs").is_ok());
        assert!(
            p.contain(&real.join("src/a.rs").to_string_lossy()).is_ok(),
            "the resolved path is the same file"
        );
        assert!(
            p.contain(&link.join("src/a.rs").to_string_lossy()).is_ok(),
            "so is the symlinked spelling"
        );
    }

    // ── Spill directory ─────────────────────────────────────────────────────

    #[test]
    fn one_sessions_teardown_does_not_delete_anothers_spills() {
        let tmp = TmpDir::new();
        let a = ToolPolicy::contained_for(tmp.path(), "session-a");
        let b = ToolPolicy::contained_for(tmp.path(), "session-b");
        std::fs::write(a.spill_dir().join("a.txt"), "a").unwrap();
        std::fs::write(b.spill_dir().join("b.txt"), "b").unwrap();
        assert_ne!(a.spill_dir(), b.spill_dir());
        a.cleanup();
        assert!(!a.spill_dir().exists());
        assert!(
            b.spill_dir().join("b.txt").exists(),
            "a second session open on the same workspace keeps its own output"
        );
        b.cleanup();
    }

    #[test]
    fn spill_dir_is_inside_the_workspace_and_cleans_up() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        let dir = p.spill_dir();
        assert!(dir.starts_with(p.root()));
        assert!(dir.exists());
        // Whatever the truncator writes there must be readable by the model.
        assert!(p.contain(&dir.join("x.txt").to_string_lossy()).is_ok());
        p.cleanup();
        assert!(!dir.exists());
    }

    // ── Tier reporting ──────────────────────────────────────────────────────

    #[test]
    fn tier_is_reportable() {
        let tmp = TmpDir::new();
        let p = policy(tmp.path());
        assert_eq!(p.tier(), EnforcementTier::Contained);
        assert!(!p.tier().describe().is_empty());
        assert_eq!(p.tier().as_str(), "contained");
    }
}
