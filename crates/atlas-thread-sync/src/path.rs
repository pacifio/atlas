//! Paths inside a thread's worktree.
//!
//! The server validates every path before journaling it (`isForbiddenThreadSegment`
//! in `@atlas/contracts`); this is the same rule, checked again before anything
//! is written to disk, because a replica must not trust the wire with its
//! filesystem. Keep the two in step: the ignorable table below is the server's
//! `THREAD_PATH_IGNORABLE_RANGES`.

use std::path::{Component, Path, PathBuf};

/// Code points some filesystems ignore in names (HFS+ drops several, which is
/// how `.g\u{200c}it` named `.git` there — CVE-2014-9390), plus the rest of
/// Unicode's default-ignorable set.
const IGNORABLE: &[(u32, u32)] = &[
    (0x00ad, 0x00ad),
    (0x034f, 0x034f),
    (0x061c, 0x061c),
    (0x115f, 0x1160),
    (0x17b4, 0x17b5),
    (0x180b, 0x180f),
    (0x200b, 0x200f),
    (0x202a, 0x202e),
    (0x2060, 0x206f),
    (0x3164, 0x3164),
    (0xfe00, 0xfe0f),
    (0xfeff, 0xfeff),
    (0xffa0, 0xffa0),
    (0xfff0, 0xfff8),
    (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a),
    (0xe0000, 0xe0fff),
];

fn is_ignorable(cp: u32) -> bool {
    IGNORABLE.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp))
}

/// The server's `isForbiddenThreadSegment`, transcribed.
pub fn is_forbidden_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return true;
    }
    for ch in segment.chars() {
        let cp = ch as u32;
        if cp < 0x20 || cp == 0x7f || ch == ':' || is_ignorable(cp) {
            return true;
        }
        // Non-ASCII letters that case-fold into ASCII on some filesystem.
        if matches!(cp, 0x0131 | 0x0130 | 0x212a | 0x017f) {
            return true;
        }
    }
    let lower = segment.to_lowercase();
    let folded = lower.trim_end_matches(['.', ' ']);
    folded.is_empty()
        || folded == ".git"
        || folded
            .strip_prefix("git~")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Is `path` a relative, POSIX-separated path a thread may hold?
pub fn is_valid(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.contains('\\')
        && path.split('/').all(|seg| !is_forbidden_segment(seg))
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("not a path a thread may hold: {0:?}")]
    Invalid(String),
    #[error("{0} passes through a symbolic link")]
    Symlink(PathBuf),
}

/// Where `rel` lives under `root`, refusing anything that would land outside
/// it — an invalid path, or one whose existing ancestors include a symlink a
/// write could follow out of the worktree.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    if !is_valid(rel) {
        return Err(PathError::Invalid(rel.to_string()));
    }
    let mut at = root.to_path_buf();
    for seg in rel.split('/') {
        at.push(seg);
        if let Ok(meta) = std::fs::symlink_metadata(&at) {
            if meta.file_type().is_symlink() {
                return Err(PathError::Symlink(at));
            }
        }
    }
    Ok(at)
}

/// The thread path of `abs` under `root`, with forward slashes, if it is one a
/// thread may hold. Paths under `.git` and our own temporary files are `None`.
pub fn relative(root: &Path, abs: &Path) -> Option<String> {
    let rest = abs.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rest.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            _ => return None,
        }
    }
    let joined = parts.join("/");
    if parts.last().is_some_and(|name| {
        name.starts_with(crate::replica::TEMP_PREFIX) || name.contains(crate::replica::ASIDE_MARK)
    }) {
        return None;
    }
    is_valid(&joined).then_some(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agrees_with_the_server_on_what_is_forbidden() {
        for bad in [
            "../etc/passwd",
            "/abs",
            ".git/config",
            "a//b",
            ".GIT/config",
            "src/.git/hooks/pre-commit",
            ".git./config",
            ".git /config",
            "GIT~1/config",
            "notes.txt:secret",
            "C:/Windows/x",
            "tab\there",
            ".g\u{200c}it/config",
            ".g\u{131}t/config",
            "\u{feff}.git/x",
            "a\\b",
        ] {
            assert!(!is_valid(bad), "{bad:?} should be refused");
        }
        for good in [
            "README.md",
            "src/banner.css",
            ".gitignore",
            ".github/workflows/ci.yml",
            "git~notes",
            "a.b/c d",
        ] {
            assert!(is_valid(good), "{good:?} should be allowed");
        }
    }

    #[test]
    fn refuses_to_resolve_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
            assert!(matches!(
                resolve(dir.path(), "link/x.txt"),
                Err(PathError::Symlink(_))
            ));
        }
        assert_eq!(
            resolve(dir.path(), "a/b.txt").unwrap(),
            dir.path().join("a").join("b.txt")
        );
    }

    #[test]
    fn relative_skips_git_and_temp_files() {
        let root = Path::new("/w");
        assert_eq!(
            relative(root, Path::new("/w/src/a.rs")).as_deref(),
            Some("src/a.rs")
        );
        assert_eq!(relative(root, Path::new("/w/.git/index")), None);
        assert_eq!(relative(root, Path::new("/w/src/.atlas-sync-tmp-1")), None);
        // A file of the person's set aside for a remote change never syncs.
        assert_eq!(relative(root, Path::new("/w/src/a.rs.atlas-mine")), None);
        assert_eq!(relative(root, Path::new("/w/src/a.rs.atlas-mine-2")), None);
        assert_eq!(relative(root, Path::new("/elsewhere/a")), None);
    }
}
