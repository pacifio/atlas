//! Where an agent keeps its record of a conversation, and how to read Atlas's
//! own text back out of one.
//!
//! This crate used to hold the Claude Code JSONL replay — parsing
//! `~/.claude/projects/<encoded-cwd>/<id>.jsonl` so a resumed Claude session
//! painted its history instantly. That is gone: Atlas no longer reads another
//! program's private storage to draw its own UI (ADR-0001), it has recorded
//! every agent's transcript itself since the usage re-source, and anything
//! older replays from the agent through `session/load`.
//!
//! What is left is small and still shared widely:
//!
//! - [`TranscriptKind`] — whether an agent keeps a record Atlas can read, which
//!   is what decides whether Atlas records its own copy.
//! - [`encode_cwd`] — the cwd→folder-name slug the agent CLIs use. Still needed
//!   by the checkpoint importer and the memory corpus, whose contract
//!   (touchpoint #11) explicitly preserves their reads.
//! - [`strip_injected_context`] / [`is_injected_user_text`] — keeping Atlas's
//!   own memory scaffolding from being mistaken for something the user typed.
//!
//! Nothing here names a protocol version, and nothing here should.

use serde::{Deserialize, Serialize};

/// Where an agent keeps its own record of a conversation, if anywhere.
///
/// This is what decides whether Atlas records a second copy: an agent with a
/// readable store of its own would otherwise put two rows in the sidebar for
/// one conversation, with two competing titles.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TranscriptKind {
    /// No on-disk transcript — sessions are in-memory only and die with the
    /// process. These are the ones Atlas records itself.
    None,
    /// Native Cersei agent — JSON transcript under the app config dir, replayed
    /// by the native agent itself rather than through this module.
    CerseiJson,
}

/// Claude Code encodes the project cwd as a folder name by replacing every
/// character that isn't ASCII alphanumeric with `-` (so `/`, spaces, `.`, `_`
/// all collapse to `-`). E.g. `/Users/adib/Desktop/atlas` →
/// `-Users-adib-Desktop-atlas`, and `/Users/adib/Codes/Test Atlas` →
/// `-Users-adib-Codes-Test-Atlas`. Matching this exactly is required — Atlas
/// reads the JSONL transcripts the Claude Agent SDK writes under that folder,
/// so a path with a space or dot must resolve to the SAME slug or the listing
/// finds nothing (was: only `/` was replaced → 0 rows for any path with a
/// space).
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Identify user content injected by Claude Code itself (system tags,
/// interruption notices, warmup pings) rather than typed by the user.
pub fn is_injected_user_text(t: &str) -> bool {
    let trimmed = t.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with('<') {
        return true;
    }
    if trimmed.starts_with("[Request interrupted") {
        return true;
    }
    if trimmed.eq_ignore_ascii_case("warmup") {
        return true;
    }
    false
}

/// Strip the Atlas-injected context blocks that `agents_send` prepends to the
/// wire prompt (shared cross-agent memory, retrieved long-term memory, recent-
/// session recap). The coding agent records the prompt it received in its
/// transcript, so a resumed session would otherwise surface the raw
/// `--- SHARED MEMORY ---` / `--- RELEVANT PROJECT MEMORY ---` scaffolding as
/// the user's message and chat title. Line-based: drop everything from a known
/// block start marker through its matching `--- END <LABEL> ---`.
pub fn strip_injected_context(text: &str) -> String {
    // Block START labels (the END marker is always `--- END <CORE> ---`). The
    // SHARED MEMORY block's start line may carry a suffix
    // ("— UPDATES SINCE LAST TURN"), so we match by prefix.
    const CORES: [&str; 4] = [
        "SHARED MEMORY",
        "RELEVANT PROJECT MEMORY",
        "PROJECT MEMORY",
        "RECENT SESSION",
    ];
    let mut out: Vec<&str> = Vec::new();
    let mut skip_until: Option<String> = None;
    for line in text.lines() {
        let l = line.trim();
        if let Some(end) = &skip_until {
            if l == end {
                skip_until = None;
            }
            continue;
        }
        if l.starts_with("--- ") && l.ends_with("---") && !l.starts_with("--- END") {
            let inner = l.trim_start_matches("--- ");
            if let Some(core) = CORES.iter().find(|c| inner.starts_with(**c)) {
                skip_until = Some(format!("--- END {core} ---"));
                continue;
            }
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}
