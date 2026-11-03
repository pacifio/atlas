//! The binary stream frame (wire protocol v1, §7.2), transcribed from
//! `packages/contracts/src/rc.ts` (`encodeRcFrame` / `decodeRcFrame`, built on
//! the thread codec's varints).
//!
//! ```text
//! version u8 (= 1) | kind u8 | flags u8 | seq_first varint | count varint | payload…
//! kind 1 = delta batch: count × (len varint | redacted SessionDeltaEnvelope JSON)
//! kind 2 = one snapshot part, seq_first = as_of_seq, count = 1, flags bit0 = more
//! ```
//!
//! The room's object reads the header and nothing else, and relays the frame
//! byte for byte — so what this module writes is exactly what every viewer
//! decodes. `tests/contract.rs` holds it to the server's golden frames.

use crate::{RC_DELTA_MAX_BYTES, RC_PROTOCOL_VERSION, RC_SNAPSHOT_PART_MAX_BYTES};

/// Binary frame kinds (`RcFrameKind`).
pub const FRAME_KIND_DELTA_BATCH: u8 = 1;
pub const FRAME_KIND_SNAPSHOT: u8 = 2;
/// `flags` bit 0: a snapshot continues in the next frame (`RC_FRAME_FLAG_MORE`).
pub const FRAME_FLAG_MORE: u8 = 0x01;

/// `Number.MAX_SAFE_INTEGER`: the most a varint may carry, because the browser
/// decodes it into a double.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The most bytes a varint may take: 8 × 7 bits is 56, past 2^53, so the
/// safe-integer bound is what actually limits it.
const VARINT_MAX_BYTES: usize = 8;

/// A decoded frame. `payload` is everything after the header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub version: u8,
    pub kind: u8,
    pub flags: u8,
    pub seq_first: u64,
    pub count: u64,
    pub payload: Vec<u8>,
}

impl Frame {
    /// The last seq the frame covers.
    pub fn seq_last(&self) -> u64 {
        self.seq_first + self.count.saturating_sub(1)
    }

    /// Why the frame is not one the protocol carries, or `None` when it is —
    /// the same checks the object answers `bad_frame` for (`rcFrameProblem`).
    pub fn problem(&self) -> Option<String> {
        if self.version != RC_PROTOCOL_VERSION {
            return Some(format!(
                "frame version {} is not {RC_PROTOCOL_VERSION}",
                self.version
            ));
        }
        if self.kind != FRAME_KIND_DELTA_BATCH && self.kind != FRAME_KIND_SNAPSHOT {
            return Some(format!(
                "frame kind {} is not a delta batch (1) or a snapshot (2)",
                self.kind
            ));
        }
        if self.count < 1 {
            return Some("count is at least 1".into());
        }
        if self.kind == FRAME_KIND_SNAPSHOT && self.count != 1 {
            return Some("a snapshot part has count 1".into());
        }
        if self.seq_first + self.count - 1 > MAX_SAFE_INTEGER {
            return Some("seq out of range".into());
        }
        None
    }
}

/// Append `value` as an unsigned LEB128 varint. `None` past
/// [`MAX_SAFE_INTEGER`] — the other side could not read it back.
pub fn write_varint(out: &mut Vec<u8>, value: u64) -> Option<()> {
    if value > MAX_SAFE_INTEGER {
        return None;
    }
    let mut v = value;
    while v >= 0x80 {
        out.push((v & 0x7f) as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
    Some(())
}

/// Read one varint at `*at`, advancing it. `None` when the bytes run out, the
/// varint runs past 8 bytes, or the value is past [`MAX_SAFE_INTEGER`].
pub fn read_varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    for n in 0..VARINT_MAX_BYTES {
        let byte = *bytes.get(*at)?;
        *at += 1;
        result |= u64::from(byte & 0x7f) << (7 * n);
        if byte & 0x80 == 0 {
            return (result <= MAX_SAFE_INTEGER).then_some(result);
        }
    }
    None
}

/// Encode a frame. `None` on a seq or count no varint here may carry.
pub fn encode_frame(
    kind: u8,
    flags: u8,
    seq_first: u64,
    count: u64,
    payload: &[u8],
) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(3 + 16 + payload.len());
    out.extend_from_slice(&[RC_PROTOCOL_VERSION, kind, flags]);
    write_varint(&mut out, seq_first)?;
    write_varint(&mut out, count)?;
    out.extend_from_slice(payload);
    Some(out)
}

/// Decode a frame's header, or `None` when it is truncated or a varint is
/// malformed. Does not judge it: see [`Frame::problem`].
pub fn decode_frame(bytes: &[u8]) -> Option<Frame> {
    if bytes.len() < 3 {
        return None;
    }
    let mut at = 3;
    let seq_first = read_varint(bytes, &mut at)?;
    let count = read_varint(bytes, &mut at)?;
    Some(Frame {
        version: bytes[0],
        kind: bytes[1],
        flags: bytes[2],
        seq_first,
        count,
        payload: bytes[at..].to_vec(),
    })
}

/// A kind-1 frame from envelopes already serialised, in seq order: the first
/// is `seq_first`, each length-prefixed. `None` for an empty batch.
pub fn encode_delta_batch<E: AsRef<[u8]>>(seq_first: u64, envelopes: &[E]) -> Option<Vec<u8>> {
    if envelopes.is_empty() {
        return None;
    }
    let mut payload = Vec::with_capacity(envelopes.iter().map(|e| e.as_ref().len() + 3).sum());
    for envelope in envelopes {
        let envelope = envelope.as_ref();
        write_varint(&mut payload, envelope.len() as u64)?;
        payload.extend_from_slice(envelope);
    }
    encode_frame(
        FRAME_KIND_DELTA_BATCH,
        0,
        seq_first,
        envelopes.len() as u64,
        &payload,
    )
}

/// Split a kind-1 frame's payload into its `count` envelopes, or `None` when
/// the lengths do not account for the payload exactly (`decodeRcDeltaBatch`).
pub fn decode_delta_batch(frame: &Frame) -> Option<Vec<Vec<u8>>> {
    if frame.kind != FRAME_KIND_DELTA_BATCH {
        return None;
    }
    let mut out = Vec::new();
    let mut at = 0usize;
    for _ in 0..frame.count {
        let len = usize::try_from(read_varint(&frame.payload, &mut at)?).ok()?;
        let end = at.checked_add(len)?;
        out.push(frame.payload.get(at..end)?.to_vec());
        at = end;
    }
    (at == frame.payload.len()).then_some(out)
}

/// A snapshot as the kind-2 frames that carry it: parts of at most
/// [`RC_SNAPSHOT_PART_MAX_BYTES`], every one but the last flagged `more`. An
/// empty snapshot is still one (empty) part, so the object always sees an end.
pub fn snapshot_frames(as_of_seq: u64, snapshot: &[u8]) -> Option<Vec<Vec<u8>>> {
    let parts: Vec<&[u8]> = if snapshot.is_empty() {
        vec![&[][..]]
    } else {
        snapshot.chunks(RC_SNAPSHOT_PART_MAX_BYTES).collect()
    };
    let last = parts.len() - 1;
    parts
        .into_iter()
        .enumerate()
        .map(|(i, part)| {
            let flags = if i == last { 0 } else { FRAME_FLAG_MORE };
            let frame = encode_frame(FRAME_KIND_SNAPSHOT, flags, as_of_seq, 1, part)?;
            debug_assert!(frame.len() <= RC_DELTA_MAX_BYTES);
            Some(frame)
        })
        .collect()
}

/// The size of a kind-1 frame header for a batch starting at `seq_first` with
/// `count` envelopes — what the coalescer reserves before the payload.
pub fn header_len(seq_first: u64, count: u64) -> usize {
    let mut scratch = Vec::with_capacity(16);
    let _ = write_varint(&mut scratch, seq_first);
    let _ = write_varint(&mut scratch, count);
    3 + scratch.len()
}

/// The bytes one envelope adds to a batch's payload: its length varint and
/// itself.
pub fn entry_len(envelope_len: usize) -> usize {
    let mut scratch = Vec::with_capacity(8);
    let _ = write_varint(&mut scratch, envelope_len as u64);
    scratch.len() + envelope_len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_varint_round_trips_at_every_width_and_refuses_past_safe() {
        for value in [0, 1, 127, 128, 300, 1 << 32, MAX_SAFE_INTEGER] {
            let mut out = Vec::new();
            write_varint(&mut out, value).unwrap();
            let mut at = 0;
            assert_eq!(read_varint(&out, &mut at), Some(value));
            assert_eq!(at, out.len());
        }
        assert!(write_varint(&mut Vec::new(), MAX_SAFE_INTEGER + 1).is_none());
        // Nine continuation bytes: past the 8-byte cap.
        let mut at = 0;
        assert_eq!(read_varint(&[0x80; 9], &mut at), None);
        // Truncated.
        let mut at = 0;
        assert_eq!(read_varint(&[0x80], &mut at), None);
    }

    #[test]
    fn a_large_snapshot_is_split_into_parts_that_fit_a_frame() {
        let snapshot = vec![b'x'; RC_SNAPSHOT_PART_MAX_BYTES * 2 + 10];
        let frames = snapshot_frames(7, &snapshot).unwrap();
        assert_eq!(frames.len(), 3);
        let decoded: Vec<Frame> = frames.iter().map(|f| decode_frame(f).unwrap()).collect();
        assert!(frames.iter().all(|f| f.len() <= RC_DELTA_MAX_BYTES));
        assert_eq!(decoded[0].flags, FRAME_FLAG_MORE);
        assert_eq!(decoded[1].flags, FRAME_FLAG_MORE);
        assert_eq!(decoded[2].flags, 0);
        assert!(decoded
            .iter()
            .all(|f| f.seq_first == 7 && f.count == 1 && f.problem().is_none()));
        let whole: Vec<u8> = decoded.into_iter().flat_map(|f| f.payload).collect();
        assert_eq!(whole, snapshot);
    }

    #[test]
    fn the_header_estimate_matches_the_encoder() {
        for (seq, count) in [(1, 1), (300, 3), (1 << 40, 200)] {
            let envelopes: Vec<Vec<u8>> = (0..count).map(|_| b"{}".to_vec()).collect();
            let frame = encode_delta_batch(seq, &envelopes).unwrap();
            let payload: usize = envelopes.iter().map(|e| entry_len(e.len())).sum();
            assert_eq!(frame.len(), header_len(seq, count) + payload);
        }
    }

    #[test]
    fn a_batch_whose_lengths_do_not_add_up_is_refused() {
        let mut frame = decode_frame(&encode_delta_batch(1, &[b"{}"]).unwrap()).unwrap();
        frame.payload.push(b'!');
        assert!(decode_delta_batch(&frame).is_none());
    }
}
