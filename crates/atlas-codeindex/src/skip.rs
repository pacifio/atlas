//! What the symbol index leaves out, and why.
//!
//! Grep still searches all of it (00-overview decision 3); only the symbol,
//! chunk and embedding indexes skip vendored, generated, minified and huge
//! files. A project-root `.atlasignore` (gitignore syntax) adds exclusions,
//! and its `!pattern` lines re-include something a built-in rule skipped.
//!
//! [`IgnoreChain`] answers "would the walk have ignored this path?" for a
//! single path from the watcher, without walking.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;

/// Files above this are never parsed (minified bundles, generated blobs, logs).
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// How much of a file the content checks look at.
const SNIFF_BYTES: usize = 64 * 1024;
/// Average line length above which a file counts as minified.
const MINIFIED_AVG_LINE: usize = 300;

/// Directory names skipped at any depth unless `.atlasignore` re-includes them.
/// Atlas's own directories are skipped too (see [`is_skip_dir`]).
pub(crate) const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "vendor",
    "third_party",
    "third-party",
    "Pods",
    "Carthage",
    "target",
    "dist",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    "__generated__",
];

/// File-name patterns that mark generated code.
const GENERATED_SUFFIXES: &[&str] = &[
    ".min.js",
    ".min.mjs",
    ".min.cjs",
    ".pb.go",
    ".pb.gw.go",
    "_pb2.py",
    "_pb2_grpc.py",
    ".gen.go",
    "_generated.go",
    "_generated.rs",
    ".generated.ts",
    ".generated.tsx",
    ".generated.js",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SkipReason {
    /// Under a vendored / dependency / build directory.
    Vendor,
    /// A generated-code file name (`*.pb.go`, `*_pb2.py`, `*.min.js`, …).
    GeneratedName,
    /// A generated-code marker in the first lines.
    GeneratedHeader,
    Minified,
    TooLarge,
    Binary,
    /// Excluded by `.atlasignore`.
    AtlasIgnore,
    /// The parser gave up (time budget); the file is recorded as partial.
    ParseTimeout,
}

impl SkipReason {
    pub fn label(self) -> &'static str {
        match self {
            Self::Vendor => "vendor",
            Self::GeneratedName => "generated_name",
            Self::GeneratedHeader => "generated_header",
            Self::Minified => "minified",
            Self::TooLarge => "too_large",
            Self::Binary => "binary",
            Self::AtlasIgnore => "atlasignore",
            Self::ParseTimeout => "parse_timeout",
        }
    }
}

/// Path rules: built-in skips plus the project's `.atlasignore`.
pub(crate) struct Rules {
    atlasignore: Gitignore,
    /// The patterns of `.atlasignore`'s `!` lines: a skipped directory one of
    /// them can reach must still be walked to find what it re-includes.
    reincludes: Vec<String>,
}

impl Rules {
    pub(crate) fn load(root: &Path) -> Self {
        let file = root.join(".atlasignore");
        let mut builder = GitignoreBuilder::new(root);
        let mut reincludes = Vec::new();
        if let Ok(text) = std::fs::read_to_string(&file) {
            reincludes = text
                .lines()
                .filter_map(|l| l.trim().strip_prefix('!'))
                .map(str::to_string)
                .collect();
            for line in text.lines() {
                // A bad pattern is skipped, never fatal.
                let _ = builder.add_line(Some(file.clone()), line);
            }
        }
        Self {
            atlasignore: builder.build().unwrap_or_else(|_| Gitignore::empty()),
            reincludes,
        }
    }

    /// Why the file at `rel` (project-relative, `/`-separated) is skipped, or
    /// `None` to index it.
    ///
    /// A `!` line lifts only the built-in rule it negates: the skipped
    /// directories at or above the path it re-includes (`!vendor/ours/` lifts
    /// `vendor`), and the generated-name rule only when it names the file
    /// itself. `node_modules`, `target`, generated files and the rest still
    /// apply inside a re-included tree.
    pub(crate) fn path_verdict(&self, rel: &str) -> Option<SkipReason> {
        let lifted = match self.atlasignore.matched_path_or_any_parents(rel, false) {
            Match::Ignore(_) => return Some(SkipReason::AtlasIgnore),
            Match::Whitelist(_) => self.reincluded_depth(rel),
            Match::None => 0,
        };
        let mut parts = rel.split('/').collect::<Vec<_>>();
        let file = parts.pop().unwrap_or(rel);
        if parts
            .iter()
            .enumerate()
            .any(|(i, d)| i >= lifted && is_skip_dir(d))
        {
            return Some(SkipReason::Vendor);
        }
        if lifted <= parts.len()
            && (GENERATED_SUFFIXES.iter().any(|s| file.ends_with(s))
                || file.starts_with("zz_generated")
                || file.contains(".generated."))
        {
            return Some(SkipReason::GeneratedName);
        }
        None
    }

    /// How many leading components of `rel` (a file) the deepest `!` line
    /// matching it or one of its directories covers: 2 for `vendor/ours/a.rs`
    /// under `!vendor/ours/`, all of them for a line naming the file.
    fn reincluded_depth(&self, rel: &str) -> usize {
        let parts: Vec<&str> = rel.split('/').collect();
        (1..=parts.len())
            .rev()
            .find(|&k| {
                let prefix = parts[..k].join("/");
                matches!(
                    self.atlasignore.matched(&prefix, k < parts.len()),
                    Match::Whitelist(_)
                )
            })
            .unwrap_or(0)
    }

    /// Whether the walk may skip the directory at `rel` entirely. A skipped
    /// directory inside a re-included tree (`vendor/ours/node_modules` under
    /// `!vendor/ours/`) is pruned: the re-include does not lift its rule.
    pub(crate) fn prune_dir(&self, rel: &str) -> bool {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let skipped = is_skip_dir(name)
            || matches!(
                self.atlasignore.matched_path_or_any_parents(rel, true),
                Match::Ignore(_)
            );
        skipped && !self.reincludes.iter().any(|p| may_reach(p, rel))
    }
}

/// Version-control directories: pruned, never counted as skipped code.
const VCS_DIRS: &[&str] = &[".git", ".hg", ".svn"];

impl Rules {
    /// Why a directory [`Rules::prune_dir`] pruned was skipped, for the
    /// skipped counts; `None` for version-control and Atlas's own directories,
    /// which hold no project code.
    pub(crate) fn prune_reason(&self, rel: &str) -> Option<SkipReason> {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if VCS_DIRS.contains(&name) || atlas_search::is_atlas_dir(name) {
            return None;
        }
        match self.atlasignore.matched_path_or_any_parents(rel, true) {
            Match::Ignore(_) => Some(SkipReason::AtlasIgnore),
            _ => Some(SkipReason::Vendor),
        }
    }
}

/// Whether the walk descends into `name` when counting a pruned directory's
/// files: everything but version-control and Atlas's own directories.
pub(crate) fn counted_dir(name: &str) -> bool {
    !VCS_DIRS.contains(&name) && !atlas_search::is_atlas_dir(name)
}

/// Skipped files grouped as `(reason, directory, count)`, sorted by reason
/// then directory. A [`SkipReason::Vendor`] file counts under the directory
/// the built-in rule matched (`web/node_modules`); any other under its
/// top-level directory (`.` for a file at the root).
pub fn skipped_by_dir(skipped: &[(String, SkipReason)]) -> Vec<(String, String, usize)> {
    let mut counts: std::collections::BTreeMap<(&str, String), usize> = Default::default();
    for (rel, reason) in skipped {
        let parts: Vec<&str> = rel.split('/').collect();
        let dirs = &parts[..parts.len().saturating_sub(1)];
        let dir = match reason {
            SkipReason::Vendor => dirs
                .iter()
                .position(|d| is_skip_dir(d))
                .map(|i| dirs[..=i].join("/")),
            _ => None,
        }
        .unwrap_or_else(|| dirs.first().map_or(".", |d| d).to_string());
        *counts.entry((reason.label(), dir)).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|((r, d), n)| (r.to_string(), d, n))
        .collect()
}

/// A built-in skipped directory name: [`SKIP_DIRS`] or Atlas's own.
fn is_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || atlas_search::is_atlas_dir(name)
}

/// Whether re-include `pattern` (a `!` line without the `!`) can lift the skip
/// of directory `dir`: it names `dir` itself or something below it. Gitignore
/// rules: a pattern with no inner `/` matches at any depth; otherwise it is
/// anchored at the project root and compared component by component (a glob
/// component or `**` may match). A pattern that ends above `dir` re-includes
/// an ancestor, which leaves `dir`'s own skip in force.
fn may_reach(pattern: &str, dir: &str) -> bool {
    let p = pattern.trim_end_matches('/');
    if !p.contains('/') {
        return true;
    }
    let mut parts = p.trim_start_matches('/').split('/');
    for d in dir.split('/') {
        match parts.next() {
            // `dir` lies inside what the pattern names: its own skip stands.
            None => return false,
            // `**` spans it.
            Some("**") => return true,
            Some(c) if c == d || c.contains(['*', '?', '[']) => {}
            Some(_) => return false,
        }
    }
    true
}

/// Content checks, run on the bytes read for hashing.
pub(crate) fn sniff(bytes: &[u8]) -> Option<SkipReason> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Some(SkipReason::TooLarge);
    }
    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if head[..head.len().min(8 * 1024)].contains(&0) {
        return Some(SkipReason::Binary);
    }
    if has_generated_header(head) {
        return Some(SkipReason::GeneratedHeader);
    }
    let lines = head.iter().filter(|&&b| b == b'\n').count() + 1;
    if head.len() >= 2048 && head.len() / lines > MINIFIED_AVG_LINE {
        return Some(SkipReason::Minified);
    }
    None
}

/// A comment line among the first five carrying a generator's marker:
/// `@generated`, `DO NOT EDIT`, or Go's `Code generated … DO NOT EDIT.`.
fn has_generated_header(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(&head[..head.len().min(4096)]);
    text.lines().take(5).any(|line| {
        let l = line.trim_start();
        let comment = ["//", "#", "/*", "*", "--", "\"\"\""]
            .iter()
            .any(|p| l.starts_with(p));
        comment
            && (l.contains("@generated")
                || l.contains("DO NOT EDIT")
                || l.contains("Code generated"))
    })
}

/// Gitignore semantics for one path at a time, matching the reconcile
/// walker's: per-directory `.gitignore` and `.ignore` (deepest wins), up
/// through the directories above the root to the repository's top, then
/// `.git/info/exclude`, then the user's global excludes. Matchers are cached
/// per directory and dropped by [`IgnoreChain::new`] when an ignore file
/// changes.
pub(crate) struct IgnoreChain {
    root: PathBuf,
    /// Directories above `root` up to the repository top, nearest first
    /// (empty when the root is the top, or not in a repository).
    above: Vec<PathBuf>,
    /// Anchored at the repository top, as git anchors it.
    exclude: Gitignore,
    global: Gitignore,
    per_dir: Mutex<HashMap<PathBuf, Arc<Gitignore>>>,
}

impl IgnoreChain {
    pub(crate) fn new(root: &Path) -> Self {
        let top = repo_top(root);
        let above: Vec<PathBuf> = match &top {
            Some(top) if top.as_path() != root => root
                .ancestors()
                .skip(1)
                .take_while(|d| d.starts_with(top))
                .map(Path::to_path_buf)
                .collect(),
            _ => Vec::new(),
        };
        let mut exclude = GitignoreBuilder::new(top.as_deref().unwrap_or(root));
        if let Some(git_dir) = git_common_dir(root) {
            let _ = exclude.add(git_dir.join("info").join("exclude"));
        }
        Self {
            root: root.to_path_buf(),
            above,
            exclude: exclude.build().unwrap_or_else(|_| Gitignore::empty()),
            global: Gitignore::global().0,
            per_dir: Mutex::new(HashMap::new()),
        }
    }

    fn dir_matcher(&self, dir: &Path) -> Arc<Gitignore> {
        let mut cache = self
            .per_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(m) = cache.get(dir) {
            return m.clone();
        }
        let mut b = GitignoreBuilder::new(dir);
        for name in [".gitignore", ".ignore"] {
            let p = dir.join(name);
            if p.is_file() {
                let _ = b.add(p);
            }
        }
        let m = Arc::new(b.build().unwrap_or_else(|_| Gitignore::empty()));
        cache.insert(dir.to_path_buf(), m.clone());
        m
    }

    /// Whether `rel` (relative to the root) is ignored by git rules.
    pub(crate) fn is_ignored(&self, rel: &str, is_dir: bool) -> bool {
        let rel_path = Path::new(rel);
        let abs = self.root.join(rel_path);
        let mut dirs: Vec<PathBuf> = Vec::new();
        let mut cur = rel_path.parent();
        while let Some(d) = cur {
            dirs.push(self.root.join(d));
            cur = d.parent();
        }
        // `dirs` runs deepest-first through the root itself, then above it.
        dirs.extend(self.above.iter().cloned());
        for dir in dirs {
            let Ok(sub) = abs.strip_prefix(&dir).map(Path::to_path_buf) else {
                continue;
            };
            match self
                .dir_matcher(&dir)
                .matched_path_or_any_parents(&sub, is_dir)
            {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        // `exclude` strips its own root (the repository top) from `abs`.
        for (m, path) in [(&self.exclude, abs.as_path()), (&self.global, rel_path)] {
            match m.matched_path_or_any_parents(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }
}

/// The repository's top-level directory: the nearest directory at or above
/// `root` holding `.git` (a directory, or a worktree's file).
fn repo_top(root: &Path) -> Option<PathBuf> {
    root.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The directory holding `info/exclude`: `<root>/.git`, or for a linked
/// worktree the common dir its `gitdir` points at. Searched upward so a
/// project inside a repository finds the repository's.
pub(crate) fn git_common_dir(root: &Path) -> Option<PathBuf> {
    let mut dir = Some(root);
    while let Some(d) = dir {
        let dot_git = d.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        if dot_git.is_file() {
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let gitdir = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
            let gitdir = d.join(gitdir);
            return Some(match std::fs::read_to_string(gitdir.join("commondir")) {
                Ok(common) => gitdir.join(common.trim()),
                Err(_) => gitdir,
            });
        }
        dir = d.parent();
    }
    None
}
