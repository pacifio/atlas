//! What a share uploads, decided before anything is (ATL-402).
//!
//! The share dialog lists exactly these files and says the repository itself
//! is not uploaded. A file appears when the sharer's working tree differs from
//! the Base on it — modified, added, untracked or deleted — unless git ignores
//! it or `.atlas/shareignore` names it (gitignore syntax). Files that look
//! like secrets, by name or by content, are listed **blocked**: they stay on
//! this machine unless the person ticks "include anyway" for that file. Code is
//! never redacted — a file goes whole, or not at all.

use std::fs;
use std::path::Path;

use crate::git;
use crate::replica::{looks_textual, ReplicaError};
use crate::secrets::{secret_reason, SecretReason};

/// Patterns, in gitignore syntax, for what never leaves the machine in a share.
pub const SHAREIGNORE: &str = ".atlas/shareignore";

/// How a file syncs: co-edited text, or whole bytes (ATL-403).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareKind {
    Text,
    Binary,
}

/// One file of a share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareFile {
    pub path: String,
    pub kind: ShareKind,
    /// Its size on disk; `0` for a deletion.
    pub bytes: u64,
    /// Deleted in the working tree: the share deletes it in the thread.
    pub deleted: bool,
    /// Held back unless included anyway.
    pub blocked: Option<SecretReason>,
}

/// Everything a share of this working tree would upload, and hold back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SharePreview {
    pub files: Vec<ShareFile>,
}

impl SharePreview {
    /// The files that go, given the blocked ones the person included anyway.
    pub fn uploads<'a>(&'a self, include: &'a [String]) -> impl Iterator<Item = &'a ShareFile> {
        self.files
            .iter()
            .filter(move |f| f.blocked.is_none() || include.iter().any(|p| p == &f.path))
    }

    /// The files held back, given the ones included anyway.
    pub fn held<'a>(&'a self, include: &'a [String]) -> impl Iterator<Item = &'a ShareFile> {
        self.files
            .iter()
            .filter(move |f| f.blocked.is_some() && !include.iter().any(|p| p == &f.path))
    }
}

/// Read what sharing `checkout` would upload. Only reads.
pub fn preview(checkout: &Path) -> Result<SharePreview, ReplicaError> {
    let dirty: Vec<git::Dirty> = git::dirty_paths(checkout)?
        .into_iter()
        .filter(|d| crate::path::is_valid(&d.path))
        .collect();
    let paths: Vec<String> = dirty.iter().map(|d| d.path.clone()).collect();
    let ignored = git::ignored(checkout, &paths, Some(&checkout.join(SHAREIGNORE)))?;

    let mut files = Vec::new();
    for d in dirty {
        if ignored.contains(&d.path) || crate::replica::is_set_aside(&d.path) {
            continue;
        }
        if d.deleted {
            files.push(ShareFile {
                blocked: None,
                kind: ShareKind::Text,
                bytes: 0,
                deleted: true,
                path: d.path,
            });
            continue;
        }
        let Ok(target) = crate::path::resolve(checkout, &d.path) else {
            continue;
        };
        // A directory (an untracked submodule, say) is not a file to share.
        let Ok(bytes) = fs::read(&target) else {
            continue;
        };
        let (kind, blocked) = if looks_textual(&bytes) {
            let content = String::from_utf8_lossy(&bytes);
            (ShareKind::Text, secret_reason(&d.path, &content))
        } else {
            // Binary content is not scanned; its name still counts.
            (ShareKind::Binary, secret_reason(&d.path, ""))
        };
        files.push(ShareFile {
            path: d.path,
            kind,
            bytes: bytes.len() as u64,
            deleted: false,
            blocked,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(SharePreview { files })
}
