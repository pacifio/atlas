//! Output capping (tool spec D6).
//!
//! Three things were wrong with the previous version, and all three reached the
//! user as "the tools don't work":
//!
//! * **The wrong half was kept.** Head-only truncation discards the end of a
//!   failing build or test run, which is exactly where the error is.
//! * **The spill went outside the workspace.** The truncation notice told the
//!   model to read a system temp path — a path containment then denies. The
//!   notice was an instruction the gate would refuse.
//! * **Nothing was ever cleaned up.** Every truncation leaked a full copy of
//!   the output, for the life of the machine.
//!
//! Now: head *and* tail with the true omitted count, a spill inside the
//! workspace that the session removes on teardown, and a streaming
//! [`HeadTail`] ring so a command emitting gigabytes is never fully buffered
//! before being thrown away.
//!
//! Standard output and standard error stay chronologically interleaved. That is
//! deliberate and differs from Codex, which concatenates one after the other
//! and loses the ordering that makes build output readable.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// Default cap for tool output bodies (~30 KB) before head/tail capping.
pub const MAX_OUTPUT_BYTES: usize = 30_000;

/// Largest byte index `<= max` that lands on a UTF-8 char boundary.
fn floor_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest byte index `>= min` that lands on a UTF-8 char boundary.
fn ceil_boundary(s: &str, min: usize) -> usize {
    let mut i = min.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// The result of capping, with the *true* pre-cap size so neither the user nor
/// the model can mistake a capped window for the whole thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capped {
    pub body: String,
    pub original_bytes: usize,
    pub omitted_bytes: usize,
    pub spill: Option<PathBuf>,
}

impl Capped {
    pub fn was_capped(&self) -> bool {
        self.omitted_bytes > 0
    }
}

/// Cap `output` at `max` bytes, keeping head and tail in a fifty-fifty split.
///
/// `spill_dir`, when given, receives a full copy of the output and is named in
/// the notice. It must be inside the workspace, which is why the caller passes
/// [`super::policy::ToolPolicy::spill_dir`] rather than a temp directory.
pub fn cap(output: &str, max: usize, label: &str, spill_dir: Option<&Path>) -> Capped {
    let total = output.len();
    if total <= max {
        return Capped {
            body: output.to_string(),
            original_bytes: total,
            omitted_bytes: 0,
            spill: None,
        };
    }

    let half = max / 2;
    let head_end = floor_boundary(output, half);
    let tail_start = ceil_boundary(output, total.saturating_sub(max - head_end));
    let omitted = tail_start.saturating_sub(head_end);

    let spill = spill_dir.and_then(|dir| write_spill(dir, output));
    let pointer = match &spill {
        Some(p) => format!(" Full output is in {}.", p.display()),
        None => String::new(),
    };

    let body = format!(
        "{}\n\n[{label}: {omitted} of {total} bytes omitted from the middle. \
         Head and tail shown.{pointer}]\n\n{}",
        &output[..head_end],
        &output[tail_start..]
    );

    Capped {
        body,
        original_bytes: total,
        omitted_bytes: omitted,
        spill,
    }
}

/// Convenience wrapper for callers that only want the string.
pub fn truncate_output(output: String, max: usize, label: &str) -> String {
    cap(&output, max, label, None).body
}

fn write_spill(dir: &Path, output: &str) -> Option<PathBuf> {
    let file = dir.join(format!("output-{}.txt", uuid::Uuid::new_v4()));
    match std::fs::write(&file, output.as_bytes()) {
        Ok(()) => Some(file),
        Err(e) => {
            tracing::warn!(error = %e, "tool output spill failed");
            None
        }
    }
}

// ─── Streaming head/tail ring (D5) ──────────────────────────────────────────

/// A bounded head-and-tail buffer fed incrementally.
///
/// This is what keeps memory flat while a command runs: the head fills once and
/// stops, the tail is a ring, and everything between them is counted rather
/// than kept. A command producing gigabytes costs `budget` bytes of memory, not
/// gigabytes-then-trim.
pub struct HeadTail {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    half: usize,
    total: u64,
}

impl HeadTail {
    /// `max` is the total byte budget, split evenly between head and tail.
    pub fn new(max: usize) -> Self {
        let half = (max / 2).max(1);
        Self {
            head: Vec::with_capacity(half.min(8 * 1024)),
            tail: VecDeque::new(),
            half,
            total: 0,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        let mut rest = chunk;
        if self.head.len() < self.half {
            let take = (self.half - self.head.len()).min(rest.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.is_empty() {
            return;
        }
        // Only the last `half` bytes of the stream can ever be in the tail, so
        // a huge chunk collapses to its own suffix before touching the ring.
        if rest.len() >= self.half {
            self.tail.clear();
            self.tail.extend(&rest[rest.len() - self.half..]);
            return;
        }
        self.tail.extend(rest);
        while self.tail.len() > self.half {
            self.tail.pop_front();
        }
    }

    /// Total bytes seen, including the omitted middle.
    pub fn total(&self) -> u64 {
        self.total
    }

    /// Bytes dropped from the middle.
    pub fn omitted(&self) -> u64 {
        self.total
            .saturating_sub(self.head.len() as u64)
            .saturating_sub(self.tail.len() as u64)
    }

    /// Render as text.
    ///
    /// Lossy decoding is correct *here* and nowhere else: command output can
    /// legitimately be binary, and there is no path by which it is written back
    /// into a source file. The read tool decodes strictly for exactly that
    /// reason (D5).
    pub fn render(&self, label: &str) -> String {
        let head = String::from_utf8_lossy(&self.head);
        let tail_bytes: Vec<u8> = self.tail.iter().copied().collect();
        let tail = String::from_utf8_lossy(&tail_bytes);
        let omitted = self.omitted();
        if omitted == 0 {
            return format!("{head}{tail}");
        }
        format!(
            "{head}\n\n[{label}: {omitted} of {} bytes omitted from the middle. \
             Head and tail shown.]\n\n{tail}",
            self.total
        )
    }

    /// Whether anything was dropped.
    pub fn was_capped(&self) -> bool {
        self.omitted() > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::TmpDir;

    #[test]
    fn under_cap_unchanged() {
        let c = cap("hello", 100, "x", None);
        assert_eq!(c.body, "hello");
        assert!(!c.was_capped());
        assert_eq!(c.original_bytes, 5);
    }

    #[test]
    fn keeps_head_and_tail() {
        // The failing end of a build must survive.
        let s = format!("{}{}", "S".repeat(1000), "ERROR: it broke".to_string());
        let c = cap(&s, 100, "Bash output", None);
        assert!(c.body.starts_with("SSSS"), "head kept");
        assert!(
            c.body.ends_with("ERROR: it broke"),
            "tail kept — this is the whole point: {}",
            c.body
        );
        assert!(c.was_capped());
    }

    #[test]
    fn reports_true_totals_not_post_cap_ones() {
        let s = "a".repeat(10_000);
        let c = cap(&s, 100, "x", None);
        assert_eq!(c.original_bytes, 10_000);
        assert!(
            c.body.contains("of 10000 bytes omitted"),
            "the notice must state the real size: {}",
            c.body
        );
        assert_eq!(c.omitted_bytes, 10_000 - 100);
    }

    #[test]
    fn respects_char_boundaries_at_both_cuts() {
        let s = "é".repeat(1000); // 2 bytes each
        let c = cap(&s, 51, "x", None); // odd cut would split a char at both ends
        assert!(c.was_capped());
        // Round-trips as valid UTF-8 by construction; the assertion is that we
        // got here without panicking on a non-boundary slice.
        assert!(c.body.contains("omitted from the middle"));
    }

    #[test]
    fn spill_lands_inside_the_given_directory_and_is_named() {
        let tmp = TmpDir::new();
        let s = "z".repeat(5_000);
        let c = cap(&s, 100, "Bash output", Some(tmp.path()));
        let spill = c.spill.expect("spill written");
        assert!(spill.starts_with(tmp.path()), "spill must be where the caller said");
        assert_eq!(std::fs::read_to_string(&spill).unwrap().len(), 5_000);
        assert!(c.body.contains(&spill.display().to_string()));
    }

    #[test]
    fn a_failed_spill_still_produces_usable_output() {
        let s = "z".repeat(5_000);
        let c = cap(&s, 100, "x", Some(Path::new("/nonexistent/nope")));
        assert!(c.spill.is_none());
        assert!(c.was_capped());
        assert!(c.body.contains("omitted from the middle"));
    }

    // ── Streaming ring ──────────────────────────────────────────────────────

    #[test]
    fn ring_keeps_head_and_tail_across_many_chunks() {
        let mut ht = HeadTail::new(100);
        ht.push(b"START");
        for _ in 0..1000 {
            ht.push(b"..........");
        }
        ht.push(b"END");
        let out = ht.render("Bash output");
        assert!(out.starts_with("START"), "{out}");
        assert!(out.ends_with("END"), "{out}");
        assert_eq!(ht.total(), 5 + 10_000 + 3);
        assert!(ht.was_capped());
    }

    #[test]
    fn ring_memory_is_flat_regardless_of_volume() {
        let mut ht = HeadTail::new(100);
        // One enormous chunk must collapse to its own suffix, not be buffered.
        ht.push(&vec![b'x'; 10_000_000]);
        assert!(ht.head.len() <= 50);
        assert!(ht.tail.len() <= 50);
        assert_eq!(ht.total(), 10_000_000);
    }

    #[test]
    fn ring_under_budget_is_verbatim() {
        let mut ht = HeadTail::new(1000);
        ht.push(b"hello ");
        ht.push(b"world");
        assert_eq!(ht.render("x"), "hello world");
        assert!(!ht.was_capped());
    }

    #[test]
    fn ring_omitted_count_is_exact() {
        let mut ht = HeadTail::new(100);
        ht.push(&vec![b'a'; 1000]);
        assert_eq!(ht.omitted(), 1000 - 100);
        assert!(ht.render("x").contains("900 of 1000 bytes omitted"));
    }
}
