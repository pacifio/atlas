//! Thread Versions on the desktop (ADR-0022, ATL-419): what the thread's
//! files look like against the Base, the last Run's Version or any Thread
//! Version — as a git-style unified diff the app's diff view draws.
//!
//! A Version's files come from the server, captured when it was made
//! (`GET /threads/{id}/versions/{v}`, ATL-415), each by the blob of its
//! content then; the other side is canonical state as this replica holds it.
//! Restoring and marking are the server's doors: a Restore comes back to every
//! replica as an ordinary canonical change and a `restored` frame.

use serde::{Deserialize, Serialize};
use similar::TextDiff;

use crate::wire::FileKind;

/// A Thread Version as `GET /versions` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadVersion {
    pub version: u64,
    /// `merge`, `resolve`, `restore` or `mark`.
    pub kind: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub conflict_id: Option<u64>,
    /// The Version a `restore` set its files back to.
    #[serde(default)]
    pub restored_from: Option<u64>,
    pub author_id: String,
    pub at: u64,
    /// The files it changed, by the blob of their content after.
    pub files: Vec<VersionChange>,
    #[serde(default)]
    pub mark: Option<VersionMark>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionChange {
    pub file_id: u64,
    pub blob: String,
}

/// Somebody bookmarked a Version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMark {
    #[serde(default)]
    pub label: Option<String>,
    pub by: String,
    pub at: u64,
}

/// Every file at one Version (`GET /versions/{v}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFiles {
    pub version: u64,
    pub files: Vec<VersionFile>,
}

/// One file at a Version. `blob` is its content's hash, `None` where the
/// server could not capture it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFile {
    pub file_id: u64,
    pub path: String,
    pub kind: FileKind,
    #[serde(default)]
    pub blob: Option<String>,
}

/// What a file holds on one side of a diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Side {
    /// No such file there.
    Absent,
    Text(String),
    /// A binary file, by its blob; `None` for its Base content.
    Binary(Option<String>),
    /// It was there, but its content could not be read.
    Unavailable,
}

/// How a file differs from the diff base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffChange {
    Added,
    Modified,
    Deleted,
    /// A binary file whose content differs: nothing to draw line by line.
    Binary,
    /// The base side's content is not available.
    Unavailable,
}

/// One file's difference from the diff base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub file_id: u64,
    /// Where it is now, or where it was when it is gone.
    pub path: String,
    pub change: DiffChange,
    /// A git-style unified diff section (`diff --git …`), empty for a binary
    /// or unavailable file.
    pub diff: String,
    /// Whether Restore to this Version can set it back: it exists now and
    /// had content the server captured. Always `false` against the Base.
    pub restorable: bool,
}

/// Lines of context around each hunk, as `git diff` shows.
const CONTEXT: usize = 3;

/// `before` → `after` as one `diff --git` section; empty when they match.
pub fn unified(path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let diff = TextDiff::from_lines(before, after);
    let body = diff
        .unified_diff()
        .context_radius(CONTEXT)
        .missing_newline_hint(false)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string();
    format!("diff --git a/{path} b/{path}\n{body}")
}

/// Compare one file's two sides. `None` when they are the same.
pub fn compare(file_id: u64, path: &str, base: &Side, now: &Side, version: bool) -> Option<FileDiff> {
    let (change, diff) = match (base, now) {
        (Side::Absent, Side::Absent) => return None,
        (Side::Text(a), Side::Text(b)) if a == b => return None,
        (Side::Binary(a), Side::Binary(b)) if a == b => return None,
        (Side::Unavailable, Side::Absent) => return None,
        (Side::Unavailable, _) => (DiffChange::Unavailable, String::new()),
        (Side::Absent, Side::Text(b)) => (DiffChange::Added, unified(path, "", b)),
        (Side::Text(a), Side::Absent) => (DiffChange::Deleted, unified(path, a, "")),
        (Side::Text(a), Side::Text(b)) => (DiffChange::Modified, unified(path, a, b)),
        (Side::Absent, _) => (DiffChange::Added, String::new()),
        (_, Side::Absent) => (DiffChange::Deleted, String::new()),
        _ => (DiffChange::Binary, String::new()),
    };
    let restorable = version
        && !matches!(now, Side::Absent)
        && !matches!(base, Side::Absent | Side::Unavailable);
    Some(FileDiff {
        file_id,
        path: path.to_string(),
        change,
        diff,
        restorable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_change_is_a_git_style_section_the_diff_view_reads() {
        let d = unified("src/a.css", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
        assert!(d.starts_with("diff --git a/src/a.css b/src/a.css\n--- a/src/a.css\n+++ b/src/a.css\n@@ -1,3 +1,3 @@\n"), "{d}");
        assert!(d.contains("\n-two\n+TWO\n"), "{d}");
        assert_eq!(unified("a", "same\n", "same\n"), "");
    }

    #[test]
    fn sides_compare_by_what_changed() {
        let text = |s: &str| Side::Text(s.into());
        assert_eq!(compare(1, "a", &text("x\n"), &text("x\n"), true), None);
        assert_eq!(compare(1, "a", &Side::Absent, &text("x\n"), false).unwrap().change, DiffChange::Added);
        let gone = compare(1, "a", &text("x\n"), &Side::Absent, true).unwrap();
        assert_eq!((gone.change, gone.restorable), (DiffChange::Deleted, false));
        let changed = compare(1, "a", &text("x\n"), &text("y\n"), true).unwrap();
        assert_eq!((changed.change, changed.restorable), (DiffChange::Modified, true));
        assert!(!compare(1, "a", &text("x\n"), &text("y\n"), false).unwrap().restorable);
        let bin = compare(2, "b.png", &Side::Binary(Some("1".into())), &Side::Binary(None), true).unwrap();
        assert_eq!((bin.change, bin.diff.as_str(), bin.restorable), (DiffChange::Binary, "", true));
        let lost = compare(3, "c", &Side::Unavailable, &text("z\n"), true).unwrap();
        assert_eq!((lost.change, lost.restorable), (DiffChange::Unavailable, false));
    }
}
