//! The walk both tools share: what is inside the session root, what is
//! ignored, and what is never shown.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::types::TypesBuilder;
use ignore::{WalkBuilder, WalkParallel};

use crate::SearchError;

/// Secret files hidden from both tools unless a request names the file as its
/// `path`. Gitignore-style: a pattern without `/` matches a file name at any
/// depth; a leading `!` re-includes (so `.env.example` stays searchable).
pub const DEFAULT_DENY_GLOBS: &[&str] = &[
    ".env",
    ".env.*",
    "!.env.example",
    "*.pem",
    "*.key",
    "id_rsa*",
    "id_ed25519*",
];

/// Version-control directories, skipped even though hidden files are walked.
const VCS_DIRS: &[&str] = &[".git", ".hg", ".svn", ".jj", ".sl"];

/// Files larger than this are skipped and counted, never read.
pub(crate) const MAX_FILE_BYTES: u64 = 10 << 20;

/// Walker threads: leave a core for the UI, and never more than 8.
pub(crate) fn threads() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |n| n.get().saturating_sub(1))
        .clamp(1, 8)
}

fn is_vcs_dir(name: &OsStr) -> bool {
    VCS_DIRS.iter().any(|vcs| name == OsStr::new(vcs))
}

/// The canonical session root and the canonical place a request starts from.
/// A `path` outside the root (`../`, an absolute path elsewhere, a symlink
/// out) is refused.
pub(crate) fn resolve(root: &Path, path: Option<&Path>) -> Result<(PathBuf, PathBuf), SearchError> {
    let root = dunce::canonicalize(root).map_err(|e| {
        SearchError::Io(format!(
            "session root {} is not readable: {e}",
            root.display()
        ))
    })?;
    let Some(path) = path else {
        return Ok((root.clone(), root));
    };
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let start = dunce::canonicalize(&joined)
        .map_err(|_| SearchError::Path(format!("{} does not exist", path.display())))?;
    if !start.starts_with(&root) {
        return Err(SearchError::Path(format!(
            "{} is outside the session root {}; search inside it",
            path.display(),
            root.display()
        )));
    }
    Ok((root, start))
}

/// `path` relative to `root`, `/`-separated on every platform.
pub(crate) fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    parts.join("/")
}

/// Split each entry on commas and whitespace outside braces, so
/// `"*.rs, src/**/*.{ts,tsx}"` is two globs, not three.
pub(crate) fn split_globs(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for entry in raw {
        let mut depth = 0usize;
        let mut current = String::new();
        for c in entry.chars() {
            match c {
                '{' => {
                    depth += 1;
                    current.push(c);
                }
                '}' => {
                    depth = depth.saturating_sub(1);
                    current.push(c);
                }
                ',' | ' ' | '\t' | '\n' if depth == 0 => {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(c),
            }
        }
        if !current.is_empty() {
            out.push(current);
        }
    }
    out
}

/// The secret-file filter: [`DEFAULT_DENY_GLOBS`] or a request's own list.
pub(crate) struct DenyList {
    deny_name: GlobSet,
    deny_rel: GlobSet,
    allow_name: GlobSet,
    allow_rel: GlobSet,
}

impl DenyList {
    pub(crate) fn new(globs: &[String]) -> Result<Self, SearchError> {
        let mut deny_name = GlobSetBuilder::new();
        let mut deny_rel = GlobSetBuilder::new();
        let mut allow_name = GlobSetBuilder::new();
        let mut allow_rel = GlobSetBuilder::new();
        for raw in globs {
            let (allow, pattern) = match raw.strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, raw.as_str()),
            };
            let glob = GlobBuilder::new(pattern)
                .literal_separator(true)
                .build()
                .map_err(|e| SearchError::Glob(format!("deny glob {raw:?}: {e}")))?;
            let by_rel = pattern.contains('/');
            match (allow, by_rel) {
                (false, false) => deny_name.add(glob),
                (false, true) => deny_rel.add(glob),
                (true, false) => allow_name.add(glob),
                (true, true) => allow_rel.add(glob),
            };
        }
        let build = |b: GlobSetBuilder| b.build().map_err(|e| SearchError::Glob(e.to_string()));
        Ok(Self {
            deny_name: build(deny_name)?,
            deny_rel: build(deny_rel)?,
            allow_name: build(allow_name)?,
            allow_rel: build(allow_rel)?,
        })
    }

    /// Whether the file at `rel` (relative, `/`-separated) is hidden.
    pub(crate) fn denies(&self, rel: &str) -> bool {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let denied = self.deny_name.is_match(name) || self.deny_rel.is_match(rel);
        denied && !(self.allow_name.is_match(name) || self.allow_rel.is_match(rel))
    }
}

/// What to walk and what to leave out.
pub(crate) struct WalkSpec<'a> {
    /// Canonical session root; override globs are relative to it.
    pub root: &'a Path,
    /// Canonical directory under `root` to start from.
    pub start: &'a Path,
    pub include_ignored: bool,
    pub globs: &'a [String],
    pub file_type: Option<&'a str>,
}

/// A parallel walker over `spec`: hidden files included, `.gitignore` (inside
/// a git repo), `.ignore` and overrides honoured, VCS dirs skipped, symlinks
/// not followed.
pub(crate) fn parallel_walker(spec: &WalkSpec<'_>) -> Result<WalkParallel, SearchError> {
    let mut wb = WalkBuilder::new(spec.start);
    wb.hidden(false)
        .require_git(true)
        .follow_links(false)
        .threads(threads())
        .filter_entry(|entry| !is_vcs_dir(entry.file_name()));
    if spec.include_ignored {
        wb.git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .parents(false);
    }
    let globs = split_globs(spec.globs);
    if !globs.is_empty() {
        let mut overrides = OverrideBuilder::new(spec.root);
        for glob in &globs {
            overrides
                .add(glob)
                .map_err(|e| SearchError::Glob(format!("{glob:?}: {e}")))?;
        }
        wb.overrides(
            overrides
                .build()
                .map_err(|e| SearchError::Glob(e.to_string()))?,
        );
    }
    if let Some(file_type) = spec.file_type {
        let mut types = TypesBuilder::new();
        types.add_defaults();
        types.select(file_type);
        wb.types(types.build().map_err(|e| {
            SearchError::Glob(format!(
                "unknown file type {file_type:?} ({e}); use a ripgrep type name such as rust, ts, py, go, md"
            ))
        })?);
    }
    Ok(wb.build_parallel())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_split_on_commas_and_spaces_but_not_inside_braces() {
        assert_eq!(
            split_globs(&["*.rs, src/**/*.{ts,tsx} !vendor/**".to_string()]),
            vec!["*.rs", "src/**/*.{ts,tsx}", "!vendor/**"]
        );
    }

    #[test]
    fn the_default_deny_list_hides_secrets_and_keeps_the_example() {
        let deny = DenyList::new(
            &DEFAULT_DENY_GLOBS
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        for hidden in [
            ".env",
            "app/.env.local",
            "certs/server.pem",
            "tls.key",
            "home/id_rsa",
            "id_ed25519.pub",
        ] {
            assert!(deny.denies(hidden), "{hidden} should be hidden");
        }
        for shown in [".env.example", "src/env.rs", "keyboard.rs", "docs/id.md"] {
            assert!(!deny.denies(shown), "{shown} should be searchable");
        }
    }

    #[test]
    fn rel_paths_use_forward_slashes() {
        let root = Path::new("/r");
        assert_eq!(rel_path(root, &root.join("a").join("b.rs")), "a/b.rs");
    }
}
