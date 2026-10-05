//! One touched text file as a Yjs document.
//!
//! Two details are part of the contract with every other replica — the web
//! viewer runs `yjs` itself — and are not free choices:
//!
//! * the text lives under the root name [`TEXT_NAME`];
//! * offsets count **UTF-16** units, as Yjs in a browser does.
//!
//! And one trick makes a file's starting point safe without coordination.
//! Every replica that holds the Base builds the file's Base content as the same
//! updates — same client id ([`SEED_CLIENT`]), same clocks, same chunks — so the
//! seed is byte-identical everywhere and applying it twice, or from two
//! replicas, changes nothing. Edits then happen under each replica's own
//! random client id.

use base64::Engine as _;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode as _;
use yrs::{
    Assoc, Doc, GetString, IndexedSequence, OffsetKind, Options, ReadTxn, StateVector, StickyIndex,
    Text, TextRef, Transact, Update,
};

pub const TEXT_NAME: &str = "content";

/// The client id every replica seeds Base content under. Never used for edits.
pub const SEED_CLIENT: u64 = 1;

/// Seed chunk size in UTF-8 bytes, comfortably under the wire's payload cap
/// once Yjs' own encoding is added.
const SEED_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error("not a Yjs update: {0}")]
    Decode(String),
    #[error("could not apply update: {0}")]
    Apply(String),
}

fn options(client_id: u64) -> Options {
    let mut options = Options::with_client_id(client_id);
    options.offset_kind = OffsetKind::Utf16;
    options
}

/// A replica's own Yjs client id: random, never the seed's.
pub fn random_client_id() -> u64 {
    let n = uuid::Uuid::new_v4().as_u128() as u64 & 0x7fff_ffff;
    n.max(SEED_CLIENT + 1)
}

pub struct FileDoc {
    doc: Doc,
    text: TextRef,
}

/// Lines of a file, 1-based and inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LineSpan {
    pub start: u32,
    pub end: u32,
}

/// Where a comment on a Shared Thread's lines is (ATL-413, ATL-416): Yjs
/// relative positions into the file's text, base64 — the same encoding the
/// web's `yjs` writes, so either side resolves the other's — and the lines as
/// they read when it was made.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RangeAnchor {
    pub start: String,
    pub end: String,
    pub quote: String,
}

/// Where each line of `text` starts, as (UTF-16 offset, byte offset).
fn line_starts(text: &str) -> Vec<(u32, usize)> {
    let mut starts = vec![(0, 0)];
    let mut utf16 = 0u32;
    for (byte, ch) in text.char_indices() {
        utf16 += ch.len_utf16() as u32;
        if ch == '\n' {
            starts.push((utf16, byte + 1));
        }
    }
    starts
}

impl FileDoc {
    pub fn new(client_id: u64) -> Self {
        let doc = Doc::with_options(options(client_id));
        let text = doc.get_or_insert_text(TEXT_NAME);
        Self { doc, text }
    }

    /// The deterministic updates that build `base` from nothing.
    pub fn seed_updates(base: &str) -> Vec<Vec<u8>> {
        let doc = Doc::with_options(options(SEED_CLIENT));
        let text = doc.get_or_insert_text(TEXT_NAME);
        let mut updates = Vec::new();
        let mut rest = base;
        while !rest.is_empty() {
            let mut cut = rest.len().min(SEED_CHUNK_BYTES);
            while !rest.is_char_boundary(cut) {
                cut -= 1;
            }
            let (chunk, tail) = rest.split_at(cut);
            let mut txn = doc.transact_mut();
            text.push(&mut txn, chunk);
            updates.push(txn.encode_update_v1());
            drop(txn);
            rest = tail;
        }
        updates
    }

    pub fn apply(&self, update: &[u8]) -> Result<(), DocError> {
        let update = Update::decode_v1(update).map_err(|e| DocError::Decode(e.to_string()))?;
        let mut txn = self.doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| DocError::Apply(e.to_string()))
    }

    /// The whole document as one update, to rebuild it later with
    /// [`FileDoc::from_snapshot`].
    pub fn snapshot(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// The document's state vector, encoded: what it has seen.
    pub fn state_vector(&self) -> Vec<u8> {
        use yrs::updates::encoder::Encode;
        self.doc.transact().state_vector().encode_v1()
    }

    /// Everything the document has that a peer at `state_vector` lacks, as
    /// one update (ATL-407: what an editor bound to it still needs).
    pub fn diff(&self, state_vector: &[u8]) -> Result<Vec<u8>, DocError> {
        let sv =
            StateVector::decode_v1(state_vector).map_err(|e| DocError::Decode(e.to_string()))?;
        Ok(self.doc.transact().encode_state_as_update_v1(&sv))
    }

    /// A document in exactly the state `snapshot` recorded, editing under
    /// `client_id`. Used to make an edit *relative to that moment* and merge
    /// it into the live document — a three-way merge done by the CRDT.
    pub fn from_snapshot(client_id: u64, snapshot: &[u8]) -> Result<Self, DocError> {
        let doc = Self::new(client_id);
        doc.apply(snapshot)?;
        Ok(doc)
    }

    pub fn content(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }

    /// Anchor lines `span` of the text (ATL-416): relative positions that
    /// follow it through edits, and the lines as they read now. The start
    /// sticks to the range's first character and the end to its last, so
    /// typing just outside it never widens it — as the web anchors them.
    /// `None` for lines the text does not have.
    pub fn anchor_lines(&self, span: LineSpan) -> Option<RangeAnchor> {
        let text = self.content();
        let starts = line_starts(&text);
        if span.start < 1 || span.end < span.start || span.start as usize > starts.len() {
            return None;
        }
        let total = (text.encode_utf16().count() as u32, text.len());
        let from = starts[span.start as usize - 1];
        let to = starts.get(span.end as usize).copied().unwrap_or(total);
        if to.0 <= from.0 {
            return None;
        }
        let mut txn = self.doc.transact_mut();
        let start = self.text.sticky_index(&mut txn, from.0, Assoc::After)?;
        let end = self.text.sticky_index(&mut txn, to.0, Assoc::Before)?;
        let b64 = base64::engine::general_purpose::STANDARD;
        Some(RangeAnchor {
            start: b64.encode(start.encode_v1()),
            end: b64.encode(end.encode_v1()),
            quote: text[from.1..to.1].to_string(),
        })
    }

    /// The lines an anchor covers in the text now, or `None` when the text
    /// it was on is gone — the comment is outdated and shows its quote.
    pub fn resolve_lines(&self, start: &str, end: &str) -> Option<LineSpan> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let start = StickyIndex::decode_v1(&b64.decode(start).ok()?).ok()?;
        let end = StickyIndex::decode_v1(&b64.decode(end).ok()?).ok()?;
        let txn = self.doc.transact();
        let from = start.get_offset(&txn)?.index;
        let to = end.get_offset(&txn)?.index;
        if to <= from {
            return None;
        }
        let text = self.text.get_string(&txn);
        let starts = line_starts(&text);
        let line_of = |offset: u32| starts.partition_point(|(s, _)| *s <= offset) as u32;
        // The end sits after the range's last character; that character's
        // line is the last one.
        Some(LineSpan {
            start: line_of(from),
            end: line_of(to - 1),
        })
    }

    /// Make the text equal `next` with the smallest single edit, and answer the
    /// updates to send — none when it already was.
    ///
    /// One replace between the common prefix and suffix rather than a full
    /// diff: a save from an editor is usually one region, and a replace of the
    /// changed span keeps concurrent edits elsewhere in the file intact. The
    /// span is widened so it never splits a surrogate pair.
    ///
    /// A large insertion — a pasted file, an edit made offline — is made in
    /// pieces of at most [`SEED_CHUNK_BYTES`], one update each, so every
    /// update fits one wire frame (ATL-404). Applied in order they are the
    /// same edit.
    pub fn set_content(&self, next: &str) -> Vec<Vec<u8>> {
        let current = self.content();
        if current == next {
            return Vec::new();
        }
        let old: Vec<u16> = current.encode_utf16().collect();
        let new: Vec<u16> = next.encode_utf16().collect();
        let mut prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
        while prefix > 0 && is_high_surrogate(old[prefix - 1]) {
            prefix -= 1;
        }
        let max_suffix = old.len().min(new.len()) - prefix;
        let mut suffix = old
            .iter()
            .rev()
            .zip(new.iter().rev())
            .take(max_suffix)
            .take_while(|(a, b)| a == b)
            .count();
        while suffix > 0 && is_low_surrogate(old[old.len() - suffix]) {
            suffix -= 1;
        }
        let removed = old.len() - prefix - suffix;
        let inserted = String::from_utf16_lossy(&new[prefix..new.len() - suffix]);

        let mut updates = Vec::new();
        let mut at = prefix as u32;
        let mut rest = inserted.as_str();
        let mut first = true;
        while first || !rest.is_empty() {
            let mut cut = rest.len().min(SEED_CHUNK_BYTES);
            while !rest.is_char_boundary(cut) {
                cut -= 1;
            }
            let (chunk, tail) = rest.split_at(cut);
            let mut txn = self.doc.transact_mut();
            if first && removed > 0 {
                self.text.remove_range(&mut txn, at, removed as u32);
            }
            if !chunk.is_empty() {
                self.text.insert(&mut txn, at, chunk);
            }
            updates.push(txn.encode_update_v1());
            drop(txn);
            at += chunk.encode_utf16().count() as u32;
            rest = tail;
            first = false;
        }
        updates
    }
}

impl FileDoc {
    /// Replace whole lines of the text, hunk by hunk, and answer the update —
    /// or `None` for no hunks. The text must currently be `old`.
    ///
    /// One edit per hunk rather than [`FileDoc::set_content`]'s single span:
    /// a Run's result is merged into a canonical state that moved since the
    /// fork, and a span covering two far-apart hunks would delete (and
    /// re-insert) everything between them, undoing what others did there.
    /// A Yjs update that changes nothing: what a Conflict resolution that
    /// keeps canonical state's hunk carries (ATL-410).
    pub fn empty_update() -> Vec<u8> {
        let doc = FileDoc::new(random_client_id());
        let txn = doc.doc.transact_mut();
        txn.encode_update_v1()
    }

    pub fn replace_lines(
        &self,
        old: &str,
        hunks: &[crate::merge::Hunk],
        new: &str,
    ) -> Option<Vec<u8>> {
        if hunks.is_empty() {
            return None;
        }
        let old_lines = crate::merge::lines(old);
        let new_lines = crate::merge::lines(new);
        let mut offsets = Vec::with_capacity(old_lines.len() + 1);
        let mut at = 0u32;
        offsets.push(at);
        for line in &old_lines {
            at += line.encode_utf16().count() as u32;
            offsets.push(at);
        }
        let mut txn = self.doc.transact_mut();
        // Back to front, so each hunk's offsets are still the fork's.
        for hunk in hunks.iter().rev() {
            let start = offsets[hunk.old.start];
            let removed = offsets[hunk.old.end] - start;
            if removed > 0 {
                self.text.remove_range(&mut txn, start, removed);
            }
            let inserted: String = new_lines[hunk.new.clone()].concat();
            if !inserted.is_empty() {
                self.text.insert(&mut txn, start, &inserted);
            }
        }
        Some(txn.encode_update_v1())
    }
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xd800..0xdc00).contains(&unit)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_from_two_replicas_does_not_duplicate() {
        let base = "line one\nline two\n";
        let a = FileDoc::new(random_client_id());
        let b = FileDoc::new(random_client_id());
        for u in FileDoc::seed_updates(base) {
            a.apply(&u).unwrap();
            b.apply(&u).unwrap();
        }
        // b's seed arrives at a again, as it would from the journal.
        for u in FileDoc::seed_updates(base) {
            a.apply(&u).unwrap();
        }
        assert_eq!(a.content(), base);
        assert_eq!(FileDoc::seed_updates(base), FileDoc::seed_updates(base));
    }

    #[test]
    fn large_bases_seed_in_chunks_that_fit_the_wire() {
        let base = "é".repeat(100_000);
        let updates = FileDoc::seed_updates(&base);
        assert!(updates.len() > 1);
        assert!(updates
            .iter()
            .all(|u| u.len() < crate::wire::MAX_PAYLOAD_BYTES));
        let doc = FileDoc::new(random_client_id());
        for u in &updates {
            doc.apply(u).unwrap();
        }
        assert_eq!(doc.content(), base);
    }

    #[test]
    fn concurrent_edits_in_different_places_both_survive() {
        let base = "alpha\nbeta\ngamma\n";
        let a = FileDoc::new(random_client_id());
        let b = FileDoc::new(random_client_id());
        for u in FileDoc::seed_updates(base) {
            a.apply(&u).unwrap();
            b.apply(&u).unwrap();
        }
        let ua = a.set_content("ALPHA\nbeta\ngamma\n");
        let ub = b.set_content("alpha\nbeta\nGAMMA 🚀\n");
        for u in &ub {
            a.apply(u).unwrap();
        }
        for u in &ua {
            b.apply(u).unwrap();
        }
        assert_eq!(a.content(), "ALPHA\nbeta\nGAMMA 🚀\n");
        assert_eq!(a.content(), b.content());
        assert!(a.set_content(&a.content()).is_empty());
    }

    #[test]
    fn a_large_edit_goes_in_pieces_that_each_fit_a_frame() {
        let a = FileDoc::new(random_client_id());
        let b = FileDoc::new(random_client_id());
        let big = format!("head\n{}tail\n", "é🚀 lockfile line\n".repeat(30_000));
        let updates = a.set_content(&big);
        assert!(updates.len() > 1);
        assert!(updates
            .iter()
            .all(|u| u.len() < crate::wire::MAX_PAYLOAD_BYTES));
        for u in &updates {
            b.apply(u).unwrap();
        }
        assert_eq!(b.content(), big);
        // And a large replacement in the middle of existing text.
        let replaced = format!("head\n{}tail\n", "x".repeat(400_000));
        for u in a.set_content(&replaced) {
            assert!(u.len() < crate::wire::MAX_PAYLOAD_BYTES);
            b.apply(&u).unwrap();
        }
        assert_eq!(b.content(), replaced);
    }

    #[test]
    fn edits_next_to_astral_characters_keep_them_whole() {
        let doc = FileDoc::new(random_client_id());
        doc.set_content("a🚀b");
        doc.set_content("a🚁b");
        assert_eq!(doc.content(), "a🚁b");
        doc.set_content("🚀🚁");
        assert_eq!(doc.content(), "🚀🚁");
    }
}
