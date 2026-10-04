//! Finding which Claude Code sessions exist for a project, from file names and
//! modification times alone.
//!
//! This is *discovery* in the sense of the ADR-0001 amendment ("discovery is
//! not replay", 2026-10-05, ATL-423): Atlas may look at an agent's on-disk
//! storage to learn that a session exists and when it last moved. It never
//! opens those files — [`scan_sessions`] lists a directory and reads metadata,
//! nothing else — and replay still goes through the agent (Rule 2).

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::encode_cwd;

/// One session transcript found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSession {
    /// The file stem, which is the session id.
    pub session_id: String,
    pub path: PathBuf,
    /// The file's last-modified time: the session's last activity.
    pub modified: DateTime<Utc>,
}

/// The directory Claude Code keeps this project's transcripts in; `None`
/// without a home dir.
///
/// This is `~/.claude/projects/<slug>`, exactly as the checkpoint importer
/// resolves it. Claude Code's `CLAUDE_CONFIG_DIR` is deliberately *not*
/// honoured here, because the importer does not either, and the two must agree
/// about where a project's transcripts are.
pub fn claude_sessions_dir(cwd: &Path) -> Option<PathBuf> {
    let projects = dirs::home_dir()?.join(".claude").join("projects");
    Some(sessions_dir_in(&projects, cwd))
}

/// Same, under an explicit projects root (the `~/.claude/projects` equivalent).
pub fn sessions_dir_in(root: &Path, cwd: &Path) -> PathBuf {
    root.join(encode_cwd(&cwd.to_string_lossy()))
}

/// Top-level `<uuid>.jsonl` files only. Subdirectories and non-UUID names are
/// ignored. File contents are never read. A missing or unreadable directory is
/// an empty list, never an error.
pub fn scan_sessions(dir: &Path) -> Vec<DiscoveredSession> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()?.to_str()? != "jsonl" {
                return None;
            }
            let stem = path.file_stem()?.to_str()?;
            uuid::Uuid::parse_str(stem).ok()?;
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(DiscoveredSession {
                session_id: stem.to_owned(),
                modified: DateTime::<Utc>::from(meta.modified().ok()?),
                path,
            })
        })
        .collect()
}

/// How recently a transcript must have been written for its session to count
/// as running in another process (ADR-0001 amendment, Rule 7).
pub const LIVE_WINDOW: std::time::Duration = std::time::Duration::from_secs(90);

/// Whether a session last written at `modified` is live at `now`. A modified
/// time in the future (clock skew) counts as live.
pub fn is_live(modified: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    match (now - modified).to_std() {
        Ok(age) => age < LIVE_WINDOW,
        // Negative age: the file is from the future.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liveness_window() {
        let now = Utc::now();
        let ago = |s: i64| now - chrono::Duration::seconds(s);
        assert!(is_live(ago(0), now));
        assert!(is_live(ago(89), now));
        assert!(!is_live(ago(90), now));
        assert!(!is_live(ago(3600), now));
        assert!(is_live(now + chrono::Duration::seconds(30), now));
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("atlas-discovery-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_only_top_level_uuid_jsonl_files() {
        let tmp = TempDir::new();
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        std::fs::write(tmp.0.join(format!("{a}.jsonl")), "not read").unwrap();
        std::fs::write(tmp.0.join(format!("{b}.jsonl")), "").unwrap();
        std::fs::write(tmp.0.join("notes.jsonl"), "").unwrap();
        std::fs::write(tmp.0.join(format!("{}.txt", uuid::Uuid::new_v4())), "").unwrap();
        let nested = tmp.0.join("subagents");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(format!("{}.jsonl", uuid::Uuid::new_v4())), "").unwrap();
        // A directory named like a session is not one.
        std::fs::create_dir_all(tmp.0.join(format!("{}.jsonl", uuid::Uuid::new_v4()))).unwrap();

        let mut ids: Vec<String> = scan_sessions(&tmp.0)
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        ids.sort();
        let mut want = vec![a, b];
        want.sort();
        assert_eq!(ids, want);
    }

    #[test]
    fn a_missing_directory_is_empty() {
        let tmp = TempDir::new();
        assert!(scan_sessions(&tmp.0.join("absent")).is_empty());
    }

    #[test]
    fn the_sessions_dir_uses_the_cwd_slug() {
        let dir = sessions_dir_in(Path::new("/r"), Path::new("/Users/a/Test Atlas"));
        assert_eq!(dir, Path::new("/r/-Users-a-Test-Atlas"));
    }
}
