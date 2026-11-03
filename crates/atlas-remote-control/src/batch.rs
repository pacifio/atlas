//! The delta coalescer (§17 item 4): every envelope for the room's session goes
//! into a batch flushed every [`RC_COALESCE_MS`] or [`RC_COALESCE_BYTES`],
//! whichever first, and **immediately** on any delta that is not streamed
//! text — a tool call, a permission request, a turn's end, a status — so those
//! never wait. One flush is one kind-1 frame.
//!
//! The engine emits a text chunk per token (20–60 a second); the window caps a
//! room at about 30 frames a second whatever the token rate, which is what
//! keeps the object's fan-out inside its CPU budget. The deltas themselves are
//! untouched: the batch carries them verbatim, so a viewer applies exactly the
//! envelopes the window did.

use std::time::{Duration, Instant};

use atlas_agent_wire::SessionDelta;

use crate::codec::{encode_delta_batch, entry_len, header_len};
use crate::{RC_COALESCE_BYTES, RC_COALESCE_MS, RC_DELTA_MAX_BYTES};

/// Is this delta streamed text — the kind worth holding for a few ms so it
/// rides with its neighbours? Everything else flushes at once.
pub fn is_streamed_text(delta: &SessionDelta) -> bool {
    matches!(
        delta,
        SessionDelta::TextChunk { .. }
            | SessionDelta::ThinkingChunk { .. }
            | SessionDelta::ToolCallOutputChunk { .. }
    )
}

/// The coalescing window.
pub const WINDOW: Duration = Duration::from_millis(RC_COALESCE_MS);

/// One open batch.
#[derive(Debug, Default)]
pub struct Coalescer {
    seq_first: Option<u64>,
    entries: Vec<Vec<u8>>,
    payload_bytes: usize,
    opened_at: Option<Instant>,
}

/// What a push asks of the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pushed {
    /// Held; flush by [`Coalescer::deadline`].
    Held,
    /// Flush now: the batch is full, or what was pushed must not wait.
    FlushNow,
}

impl Coalescer {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The last seq in the batch, if any.
    pub fn last_seq(&self) -> Option<u64> {
        self.seq_first
            .map(|first| first + self.entries.len() as u64 - 1)
    }

    /// When the open batch must go, if one is open.
    pub fn deadline(&self) -> Option<Instant> {
        self.opened_at.map(|at| at + WINDOW)
    }

    /// Would adding an envelope of `len` bytes push the frame past the
    /// object's frame cap? The caller flushes first.
    pub fn would_overflow(&self, len: usize) -> bool {
        if self.entries.is_empty() {
            return false;
        }
        let first = self.seq_first.unwrap_or(0);
        header_len(first, self.entries.len() as u64 + 1) + self.payload_bytes + entry_len(len)
            > RC_DELTA_MAX_BYTES
    }

    /// Can an envelope of `len` bytes ride in a frame at all, even alone?
    pub fn fits_alone(seq: u64, len: usize) -> bool {
        header_len(seq, 1) + entry_len(len) <= RC_DELTA_MAX_BYTES
    }

    /// Add one envelope, the next in seq order.
    pub fn push(&mut self, seq: u64, envelope: Vec<u8>, urgent: bool, now: Instant) -> Pushed {
        debug_assert!(
            self.last_seq().is_none_or(|last| last + 1 == seq),
            "a batch is dense"
        );
        if self.entries.is_empty() {
            self.seq_first = Some(seq);
            self.opened_at = Some(now);
        }
        self.payload_bytes += entry_len(envelope.len());
        self.entries.push(envelope);
        if urgent || self.payload_bytes >= RC_COALESCE_BYTES {
            Pushed::FlushNow
        } else {
            Pushed::Held
        }
    }

    /// Close the batch: its frame and the last seq it covers.
    pub fn take(&mut self) -> Option<(Vec<u8>, u64)> {
        let first = self.seq_first?;
        let last = self.last_seq()?;
        let frame = encode_delta_batch(first, &self.entries);
        self.clear();
        frame.map(|frame| (frame, last))
    }

    /// Drop the open batch (a resync supersedes it).
    pub fn clear(&mut self) {
        self.seq_first = None;
        self.entries.clear();
        self.payload_bytes = 0;
        self.opened_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_delta_batch, decode_frame};

    #[test]
    fn text_is_held_and_anything_else_flushes_the_batch_at_once() {
        let mut c = Coalescer::default();
        let now = Instant::now();
        assert_eq!(c.push(5, b"{\"a\":1}".to_vec(), false, now), Pushed::Held);
        assert_eq!(c.push(6, b"{\"a\":2}".to_vec(), false, now), Pushed::Held);
        assert_eq!(c.deadline(), Some(now + WINDOW));
        assert_eq!(
            c.push(7, b"{\"tool\":1}".to_vec(), true, now),
            Pushed::FlushNow
        );
        let (frame, last) = c.take().unwrap();
        assert_eq!(last, 7);
        let frame = decode_frame(&frame).unwrap();
        assert_eq!((frame.seq_first, frame.count), (5, 3));
        assert_eq!(decode_delta_batch(&frame).unwrap().len(), 3);
        assert!(c.is_empty() && c.deadline().is_none());
    }

    #[test]
    fn eight_kib_of_text_flushes_without_waiting_for_the_window() {
        let mut c = Coalescer::default();
        let now = Instant::now();
        let chunk = vec![b'x'; 1024];
        let mut pushed = Pushed::Held;
        let mut seq = 1;
        while pushed == Pushed::Held {
            pushed = c.push(seq, chunk.clone(), false, now);
            seq += 1;
        }
        assert!(seq - 1 <= 8, "flushed by 8 KiB, took {} chunks", seq - 1);
    }

    #[test]
    fn a_frame_never_grows_past_the_objects_cap() {
        let mut c = Coalescer::default();
        let now = Instant::now();
        let big = vec![b'x'; RC_DELTA_MAX_BYTES / 2];
        c.push(1, big.clone(), false, now);
        assert!(c.would_overflow(big.len()));
        assert!(Coalescer::fits_alone(2, big.len()));
        assert!(!Coalescer::fits_alone(2, RC_DELTA_MAX_BYTES));
    }
}
