//! Root-relative directory listings with a per-entry `ignored` flag, for the
//! virtualised file tree.
//!
//! Shaped for the tree: one IPC call for any number of directories, paths
//! relative to the project root, and nothing per entry beyond `path`, `kind`
//! and `ignored`. A single directory is a batch of one, so there is no
//! single-path twin.
//!
//! `ignored` comes from `.gitignore` matchers built with the `ignore` crate,
//! not from `git check-ignore`. Spawning git per directory costs a process and
//! an index read per expand. Instead each directory's `.gitignore` is parsed
//! once, cached per repository, and dropped when the file-index watcher sees
//! that `.gitignore` change ([`invalidate`]).
//!
//! One deliberate difference from git: a tracked file that matches an ignore
//! pattern reads as ignored here, where `git check-ignore` would not report
//! it. Telling the two apart means reading the index, which is the cost this
//! module exists to avoid. Dimming such a file is a cosmetic slip, not a
//! wrong answer about what git will commit.

use ignore::gitignore::{gitconfig_excludes_path, Gitignore, GitignoreBuilder};
use ignore::Match;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    /// Not followed: the tree does not expand through links, which keeps it
    /// inside the project and out of cycles.
    Symlink,
}

#[derive(Debug, Serialize)]
pub struct DirEntryWire {
    /// Relative to the project root, `/`-separated.
    pub path: String,
    pub kind: EntryKind,
    /// Omitted when false, which is nearly every entry.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignored: bool,
}

#[derive(Debug, Serialize)]
pub struct DirListing {
    /// The directory as requested (root-relative, `""` for the root).
    pub path: String,
    pub entries: Vec<DirEntryWire>,
    /// Set when this one directory could not be read (deleted since, not a
    /// directory, outside the root). The rest of the batch still answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// List several directories under `root` in one call. `paths` are relative to
/// `root` (`""` is the root itself). Entries come back directories first, then
/// by case-insensitive name; `.git` is never listed.
#[tauri::command]
pub async fn read_directories(root: String, paths: Vec<String>) -> Result<Vec<DirListing>, String> {
    tokio::task::spawn_blocking(move || {
        // Canonical from here on: the containment check below compares real
        // paths, and the ignore cache and the watcher (which reports real
        // paths, `/private/tmp` for `/tmp`) must agree on one spelling.
        let root = std::fs::canonicalize(&root).map_err(|e| format!("{root}: {e}"))?;
        if !root.is_dir() {
            return Err(format!("Not a directory: {}", root.display()));
        }
        let ignores = repo_ignores(&root);
        Ok(paths
            .into_iter()
            .map(|rel| match list_one(&root, &rel, ignores.as_deref()) {
                Ok(entries) => DirListing {
                    path: rel,
                    entries,
                    error: None,
                },
                Err(e) => DirListing {
                    path: rel,
                    entries: Vec::new(),
                    error: Some(e),
                },
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A root-relative path is only accepted when it names something strictly
/// inside the root and outside `.git`.
fn safe_relative(rel: &str) -> Result<&Path, String> {
    let p = Path::new(rel);
    for c in p.components() {
        match c {
            Component::Normal(n) if is_dot_git(n) => {
                return Err(format!("Refusing to list inside .git: {rel}"));
            }
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("Path must be relative to the project root: {rel}")),
        }
    }
    Ok(p)
}

/// `.git`, spelled any way the filesystem treats as the same name: APFS and
/// NTFS are case-insensitive, so `.GIT` opens the same directory there.
fn is_dot_git(name: &std::ffi::OsStr) -> bool {
    if cfg!(any(target_os = "macos", windows)) {
        name.to_str()
            .is_some_and(|n| n.eq_ignore_ascii_case(".git"))
    } else {
        name == ".git"
    }
}

/// `root` must be canonical.
fn list_one(
    root: &Path,
    rel: &str,
    ignores: Option<&RepoIgnores>,
) -> Result<Vec<DirEntryWire>, String> {
    let rel_path = safe_relative(rel)?;
    // Resolved, so a symlinked directory cannot walk the listing out of the
    // project (or into its `.git`) however the request spells it.
    let dir = std::fs::canonicalize(root.join(rel_path)).map_err(|e| format!("{rel}: {e}"))?;
    if !dir.starts_with(root) {
        return Err(format!("{rel} resolves outside the project root"));
    }
    if dir
        .strip_prefix(root)
        .is_ok_and(|r| r.components().any(|c| is_dot_git(c.as_os_str())))
    {
        return Err(format!("Refusing to list inside .git: {rel}"));
    }
    let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    // Prefix for every child's wire path, built once.
    let prefix = rel.trim_matches('/');
    // Everything below an ignored directory is ignored (git never descends
    // into one, so a `!pattern` further down cannot re-include it).
    let dir_ignored = ignores.is_some_and(|ig| ig.dir_is_ignored(&dir));
    // One buffer reused for every child's absolute path: matching needs a
    // path, and this avoids building one per entry.
    let mut scratch = dir;

    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name();
        if is_dot_git(&name) {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let kind = if ft.is_symlink() {
            EntryKind::Symlink
        } else if ft.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        let ignored = dir_ignored
            || ignores.is_some_and(|ig| {
                scratch.push(&name);
                let hit = ig.is_ignored(&scratch, kind == EntryKind::Directory);
                scratch.pop();
                hit
            });
        let name = name.to_string_lossy();
        let path = if prefix.is_empty() {
            name.into_owned()
        } else {
            let mut s = String::with_capacity(prefix.len() + 1 + name.len());
            s.push_str(prefix);
            s.push('/');
            s.push_str(&name);
            s
        };
        entries.push(DirEntryWire {
            path,
            kind,
            ignored,
        });
    }

    entries.sort_unstable_by(|a, b| {
        let a_dir = a.kind == EntryKind::Directory;
        let b_dir = b.kind == EntryKind::Directory;
        b_dir
            .cmp(&a_dir)
            .then_with(|| cmp_name_ci(file_name(&a.path), file_name(&b.path)))
    });
    Ok(entries)
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Case-insensitive compare without lowercasing into new strings; byte order
/// breaks ties so the sort is total.
fn cmp_name_ci(a: &str, b: &str) -> std::cmp::Ordering {
    a.chars()
        .flat_map(char::to_lowercase)
        .cmp(b.chars().flat_map(char::to_lowercase))
        .then_with(|| a.cmp(b))
}

// ── Ignore matchers ─────────────────────────────────────────────────────────

/// Every ignore source for one repository, parsed lazily and kept.
pub struct RepoIgnores {
    /// The working-tree top (the directory holding `.git`).
    top: PathBuf,
    /// `.git/info/exclude`, rooted at `top`.
    exclude: Option<Gitignore>,
    /// `core.excludesFile`, rooted at `top`.
    global: Option<Gitignore>,
    /// Absolute directory → its `.gitignore`, `None` when it has none. Only
    /// directories something has asked about are ever here.
    per_dir: Mutex<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
}

impl RepoIgnores {
    fn new(top: PathBuf, git_dir: Option<PathBuf>) -> Self {
        let build = |file: PathBuf| -> Option<Gitignore> {
            if !file.is_file() {
                return None;
            }
            let mut b = GitignoreBuilder::new(&top);
            let _ = b.add(file);
            b.build().ok().filter(|g| !g.is_empty())
        };
        let exclude = git_dir.and_then(|d| build(d.join("info").join("exclude")));
        let global = gitconfig_excludes_path().and_then(build);
        Self {
            top,
            exclude,
            global,
            per_dir: Mutex::new(HashMap::new()),
        }
    }

    fn matcher_for(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        if let Some(hit) = self.per_dir.lock().get(dir) {
            return hit.clone();
        }
        // Parse outside the lock; two racing parses of one file are harmless.
        let file = dir.join(".gitignore");
        let parsed = if file.is_file() {
            let mut b = GitignoreBuilder::new(dir);
            let _ = b.add(&file);
            b.build().ok().filter(|g| !g.is_empty()).map(Arc::new)
        } else {
            None
        };
        self.per_dir
            .lock()
            .insert(dir.to_path_buf(), parsed.clone());
        parsed
    }

    /// Whether `path` (absolute, under `top`) is ignored on its own merits.
    /// Git's precedence: the deepest `.gitignore` with an opinion wins, then
    /// `info/exclude`, then `core.excludesFile`.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        let mut dir = path.parent();
        while let Some(d) = dir {
            if let Some(m) = self.matcher_for(d) {
                match m.matched(path, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if d == self.top || !d.starts_with(&self.top) {
                break;
            }
            dir = d.parent();
        }
        for m in [&self.exclude, &self.global].into_iter().flatten() {
            match m.matched(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }

    /// Whether `dir` or any directory between it and `top` is ignored.
    pub fn dir_is_ignored(&self, dir: &Path) -> bool {
        let Ok(rel) = dir.strip_prefix(&self.top) else {
            return false;
        };
        let mut cur = self.top.clone();
        for c in rel.components() {
            cur.push(c);
            if self.is_ignored(&cur, true) {
                return true;
            }
        }
        false
    }

    fn forget(&self, dirs: &[PathBuf]) {
        let mut map = self.per_dir.lock();
        for d in dirs {
            map.remove(d);
        }
    }
}

/// Canonical project root → its repository's matchers. Only roots inside a
/// repository are kept, so a later `git init` is seen on the next call.
type IgnoreCache = Mutex<HashMap<PathBuf, Arc<RepoIgnores>>>;

fn cache() -> &'static IgnoreCache {
    static CACHE: OnceLock<IgnoreCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The repository containing `root`, or `None` outside one. Like the
/// file index's walker (`require_git`), `.gitignore` only counts inside a
/// repository.
fn find_repo(root: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    let mut dir = Some(root);
    while let Some(d) = dir {
        let dot_git = d.join(".git");
        if dot_git.is_dir() {
            return Some((d.to_path_buf(), Some(dot_git)));
        }
        if dot_git.is_file() {
            // A linked worktree or submodule: `.git` is `gitdir: <path>`, and
            // `info/exclude` lives in the common dir it points at.
            let git_dir = std::fs::read_to_string(&dot_git).ok().and_then(|s| {
                let p = s.strip_prefix("gitdir:")?.trim();
                let p = d.join(p);
                let common = std::fs::read_to_string(p.join("commondir"))
                    .ok()
                    .map(|c| p.join(c.trim()));
                Some(common.unwrap_or(p))
            });
            return Some((d.to_path_buf(), git_dir));
        }
        dir = d.parent();
    }
    None
}

/// The cached matchers for the repository holding `root` (canonical). Keyed
/// by the project root, so the walk up to `.git` happens once per root.
pub fn repo_ignores(root: &Path) -> Option<Arc<RepoIgnores>> {
    if let Some(hit) = cache().lock().get(root) {
        return Some(hit.clone());
    }
    let (top, git_dir) = find_repo(root)?;
    let built = Arc::new(RepoIgnores::new(top, git_dir));
    Some(
        cache()
            .lock()
            .entry(root.to_path_buf())
            .or_insert(built)
            .clone(),
    )
}

/// Drop cached matchers after the watcher saw `paths` change under `root`.
/// A changed `.gitignore` drops its own directory's matcher. `all` (an opaque
/// rename the watcher cannot pin down) drops the repository's whole entry,
/// `info/exclude` and the global excludes included, to be rebuilt on demand.
pub fn invalidate<'a>(root: &Path, paths: impl IntoIterator<Item = &'a Path>, all: bool) {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let related = |key: &PathBuf| key.starts_with(&root) || root.starts_with(key);
    if all {
        cache().lock().retain(|key, _| !related(key));
        return;
    }
    let dirs: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| is_gitignore(p))
        .filter_map(|p| p.parent())
        .map(|d| std::fs::canonicalize(d).unwrap_or_else(|_| d.to_path_buf()))
        .collect();
    if dirs.is_empty() {
        return;
    }
    let repos: Vec<Arc<RepoIgnores>> = cache()
        .lock()
        .iter()
        .filter(|(key, _)| related(key))
        .map(|(_, v)| v.clone())
        .collect();
    for repo in repos {
        repo.forget(&dirs);
    }
}

pub fn is_gitignore(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == ".gitignore")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "atlas-fs-entries-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(p.join(".git").join("info")).unwrap();
            // As `read_directories` hands it on: canonical.
            Self(std::fs::canonicalize(p).unwrap())
        }
        fn file(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        fn list(&self, rel: &str) -> Vec<(String, EntryKind, bool)> {
            let ig = repo_ignores(&self.0);
            list_one(&self.0, rel, ig.as_deref())
                .unwrap()
                .into_iter()
                .map(|e| (e.path, e.kind, e.ignored))
                .collect()
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            cache().lock().remove(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ignored_of(list: &[(String, EntryKind, bool)], path: &str) -> bool {
        list.iter()
            .find(|(p, _, _)| p == path)
            .unwrap_or_else(|| panic!("{path} not listed in {list:?}"))
            .2
    }

    #[test]
    fn flags_ignored_entries_and_hides_dot_git() {
        let t = Tmp::new("flags");
        t.file(".gitignore", "target/\n*.log\n");
        t.file("target/debug/x", "");
        t.file("src/main.rs", "");
        t.file("build.log", "");
        t.file("README.md", "");
        let list = t.list("");
        assert!(list.iter().all(|(p, _, _)| p != ".git"));
        assert!(ignored_of(&list, "target"));
        assert!(ignored_of(&list, "build.log"));
        assert!(!ignored_of(&list, "src"));
        assert!(!ignored_of(&list, "README.md"));
        // Directories first, then names.
        let names: Vec<_> = list.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(
            names,
            ["src", "target", ".gitignore", "build.log", "README.md"]
        );
        // Everything under an ignored directory is ignored.
        let inner = t.list("target");
        assert_eq!(
            inner,
            [("target/debug".to_string(), EntryKind::Directory, true)]
        );
    }

    #[test]
    fn nested_gitignore_overrides_and_scopes() {
        let t = Tmp::new("nested");
        t.file(".gitignore", "*.gen.ts\n");
        t.file("pkg/.gitignore", "!keep.gen.ts\nout/\n");
        t.file("pkg/keep.gen.ts", "");
        t.file("pkg/drop.gen.ts", "");
        t.file("pkg/out/a.js", "");
        t.file("out/b.js", "");
        let pkg = t.list("pkg");
        assert!(!ignored_of(&pkg, "pkg/keep.gen.ts"));
        assert!(ignored_of(&pkg, "pkg/drop.gen.ts"));
        assert!(ignored_of(&pkg, "pkg/out"));
        // `pkg/.gitignore`'s `out/` does not reach the root's `out`.
        assert!(!ignored_of(&t.list(""), "out"));
    }

    #[test]
    fn info_exclude_applies_and_a_gitignore_edit_is_seen_after_invalidate() {
        let t = Tmp::new("invalidate");
        t.file(".git/info/exclude", "secret.txt\n");
        t.file("secret.txt", "");
        t.file("notes.md", "");
        assert!(ignored_of(&t.list(""), "secret.txt"));
        assert!(!ignored_of(&t.list(""), "notes.md"));

        t.file(".gitignore", "notes.md\n");
        // Cached: the old answer stands until the watcher says otherwise.
        assert!(!ignored_of(&t.list(""), "notes.md"));
        let gi = t.0.join(".gitignore");
        invalidate(&t.0, [gi.as_path()], false);
        assert!(ignored_of(&t.list(""), "notes.md"));
    }

    #[test]
    fn rejects_paths_that_leave_the_root() {
        let t = Tmp::new("escape");
        assert!(list_one(&t.0, "../", None).is_err());
        assert!(list_one(&t.0, "/etc", None).is_err());
        assert!(list_one(&t.0, ".git", None).is_err());
        if cfg!(target_os = "macos") {
            assert!(list_one(&t.0, ".GIT", None).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_walk_the_listing_out_of_the_root() {
        let t = Tmp::new("symlink");
        let outside = Tmp::new("symlink-target");
        outside.file("secret.txt", "");
        std::os::unix::fs::symlink(&outside.0, t.0.join("out")).unwrap();
        std::os::unix::fs::symlink(t.0.join(".git"), t.0.join("g")).unwrap();
        t.file("inside/a.txt", "");
        std::os::unix::fs::symlink(t.0.join("inside"), t.0.join("in")).unwrap();
        assert!(list_one(&t.0, "out", None).is_err());
        assert!(list_one(&t.0, "g", None).is_err());
        let listed = list_one(&t.0, "in", None).unwrap();
        assert_eq!(listed[0].path, "in/a.txt");
    }

    #[test]
    fn a_root_outside_a_repo_is_not_cached_so_git_init_is_seen() {
        let t = Tmp::new("late-init");
        std::fs::remove_dir_all(t.0.join(".git")).unwrap();
        t.file(".gitignore", "x.log\n");
        t.file("x.log", "");
        // Not a repository yet: nothing is ignored, and nothing is cached.
        assert!(!ignored_of(&t.list(""), "x.log"));
        assert!(!cache().lock().contains_key(&t.0));
        std::fs::create_dir_all(t.0.join(".git")).unwrap();
        assert!(ignored_of(&t.list(""), "x.log"));
    }

    #[test]
    fn a_full_invalidate_rebuilds_info_exclude_too() {
        let t = Tmp::new("full");
        t.file("a.txt", "");
        assert!(!ignored_of(&t.list(""), "a.txt"));
        t.file(".git/info/exclude", "a.txt\n");
        assert!(!ignored_of(&t.list(""), "a.txt"), "cached until told");
        invalidate(&t.0, std::iter::empty(), true);
        assert!(ignored_of(&t.list(""), "a.txt"));
    }
}
