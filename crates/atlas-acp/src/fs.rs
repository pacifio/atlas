//! Client-served `fs/read_text_file` + `fs/write_text_file` (P1.3,
//! `plans/atlas-acp-parity-loop.md`).
//!
//! ACP lets an agent delegate file I/O to the client. Zed serves these through
//! its open buffers, so an agent edit lands in the same undo history and dirty
//! state as a human edit. Atlas has no equivalent buffer layer — the chat's diff
//! view is driven by the agent's own `ToolCallContent::Diff` (rendered by P1.4)
//! and by git for on-disk state — so the honest Atlas equivalent is to write to
//! disk exactly the way `commands::fs::write_file_content` does. Nothing is
//! bypassed by doing so: there is no write-interception pipeline to route
//! through, and git-backed views pick the change up either way.
//!
//! ## This is not a privilege boundary
//!
//! Refusing a read here would not protect anything: the agent is a local
//! subprocess (`claude`, `codex`, …) running as the user, with unrestricted
//! filesystem access of its own. It asks the client to read on its behalf so the
//! client can apply *its* view of the file — unsaved editor state in Zed's case.
//! The checks below exist to keep the protocol honest (absolute paths, real
//! files, valid UTF-8) and to respect session lifecycle, not to sandbox an agent
//! that could open the file directly.

use std::path::Path;

use crate::error::{AcpError, Result};

/// Read a file, optionally windowed to `line`..`line + limit`.
///
/// `line` is **1-based** per the schema — the most common off-by-one in this
/// method, since the agent asks for "line 1" meaning the first line.
/// Out-of-range windows yield an empty string rather than an error: an agent
/// paging through a file it does not know the length of should get a clean stop,
/// not a failure it has to special-case.
pub fn read_text_file(path: &Path, line: Option<u32>, limit: Option<u32>) -> Result<String> {
    require_absolute(path)?;
    let raw = std::fs::read_to_string(path).map_err(|e| {
        AcpError::Protocol(format!("cannot read {}: {e}", path.display()))
    })?;
    Ok(window(&raw, line, limit))
}

/// Apply the 1-based `line` / `limit` window to already-read contents.
///
/// Split out from the I/O so the windowing rules are testable without a
/// filesystem.
fn window(raw: &str, line: Option<u32>, limit: Option<u32>) -> String {
    if line.is_none() && limit.is_none() {
        return raw.to_string();
    }
    // `line: Some(0)` is out of contract (1-based), but clamping beats
    // underflowing to the end of the file.
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let mut lines = raw.lines().skip(start);
    let selected: Vec<&str> = match limit {
        Some(n) => lines.by_ref().take(n as usize).collect(),
        None => lines.collect(),
    };
    let mut out = selected.join("\n");
    // Preserve the trailing newline when the window reaches the end of a file
    // that had one — an agent round-tripping a whole file through read→write
    // would otherwise silently strip it and dirty the diff.
    if !out.is_empty() && raw.ends_with('\n') && reaches_end(raw, start, limit) {
        out.push('\n');
    }
    out
}

fn reaches_end(raw: &str, start: usize, limit: Option<u32>) -> bool {
    match limit {
        None => true,
        Some(n) => start.saturating_add(n as usize) >= raw.lines().count(),
    }
}

/// Write `content` to `path`, creating parent directories as needed.
///
/// Atomic (temp file + rename) for the same reason every other writer in the
/// tree is: a crash or a full disk mid-write would otherwise leave the user's
/// source file truncated, and an agent write is exactly when that is least
/// recoverable.
pub fn write_text_file(path: &Path, content: &str) -> Result<()> {
    require_absolute(path)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AcpError::Protocol(format!("cannot create {}: {e}", parent.display()))
            })?;
        }
    }
    // Same directory as the target, so the rename stays on one filesystem —
    // a temp dir on another mount would make `rename` fail with EXDEV.
    let tmp = path.with_extension(format!(
        "{}.atlas-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, content)
        .map_err(|e| AcpError::Protocol(format!("cannot write {}: {e}", path.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AcpError::Protocol(format!("cannot replace {}: {e}", path.display()))
    })?;
    Ok(())
}

/// The schema documents both paths as absolute. Resolving a relative path
/// against the host's process cwd would silently target the wrong file — Atlas's
/// cwd is wherever the app was launched from, not the project.
fn require_absolute(path: &Path) -> Result<()> {
    if path.is_absolute() {
        return Ok(());
    }
    Err(AcpError::Protocol(format!(
        "path must be absolute, got {}",
        path.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-acp-fs-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SAMPLE: &str = "one\ntwo\nthree\nfour\nfive\n";

    #[test]
    fn a_read_without_a_window_returns_the_whole_file() {
        assert_eq!(window(SAMPLE, None, None), SAMPLE);
    }

    /// `line` is 1-based: asking for line 1 must return the FIRST line, not the
    /// second. This is the off-by-one that breaks agent file navigation.
    #[test]
    fn line_is_one_based() {
        assert_eq!(window(SAMPLE, Some(1), Some(1)), "one\n".trim_end());
        assert_eq!(window(SAMPLE, Some(2), Some(1)), "two");
    }

    #[test]
    fn limit_caps_the_number_of_lines() {
        assert_eq!(window(SAMPLE, Some(2), Some(3)), "two\nthree\nfour");
    }

    #[test]
    fn a_window_running_past_the_end_stops_cleanly() {
        assert_eq!(window(SAMPLE, Some(4), Some(99)), "four\nfive\n");
    }

    /// An agent paging blindly should get an empty answer, not an error it has
    /// to distinguish from a real failure.
    #[test]
    fn a_window_starting_past_the_end_is_empty_not_an_error() {
        assert_eq!(window(SAMPLE, Some(500), Some(10)), "");
    }

    /// A read→write round-trip of a whole file must not silently strip the
    /// trailing newline; that would show up as a spurious one-line diff.
    #[test]
    fn a_window_reaching_the_end_keeps_the_trailing_newline() {
        assert!(window(SAMPLE, Some(1), None).ends_with('\n'));
        assert!(
            !window(SAMPLE, Some(1), Some(2)).ends_with('\n'),
            "a mid-file window must not invent a trailing newline"
        );
    }

    #[test]
    fn line_zero_clamps_instead_of_underflowing() {
        assert_eq!(window(SAMPLE, Some(0), Some(1)), "one");
    }

    #[test]
    fn relative_paths_are_rejected_rather_than_resolved_against_the_host_cwd() {
        assert!(read_text_file(Path::new("relative.txt"), None, None).is_err());
        assert!(write_text_file(Path::new("relative.txt"), "x").is_err());
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = fixture("roundtrip");
        let file = dir.join("a.txt");
        write_text_file(&file, SAMPLE).unwrap();
        assert_eq!(read_text_file(&file, None, None).unwrap(), SAMPLE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_creates_missing_parent_directories() {
        let dir = fixture("mkdir");
        let file = dir.join("deep").join("nested").join("new.rs");
        write_text_file(&file, "fn main() {}").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "fn main() {}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_replaces_existing_contents_and_leaves_no_temp_file() {
        let dir = fixture("replace");
        let file = dir.join("b.txt");
        write_text_file(&file, "before").unwrap();
        write_text_file(&file, "after").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("atlas-tmp"))
            .collect();
        assert!(strays.is_empty(), "atomic write left a temp file behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_a_missing_file_is_an_error_not_an_empty_string() {
        let dir = fixture("missing");
        assert!(read_text_file(&dir.join("nope.txt"), None, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Multi-byte content must survive the window path untouched — the same
    /// class of bug the terminal buffer guards against.
    #[test]
    fn multibyte_content_round_trips_through_a_window() {
        let text = "héllo\n→ world\n🙂 end\n";
        assert_eq!(window(text, Some(2), Some(1)), "→ world");
        assert_eq!(window(text, None, None), text);
    }
}
