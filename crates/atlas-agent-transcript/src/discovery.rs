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

/// Who wrote a transcript's newest conversation line, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastWriter {
    /// Claude Code's `entrypoint`: `"cli"` in a terminal, `"sdk-cli"` /
    /// `"sdk-ts"` under an SDK host — which is how Atlas drives it, through
    /// `claude-agent-acp`.
    pub entrypoint: String,
    /// The line's own `timestamp`, when it has one.
    pub at: Option<DateTime<Utc>>,
}

impl LastWriter {
    /// Whether an SDK host (Atlas) wrote the line rather than a terminal.
    pub fn is_sdk_host(&self) -> bool {
        self.entrypoint.starts_with("sdk")
    }
}

/// The newest *conversation* line of a transcript: the last line that names
/// an `entrypoint`, read from the tail only.
///
/// Why this and not the file's modified time: Claude Code also appends
/// bookkeeping lines (`ai-title`, `last-prompt`, `cost-state`,
/// `queue-operation`, `mode`, summaries) outside any turn — on load, resume,
/// cancel and exit, and sometimes minutes after a turn. Those carry no
/// `entrypoint` and no conversation, so they move the file time without
/// saying anything about who is in the session or whether it is still
/// running. Read by time alone, every one of them looked like "another
/// process", which is what made the live-elsewhere banner look random.
///
/// `None` when the tail holds no conversation line (unknown writer), so the
/// caller falls back to the file time rather than hiding a real terminal. A
/// tool result can make one line very long, so a small window is tried first
/// and a larger one only when it held no conversation line.
pub fn last_writer(path: &Path) -> Option<LastWriter> {
    use std::io::{Read, Seek, SeekFrom};
    const WINDOWS: [u64; 2] = [64 * 1024, 2 * 1024 * 1024];
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    for window in WINDOWS {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut tail = Vec::with_capacity((len - start) as usize);
        file.read_to_end(&mut tail).ok()?;
        let text = String::from_utf8_lossy(&tail);
        let mut lines = text.lines().rev().peekable();
        while let Some(line) = lines.next() {
            // The window's first line is a fragment unless it starts the file.
            if start > 0 && lines.peek().is_none() {
                break;
            }
            if !line.contains("\"entrypoint\"") {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(entrypoint) = value.get("entrypoint").and_then(|e| e.as_str()) else {
                continue;
            };
            let at = value
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Utc));
            return Some(LastWriter {
                entrypoint: entrypoint.to_owned(),
                at,
            });
        }
        if start == 0 {
            break;
        }
    }
    None
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

    /// A transcript file in the OS temp dir, removed on drop.
    struct Transcript(PathBuf);
    impl Transcript {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Transcript {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn transcript(lines: &[&str]) -> Transcript {
        let path = std::env::temp_dir().join(format!("{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        Transcript(path)
    }

    #[test]
    fn bookkeeping_after_an_atlas_turn_is_still_atlas() {
        let f = transcript(&[
            r#"{"type":"user","entrypoint":"sdk-cli","message":{}}"#,
            r#"{"type":"assistant","entrypoint":"sdk-cli","message":{}}"#,
            r#"{"type":"ai-title","title":"x"}"#,
            r#"{"type":"queue-operation","op":"dequeue"}"#,
            r#"{"type":"last-prompt","prompt":"x"}"#,
        ]);
        let w = last_writer(f.path()).unwrap();
        assert_eq!(w.entrypoint, "sdk-cli");
        assert!(w.is_sdk_host());
    }

    #[test]
    fn a_terminal_resuming_an_atlas_session_is_not_atlas() {
        let f = transcript(&[
            r#"{"type":"assistant","entrypoint":"sdk-ts","message":{}}"#,
            r#"{"type":"user","entrypoint":"cli","message":{}}"#,
            r#"{"type":"ai-title","title":"x"}"#,
        ]);
        assert!(!last_writer(f.path()).unwrap().is_sdk_host());
    }

    #[test]
    fn an_unknown_writer_is_not_claimed_as_atlas() {
        let f = transcript(&[r#"{"type":"ai-title","title":"x"}"#]);
        assert_eq!(last_writer(f.path()), None);
    }

    #[test]
    fn a_long_last_line_falls_back_to_the_wider_window() {
        let big = format!(
            r#"{{"type":"user","entrypoint":"sdk-cli","message":"{}"}}"#,
            "x".repeat(200 * 1024)
        );
        let f = transcript(&[r#"{"type":"assistant","entrypoint":"cli"}"#, &big]);
        assert_eq!(last_writer(f.path()).unwrap().entrypoint, "sdk-cli");
    }

    #[test]
    fn the_writer_is_timed_by_its_line_not_by_later_bookkeeping() {
        // A terminal turn, then the flush Claude Code writes as it exits.
        let f = transcript(&[
            r#"{"type":"assistant","entrypoint":"cli","timestamp":"2026-10-15T19:11:53.178Z"}"#,
            r#"{"type":"system","entrypoint":"cli","timestamp":"2026-10-15T19:11:53.207Z"}"#,
            r#"{"type":"cost-state"}"#,
            r#"{"type":"last-prompt","prompt":"x"}"#,
        ]);
        let w = last_writer(f.path()).unwrap();
        assert_eq!(w.entrypoint, "cli");
        assert_eq!(
            w.at,
            Some("2026-10-15T19:11:53.207Z".parse::<DateTime<Utc>>().unwrap())
        );
    }

    #[test]
    fn a_line_without_a_timestamp_has_no_time() {
        let f = transcript(&[r#"{"type":"user","entrypoint":"cli"}"#]);
        assert_eq!(last_writer(f.path()).unwrap().at, None);
    }

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
