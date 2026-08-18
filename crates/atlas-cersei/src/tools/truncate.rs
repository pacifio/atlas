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
//! Now: [`HeadTail`], a streaming ring that keeps head *and* tail with the true
//! omitted count and never buffers the middle at all. The caller retains the
//! full output — the shell tool keeps its capture file — and names a path
//! inside the workspace, which is a path the gate permits the model to read.
//!
//! There is deliberately no string-in, string-out variant. One existed and had
//! no production caller: capping has to happen *while* output arrives, or the
//! gigabyte has already been allocated by the time anyone decides to discard
//! it.
//!
//! Standard output and standard error stay chronologically interleaved. That is
//! deliberate and differs from Codex, which concatenates one after the other
//! and loses the ordering that makes build output readable.

use std::collections::VecDeque;

/// Default cap for tool output bodies (~30 KB) before head/tail capping.
pub const MAX_OUTPUT_BYTES: usize = 30_000;

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

    #[test]
    fn under_budget_is_verbatim() {
        let mut ht = HeadTail::new(1000);
        ht.push(b"hello ");
        ht.push(b"world");
        assert_eq!(ht.render("x"), "hello world");
        assert!(!ht.was_capped());
        assert_eq!(ht.total(), 11);
    }

    #[test]
    fn keeps_head_and_tail_across_many_chunks() {
        // The failing end of a build must survive. Head-only truncation threw
        // exactly this away.
        let mut ht = HeadTail::new(100);
        ht.push(b"START");
        for _ in 0..1000 {
            ht.push(b"..........");
        }
        ht.push(b"ERROR: it broke");
        let out = ht.render("Bash output");
        assert!(out.starts_with("START"), "{out}");
        assert!(out.ends_with("ERROR: it broke"), "{out}");
        assert!(ht.was_capped());
    }

    #[test]
    fn reports_true_totals_not_post_cap_ones() {
        let mut ht = HeadTail::new(100);
        ht.push(&vec![b'a'; 1000]);
        assert_eq!(ht.total(), 1000);
        assert_eq!(ht.omitted(), 900);
        assert!(
            ht.render("x").contains("900 of 1000 bytes omitted"),
            "the notice must state the real size"
        );
    }

    #[test]
    fn memory_is_flat_regardless_of_volume() {
        let mut ht = HeadTail::new(100);
        // One enormous chunk must collapse to its own suffix, not be buffered.
        ht.push(&vec![b'x'; 10_000_000]);
        assert!(ht.head.len() <= 50);
        assert!(ht.tail.len() <= 50);
        assert_eq!(ht.total(), 10_000_000);
    }

    #[test]
    fn a_cut_through_a_multibyte_character_does_not_panic() {
        // The ring is byte-oriented, so a cut can land mid-character. Rendering
        // must still produce valid UTF-8 rather than panicking on a slice.
        let mut ht = HeadTail::new(51);
        for _ in 0..100 {
            ht.push("é".as_bytes()); // 2 bytes each
        }
        let out = ht.render("x");
        assert!(out.contains("omitted from the middle"), "{out}");
    }

    #[test]
    fn binary_output_renders_rather_than_failing() {
        // Command output can legitimately be binary. Unlike a file read there
        // is no path by which it is written back into source, so lossy is the
        // right call here and only here.
        let mut ht = HeadTail::new(1000);
        ht.push(&[0xFF, 0xFE, b'o', b'k']);
        assert!(ht.render("x").contains("ok"));
    }
}
