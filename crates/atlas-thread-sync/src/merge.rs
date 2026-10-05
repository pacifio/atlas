//! A Run's three-way merge (ADR-0022, ATL-405, ATL-410): the fork state the
//! Run started from, the Run's result, and canonical state now.
//!
//! The merge is computed as line hunks — the fork against the Run's result —
//! applied to a document rebuilt from the fork snapshot. The resulting Yjs
//! update is what `merge.submit` carries: applied to canonical state it lands
//! the Run's hunks and leaves everybody else's edits since the fork alone.
//!
//! Hunks that overlap (or touch) a change canonical state made since the fork
//! — somebody's typing or another Run's merge — are **held**, not merged:
//! canonical state keeps its own version of those lines, and the hunk is
//! submitted beside the clean ones as a Conflict (ATL-410). The clean hunks
//! land at once either way.

use std::ops::Range;

use similar::{capture_diff_slices, Algorithm, DiffTag};

use crate::doc::{random_client_id, DocError, FileDoc};

/// One changed region: fork lines `old` became `new` lines of the other side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old: Range<usize>,
    pub new: Range<usize>,
}

/// A text as lines, each with its line ending.
pub fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// The hunks that turn `old` into `new`, in order.
pub fn hunks(old: &str, new: &str) -> Vec<Hunk> {
    let (a, b) = (lines(old), lines(new));
    capture_diff_slices(Algorithm::Myers, &a, &b)
        .into_iter()
        .filter_map(|op| {
            let (tag, old, new) = op.as_tag_tuple();
            (tag != DiffTag::Equal).then_some(Hunk { old, new })
        })
        .collect()
}

/// Do two fork ranges collide? Touching counts, as in git: two edits on
/// adjacent lines, or two insertions at one point, have no order anybody chose.
fn collide(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start <= b.end && b.start <= a.end
}

#[derive(Debug, thiserror::Error)]
pub enum MergeError {
    #[error(transparent)]
    Doc(#[from] DocError),
}

/// A hunk held back as a Conflict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// Canonical state's lines once the merge's clean hunks have landed,
    /// 0-based, `end` exclusive: where canonical's version of the hunk sits.
    pub lines: Range<usize>,
    /// The fork's lines there.
    pub base: String,
    /// Canonical state's version of them.
    pub canonical: String,
    /// The Run's version of them.
    pub run: String,
}

/// A merged file: the update to submit (`None` when every hunk was held or
/// already there), the content it produces on canonical state as this
/// replica holds it, and the hunks held back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub update: Option<Vec<u8>>,
    pub content: String,
    pub held: Vec<Held>,
}

/// The sum of `new.len() - old.len()` over `hunks`.
fn growth<'a>(hunks: impl Iterator<Item = &'a Hunk>) -> isize {
    hunks
        .map(|h| h.new.len() as isize - h.old.len() as isize)
        .sum()
}

fn shift(at: usize, by: isize) -> usize {
    (at as isize + by).max(0) as usize
}

/// Merge the Run's result `run` for one file.
///
/// `fork` is the file's document at the Run's fork, `canonical` the document
/// now (both as [`FileDoc::snapshot`]s). Answers `None` when the Run left the
/// file as it forked it, or when canonical state already holds every hunk.
pub fn three_way(fork: &[u8], run: &str, canonical: &[u8]) -> Result<Option<Merged>, MergeError> {
    // Each merge edits under a client id of its own: the fork document's
    // clocks were the replica's at the fork, and the live document has moved
    // on under that id since — reusing it would collide.
    let fork_doc = FileDoc::from_snapshot(random_client_id(), fork)?;
    let fork_text = fork_doc.content();
    if fork_text == run {
        return Ok(None);
    }
    let canonical_doc = FileDoc::from_snapshot(random_client_id(), canonical)?;
    let canonical_text = canonical_doc.content();

    let ours = hunks(&fork_text, run);
    let theirs = hunks(&fork_text, &canonical_text);
    let (fork_lines, run_lines, canon_lines) =
        (lines(&fork_text), lines(run), lines(&canonical_text));
    // The same edit made on both sides is already there.
    let same = |h: &Hunk| {
        theirs
            .iter()
            .any(|t| t.old == h.old && run_lines[h.new.clone()] == canon_lines[t.new.clone()])
    };
    let candidates: Vec<&Hunk> = ours.iter().filter(|h| !same(h)).collect();

    // Conflict regions, in fork lines: each starts as a hunk of ours that
    // collides with one of theirs, and grows to take in every hunk — either
    // side's — that collides with it, until none does. What is left of ours
    // is clean.
    let mut spans: Vec<Range<usize>> = candidates
        .iter()
        .filter(|h| theirs.iter().any(|t| collide(&h.old, &t.old)))
        .map(|h| h.old.clone())
        .collect();
    loop {
        let mut grew = false;
        for span in spans.iter_mut() {
            for r in theirs
                .iter()
                .map(|t| &t.old)
                .chain(candidates.iter().map(|h| &h.old))
            {
                if collide(span, r) && (r.start < span.start || r.end > span.end) {
                    *span = span.start.min(r.start)..span.end.max(r.end);
                    grew = true;
                }
            }
        }
        spans.sort_by_key(|s| (s.start, s.end));
        let mut joined: Vec<Range<usize>> = Vec::with_capacity(spans.len());
        for span in spans.drain(..) {
            match joined.last_mut() {
                Some(last) if collide(last, &span) => {
                    last.end = last.end.max(span.end);
                    grew = true;
                }
                _ => joined.push(span),
            }
        }
        spans = joined;
        if !grew {
            break;
        }
    }
    let inside = |r: &Range<usize>| spans.iter().any(|s| collide(s, r));
    let kept: Vec<Hunk> = candidates
        .into_iter()
        .filter(|h| !inside(&h.old))
        .cloned()
        .collect();

    let held: Vec<Held> = spans
        .iter()
        .map(|span| {
            let before = |r: &Range<usize>| r.end < span.start;
            let within = |r: &Range<usize>| collide(span, r);
            let theirs_before = growth(theirs.iter().filter(|t| before(&t.old)));
            let theirs_within = growth(theirs.iter().filter(|t| within(&t.old)));
            let ours_before = growth(ours.iter().filter(|h| before(&h.old)));
            let ours_within = growth(ours.iter().filter(|h| within(&h.old)));
            let kept_before = growth(kept.iter().filter(|h| before(&h.old)));
            let canon =
                shift(span.start, theirs_before)..shift(span.end, theirs_before + theirs_within);
            let mine = shift(span.start, ours_before)..shift(span.end, ours_before + ours_within);
            let at = shift(canon.start, kept_before);
            Held {
                lines: at..at + canon.len(),
                base: fork_lines[span.clone()].concat(),
                canonical: canon_lines[canon].concat(),
                run: run_lines[mine].concat(),
            }
        })
        .collect();

    let update = fork_doc.replace_lines(&fork_text, &kept, run);
    if update.is_none() && held.is_empty() {
        return Ok(None);
    }
    if let Some(update) = &update {
        canonical_doc.apply(update)?;
    }
    Ok(Some(Merged {
        update,
        content: canonical_doc.content(),
        held,
    }))
}

/// What `region` of `before` (lines) became in `after`: the hunks that turn
/// one into the other, mapped onto it. A hunk that reaches past the region
/// takes the region with it, so what is answered is whole lines of `after`.
pub fn region_after(before: &str, after: &str, region: Range<usize>) -> String {
    let changes = hunks(before, after);
    let mut span = region;
    loop {
        let grown = changes
            .iter()
            .filter(|h| collide(&span, &h.old))
            .fold(span.clone(), |s, h| {
                s.start.min(h.old.start)..s.end.max(h.old.end)
            });
        if grown == span {
            break;
        }
        span = grown;
    }
    let before_by = growth(changes.iter().filter(|h| h.old.end < span.start));
    let within_by = growth(changes.iter().filter(|h| collide(&span, &h.old)));
    let after_lines = lines(after);
    let start = shift(span.start, before_by).min(after_lines.len());
    let end = shift(span.end, before_by + within_by).clamp(start, after_lines.len());
    after_lines[start..end].concat()
}

/// The proposed result for a Conflict's hunk: one side when only it changed
/// the base, both — canonical's first, each on lines of its own — when each did.
pub fn proposal(base: &str, canonical: &str, run: &str) -> String {
    if canonical == base {
        run.to_string()
    } else if run == base || run == canonical {
        canonical.to_string()
    } else {
        join_hunks(canonical, run)
    }
}

/// Both sides of a hunk, canonical's first, each on lines of its own (the
/// web's `joinHunks`).
pub fn join_hunks(canonical: &str, run: &str) -> String {
    if canonical.is_empty() || canonical.ends_with('\n') {
        format!("{canonical}{run}")
    } else {
        format!("{canonical}\n{run}")
    }
}

/// Find `hunk` — canonical's lines of a Conflict as they were raised — in
/// `text` now, nearest to line `near`: typing elsewhere moves it, typing in
/// it means it cannot be found and the Conflict needs a fresh look.
pub fn locate(text: &str, hunk: &str, near: usize) -> Option<Range<usize>> {
    let have = lines(text);
    let want = lines(hunk);
    if want.is_empty() {
        return Some(near.min(have.len())..near.min(have.len()));
    }
    (0..=have.len().saturating_sub(want.len()))
        .filter(|&i| have[i..i + want.len()] == want[..])
        .min_by_key(|&i| i.abs_diff(near))
        .map(|i| i..i + want.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> FileDoc {
        let d = FileDoc::new(random_client_id());
        for u in FileDoc::seed_updates(text) {
            d.apply(&u).unwrap();
        }
        d
    }

    const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\n";

    #[test]
    fn both_sides_keep_lines_of_their_own() {
        assert_eq!(join_hunks("TWO\n", "2\n"), "TWO\n2\n");
        assert_eq!(join_hunks("TWO", "2\n"), "TWO\n2\n");
        assert_eq!(join_hunks("", "2\n"), "2\n");
        assert_eq!(proposal("two\n", "TWO", "2\n"), "TWO\n2\n");
    }

    #[test]
    fn far_apart_edits_both_survive_and_the_middle_is_untouched() {
        let fork = doc(BASE);
        let canonical = FileDoc::from_snapshot(random_client_id(), &fork.snapshot()).unwrap();
        canonical.set_content("one\ntwo\nthree\nFOUR\nfive\nsix\n");
        let run = "ONE\ntwo\nthree\nfour\nfive\nSIX\n";
        let merged = three_way(&fork.snapshot(), run, &canonical.snapshot())
            .unwrap()
            .unwrap();
        assert_eq!(merged.content, "ONE\ntwo\nthree\nFOUR\nfive\nSIX\n");
        assert!(merged.held.is_empty());
        canonical.apply(merged.update.as_ref().unwrap()).unwrap();
        assert_eq!(canonical.content(), merged.content);
    }

    #[test]
    fn overlapping_and_touching_edits_are_held_and_the_rest_lands() {
        let fork = doc(BASE);
        let canonical = FileDoc::from_snapshot(random_client_id(), &fork.snapshot()).unwrap();
        canonical.set_content("one\ntwo\nTHREE\nfour\nfive\nsix\n");
        // Overlapping: the same line.
        let merged = three_way(
            &fork.snapshot(),
            "ONE\ntwo\nthree!\nfour\nfive\nsix\n",
            &canonical.snapshot(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(merged.content, "ONE\ntwo\nTHREE\nfour\nfive\nsix\n");
        assert_eq!(
            merged.held,
            vec![Held {
                lines: 2..3,
                base: "three\n".into(),
                canonical: "THREE\n".into(),
                run: "three!\n".into(),
            }]
        );
        // Touching: the next line. One region, both lines.
        let merged = three_way(
            &fork.snapshot(),
            "one\ntwo\nthree\nfour?\nfive\nsix\n",
            &canonical.snapshot(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(merged.update, None);
        assert_eq!(merged.content, "one\ntwo\nTHREE\nfour\nfive\nsix\n");
        assert_eq!(merged.held[0].base, "three\nfour\n");
        assert_eq!(merged.held[0].canonical, "THREE\nfour\n");
        assert_eq!(merged.held[0].run, "three\nfour?\n");
        assert_eq!(merged.held[0].lines, 2..4);
    }

    #[test]
    fn a_held_hunks_lines_count_the_clean_hunks_that_landed_before_it() {
        let fork = doc(BASE);
        let canonical = FileDoc::from_snapshot(random_client_id(), &fork.snapshot()).unwrap();
        canonical.set_content("one\ntwo\nthree\nfour\nFIVE\nsix\n");
        // The Run adds two lines at the top (clean) and changes line five.
        let run = "zero\nzero.5\none\ntwo\nthree\nfour\nfive!\nsix\n";
        let merged = three_way(&fork.snapshot(), run, &canonical.snapshot())
            .unwrap()
            .unwrap();
        assert_eq!(
            merged.content,
            "zero\nzero.5\none\ntwo\nthree\nfour\nFIVE\nsix\n"
        );
        assert_eq!(merged.held.len(), 1);
        assert_eq!(merged.held[0].lines, 6..7);
        let at = lines(&merged.content)[merged.held[0].lines.clone()].concat();
        assert_eq!(at, merged.held[0].canonical);
        assert_eq!(merged.held[0].run, "five!\n");
    }

    #[test]
    fn a_conflicts_hunk_is_found_again_after_typing_elsewhere() {
        let text = "a\nb\nX\nY\nc\nX\nY\n";
        assert_eq!(locate(text, "X\nY\n", 2), Some(2..4));
        assert_eq!(locate(text, "X\nY\n", 6), Some(5..7));
        assert_eq!(locate(text, "Z\n", 2), None);
        assert_eq!(proposal("a\n", "a\n", "b\n"), "b\n");
        assert_eq!(proposal("a\n", "c\n", "b\n"), "c\nb\n");
    }

    #[test]
    fn an_agents_rewrite_of_a_region_is_read_back_whole() {
        let before = "a\nb\nX\nY\nc\n";
        let after = "a!\nb\nZ\nc\n";
        assert_eq!(region_after(before, after, 2..4), "Z\n");
        assert_eq!(region_after(before, before, 2..4), "X\nY\n");
        assert_eq!(
            region_after(before, "a\nb\nX\nnew\nY\nc\n", 2..4),
            "X\nnew\nY\n"
        );
    }

    #[test]
    fn the_same_edit_on_both_sides_is_not_duplicated() {
        let fork = doc(BASE);
        let canonical = FileDoc::from_snapshot(random_client_id(), &fork.snapshot()).unwrap();
        canonical.set_content("one\ntwo\nTHREE\nfour\nfive\nsix\n");
        let merged = three_way(
            &fork.snapshot(),
            "one\ntwo\nTHREE\nfour\nfive\nsix!\n",
            &canonical.snapshot(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(merged.content, "one\ntwo\nTHREE\nfour\nfive\nsix!\n");
        assert_eq!(
            three_way(&fork.snapshot(), BASE, &canonical.snapshot()).unwrap(),
            None
        );
    }

    #[test]
    fn a_file_without_a_trailing_newline_and_astral_text_merge_whole() {
        let fork = doc("a🚀\nb\nc");
        let canonical = FileDoc::from_snapshot(random_client_id(), &fork.snapshot()).unwrap();
        let merged = three_way(&fork.snapshot(), "a🚀\nb\nc🚁", &canonical.snapshot())
            .unwrap()
            .unwrap();
        assert_eq!(merged.content, "a🚀\nb\nc🚁");
    }
}
