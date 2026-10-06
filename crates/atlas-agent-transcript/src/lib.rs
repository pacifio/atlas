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
//! One narrow read has come back since, under the ADR-0001 amendment
//! ("discovery is not replay", ATL-423): [`discovery`] lists a project's
//! `<uuid>.jsonl` files and their modification times so a session started in a
//! terminal shows up in the sidebar. It never opens a transcript, and replay
//! still goes through the agent.
//!
//! What is left is small and still shared widely:
//!
//! - [`TranscriptKind`] — whether an agent keeps a record Atlas can read, which
//!   is what decides whether Atlas records its own copy.
//! - [`encode_cwd`] — the cwd→folder-name slug the agent CLIs use. Still needed
//!   by the checkpoint importer and the memory corpus, whose contract
//!   (touchpoint #11) explicitly preserves their reads.
//! - [`wrap_memory_envelope`] / [`strip_injected_context`] /
//!   [`is_injected_user_text`] — keeping Atlas's own memory scaffolding from
//!   being mistaken for something the user typed, and out of the agents' own
//!   memory files.
//!
//! Nothing here names a protocol version, and nothing here should.

pub mod discovery;

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
    /// Native agent — JSON transcript under the app config dir, replayed
    /// by the native agent itself rather than through this module.
    Native,
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
///
/// A port of the SDK's `xt()` (`@anthropic-ai/claude-agent-sdk` `core.mjs`,
/// 0.3.287), including the two details a plain reading misses:
///
/// - **UTF-16, not chars.** The JS regex `/[^a-zA-Z0-9]/g` replaces code
///   units, so a character outside the BMP (an emoji) is a surrogate pair and
///   becomes *two* dashes; `é` is one.
/// - **Long paths are truncated and hashed.** A slug over
///   [`MAX_SLUG_LEN`] UTF-16 units is cut to that length and suffixed with
///   `-` and the base-36 absolute value of a Java-style 32-bit string hash of
///   the *original* path (`at()` in the SDK's core chunk).
///
/// The one Atlas-side step is the trailing-slash trim first: Claude slugs its
/// `getcwd`, which never ends in one, and a UI path that does is the same
/// project.
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    let slug: String = trimmed
        .chars()
        .flat_map(|c| {
            let replacement = if c.is_ascii_alphanumeric() { c } else { '-' };
            std::iter::repeat_n(replacement, c.len_utf16())
        })
        .collect();
    // Every char of `slug` is ASCII, so its byte length is its UTF-16 length
    // and slicing by bytes is slicing by code units.
    if slug.len() <= MAX_SLUG_LEN {
        return slug;
    }
    format!(
        "{}-{}",
        &slug[..MAX_SLUG_LEN],
        base36(java_hash_abs(trimmed))
    )
}

/// The SDK's `qe`: the longest slug Claude Code uses verbatim.
pub const MAX_SLUG_LEN: usize = 200;

/// `Math.abs(at(s))`: `h = (h << 5) - h + unit | 0` over UTF-16 code units,
/// wrapping in 32 bits. The absolute value is taken in 64 bits because JS's
/// `Math.abs(-2147483648)` is `2147483648`, which an `i32` cannot hold.
fn java_hash_abs(s: &str) -> u64 {
    let mut h: i32 = 0;
    for unit in s.encode_utf16() {
        h = h
            .wrapping_shl(5)
            .wrapping_sub(h)
            .wrapping_add(i32::from(unit));
    }
    i64::from(h).unsigned_abs()
}

/// `n.toString(36)` for a non-negative integer.
fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
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

/// Opening tag of the envelope every block Atlas prepends to a user message
/// travels inside. One envelope per prompt, however many blocks it holds.
///
/// Mirrored by `MEMORY_ENVELOPE_OPEN` in `src/features/chat/lib/atlas-context.ts`,
/// which parses the same envelope back out of a prompt the agent echoed into a
/// transcript; the two must change together.
pub const MEMORY_ENVELOPE_OPEN: &str = "<atlas-memory>";

/// Closing tag of the injected-context envelope. Mirrored by
/// `MEMORY_ENVELOPE_CLOSE` in `src/features/chat/lib/atlas-context.ts`.
pub const MEMORY_ENVELOPE_CLOSE: &str = "</atlas-memory>";

/// First line inside the envelope, addressed to the agent reading it.
///
/// Load-bearing, not decorative. Claude Code was saving Atlas's injected blocks
/// into its own memory files; Atlas then read those files back into the corpus
/// and injected the copies again, so the memory filled with its own echo. The
/// envelope closes that loop from both ends: this line asks the agent not to
/// persist the text, and [`strip_injected_context`] drops it at every reader in
/// case the agent does it anyway.
pub const MEMORY_ENVELOPE_NOTE: &str = "Background context from Atlas, not part of the user's message. Do not save any of it to your own memory.";

/// Wrap the non-empty `blocks` in one envelope, note line first.
///
/// Returns `None` when nothing survives the filter, so an absent source stays a
/// true no-op: no tag, no note, no allocation.
pub fn wrap_memory_envelope(blocks: &[&str]) -> Option<String> {
    let body = blocks
        .iter()
        .copied()
        .filter(|b| !b.trim().is_empty())
        .collect::<Vec<_>>();
    if body.is_empty() {
        return None;
    }
    Some(format!(
        "{MEMORY_ENVELOPE_OPEN}\n{MEMORY_ENVELOPE_NOTE}\n{}\n{MEMORY_ENVELOPE_CLOSE}",
        body.join("\n\n")
    ))
}

/// Strip the Atlas-injected context blocks that `agents_send` prepends to the
/// wire prompt (shared cross-agent memory, retrieved long-term memory, recent-
/// session recap). The coding agent records the prompt it received in its
/// transcript, so a resumed session would otherwise surface the raw
/// scaffolding as the user's message and chat title — and, worse, save it into
/// its own memory files for Atlas to read back.
///
/// Two shapes are recognised, because both are on disk: the current
/// [`MEMORY_ENVELOPE_OPEN`] … [`MEMORY_ENVELOPE_CLOSE`] envelope, and the bare
/// `--- LABEL ---` … `--- END LABEL ---` blocks written before the envelope
/// existed. Line-based; everything between a start marker and its end is
/// dropped. An unterminated region eats the rest of the text, which is the safe
/// side: scaffolding must never be shown as the user's words.
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
    let mut in_envelope = false;
    for line in text.lines() {
        let l = line.trim();
        if in_envelope {
            if l == MEMORY_ENVELOPE_CLOSE {
                in_envelope = false;
            }
            continue;
        }
        if let Some(end) = &skip_until {
            if l == end {
                skip_until = None;
            }
            continue;
        }
        if l == MEMORY_ENVELOPE_OPEN {
            in_envelope = true;
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
