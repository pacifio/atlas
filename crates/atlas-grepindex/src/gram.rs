//! Sparse n-grams (the danlark1 / GitHub Blackbird / Cursor rule) over ASCII-folded bytes.
//!
//! Every adjacent byte pair (bigram) gets a weight: rare pairs weigh more. A substring of
//! `MIN_GRAM_LEN..=MAX_GRAM_LEN` bytes is a *sparse gram* when every interior bigram weight is
//! strictly below both end bigram weights; every trigram qualifies (it has no interior). Whether
//! a substring is a gram depends only on its own bytes, so each gram of a literal is also a gram
//! of every text that contains the literal. That is the property the index's soundness rests on,
//! and `tests` pins it with proptests.

use std::sync::OnceLock;

pub const MIN_GRAM_LEN: usize = 3;
pub const MAX_GRAM_LEN: usize = 8;
/// Identifies [`fold_byte`]; stored in the index header.
pub const FOLD_ID: u32 = 1;

/// 128 x 128 little-endian `u16` frequency ranks, produced by `examples/gen_bigram_table.rs`.
static BIGRAM_RANKS: &[u8; 2 * 128 * 128] = include_bytes!("../data/bigram_rank_v1.bin");

/// The index is case-insensitive for ASCII: both documents and query literals are folded with
/// this before extraction. Non-ASCII bytes are left alone.
#[inline]
pub fn fold_byte(b: u8) -> u8 {
    b.to_ascii_lowercase()
}

pub fn fold(src: &[u8]) -> Vec<u8> {
    src.iter().map(|&b| fold_byte(b)).collect()
}

/// Weight of the bigram `(a, b)`: its frequency rank for ASCII pairs (0 = most frequent), and a
/// value above every ASCII rank, unique per pair, when either byte is non-ASCII. Distinct pairs
/// never share a weight, so ties only happen between identical pairs.
#[inline]
pub fn weight(a: u8, b: u8) -> u32 {
    if a < 128 && b < 128 {
        let i = 2 * (usize::from(a) * 128 + usize::from(b));
        u32::from(u16::from_le_bytes([BIGRAM_RANKS[i], BIGRAM_RANKS[i + 1]]))
    } else {
        0x1_0000 + ((u32::from(a) << 8) | u32::from(b))
    }
}

/// Content hash of the weight table; any change to the table changes every gram boundary, so
/// the index header stores this and a mismatch forces a rebuild.
pub fn weight_table_id() -> u64 {
    static ID: OnceLock<u64> = OnceLock::new();
    *ID.get_or_init(|| fnv1a64(BIGRAM_RANKS))
}

pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Calls `emit(start, len)` for every sparse gram of `s` under the weight function `w`
/// (with repeats when the same gram occurs twice). `s` must already be folded.
pub fn for_each_span_by(s: &[u8], w: impl Fn(u8, u8) -> u32, mut emit: impl FnMut(usize, usize)) {
    if s.len() < MIN_GRAM_LEN {
        return;
    }
    // weights[i] is the weight of bigram i = (s[i], s[i + 1]).
    let weights: Vec<u32> = s.windows(2).map(|p| w(p[0], p[1])).collect();
    let last_bigram = weights.len() - 1;
    for a in 0..last_bigram {
        let left = weights[a];
        let mut max_inner = 0;
        // b is the right end bigram; the gram is s[a..b + 2], b - a + 2 bytes long.
        for b in a + 1..=(a + MAX_GRAM_LEN - 2).min(last_bigram) {
            if b > a + 1 {
                max_inner = if b == a + 2 {
                    weights[a + 1]
                } else {
                    max_inner.max(weights[b - 1])
                };
                if max_inner >= left {
                    break; // the interior only grows, so no longer gram from `a` qualifies
                }
                if max_inner >= weights[b] {
                    continue;
                }
            }
            emit(a, b - a + 2);
        }
    }
}

/// Every sparse gram of the folded text `s` (the index side, "build_all").
pub fn for_each_gram(s: &[u8], mut emit: impl FnMut(&[u8])) {
    for_each_span_by(s, weight, |start, len| emit(&s[start..start + len]));
}

/// A minimum-size set of sparse grams of the folded literal `s` that together cover every
/// bigram of `s` (the query side, "build_covering"). Each gram is one [`for_each_gram`] yields
/// for `s`, hence for any text containing `s`. Empty when `s` is shorter than `MIN_GRAM_LEN`.
pub fn cover(s: &[u8]) -> Vec<&[u8]> {
    let n = s.len();
    if n < MIN_GRAM_LEN {
        return Vec::new();
    }
    // best_end[a] = furthest exclusive end of a gram starting at byte a.
    let mut best_end = vec![0usize; n];
    for_each_span_by(s, weight, |start, len| {
        best_end[start] = best_end[start].max(start + len);
    });
    // Greedy furthest reach over interval starts: `pos` is the first bigram not yet covered.
    let mut out = Vec::new();
    let (mut pos, mut next_start, mut best) = (0usize, 0usize, (0usize, 0usize));
    while pos + 1 < n {
        while next_start <= pos {
            if best_end[next_start] > best.1 {
                best = (next_start, best_end[next_start]);
            }
            next_start += 1;
        }
        debug_assert!(
            best.1 >= pos + 2,
            "the trigram at min(pos, n - 3) always reaches"
        );
        out.push(&s[best.0..best.1]);
        pos = best.1 - 1;
    }
    out
}

/// 32-bit posting-table key of a gram: 3 bits of `len - 3`, then 29 bits of payload (the raw
/// bytes for trigrams, a multiplicative hash otherwise). Grams of different lengths never share
/// a key; a hash collision only merges two posting lists, which widens candidates (still sound).
pub fn key(gram: &[u8]) -> u32 {
    debug_assert!((MIN_GRAM_LEN..=MAX_GRAM_LEN).contains(&gram.len()));
    let len_tag = (gram.len() - MIN_GRAM_LEN) as u32;
    let payload = if gram.len() == MIN_GRAM_LEN {
        u32::from(gram[0]) | (u32::from(gram[1]) << 8) | (u32::from(gram[2]) << 16)
    } else {
        let mut buf = [0u8; 8];
        buf[..gram.len()].copy_from_slice(gram);
        (u64::from_le_bytes(buf).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 35) as u32
    };
    (len_tag << 29) | (payload & 0x1FFF_FFFF)
}

/// Sorted, deduplicated keys of every gram of `raw` (folded here).
pub fn doc_keys(raw: &[u8]) -> Vec<u32> {
    let folded = fold(raw);
    let mut keys = Vec::with_capacity(folded.len());
    for_each_gram(&folded, |g| keys.push(key(g)));
    keys.sort_unstable();
    keys.dedup();
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::HashSet;

    /// The definition, verbatim: every substring of 3..=8 bytes whose interior bigram weights
    /// are all strictly below both end weights.
    fn brute_force(s: &[u8], w: impl Fn(u8, u8) -> u32) -> HashSet<Vec<u8>> {
        let mut out = HashSet::new();
        for len in MIN_GRAM_LEN..=MAX_GRAM_LEN {
            for start in 0..=s.len().saturating_sub(len) {
                if start + len > s.len() {
                    break;
                }
                let g = &s[start..start + len];
                let left = w(g[0], g[1]);
                let right = w(g[len - 2], g[len - 1]);
                if (1..len - 2).all(|k| w(g[k], g[k + 1]) < left.min(right)) {
                    out.insert(g.to_vec());
                }
            }
        }
        out
    }

    fn all_grams(s: &[u8]) -> HashSet<Vec<u8>> {
        let mut out = HashSet::new();
        for_each_gram(s, |g| {
            out.insert(g.to_vec());
        });
        out
    }

    fn ascii_text() -> impl Strategy<Value = Vec<u8>> {
        prop::collection::vec(
            prop::sample::select(b"abcdefgh_ (){};.\n\tXYZ=".to_vec()),
            0..300,
        )
        .prop_map(|v| fold(&v))
    }

    fn two_letter_text() -> impl Strategy<Value = Vec<u8>> {
        prop::collection::vec(prop::sample::select(b"ab".to_vec()), 0..120)
    }

    fn any_bytes() -> impl Strategy<Value = Vec<u8>> {
        prop::collection::vec(any::<u8>(), 0..200).prop_map(|v| fold(&v))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn build_all_matches_definition(s in ascii_text()) {
            prop_assert_eq!(all_grams(&s), brute_force(&s, weight));
        }

        #[test]
        fn build_all_matches_definition_on_ties(s in two_letter_text()) {
            prop_assert_eq!(all_grams(&s), brute_force(&s, weight));
        }

        #[test]
        fn build_all_matches_definition_on_raw_bytes(s in any_bytes()) {
            prop_assert_eq!(all_grams(&s), brute_force(&s, weight));
        }

        #[test]
        fn cover_is_subset_of_build_all(doc in ascii_text(), a in 0usize..300, len in 0usize..40) {
            let a = a.min(doc.len());
            let q = &doc[a..(a + len).min(doc.len())];
            let all = all_grams(&doc);
            for g in cover(q) {
                prop_assert!(all.contains(g), "cover gram {g:?} of {q:?} missing");
            }
        }

        #[test]
        fn cover_is_subset_of_build_all_on_ties(doc in two_letter_text(), a in 0usize..120, len in 0usize..30) {
            let a = a.min(doc.len());
            let q = &doc[a..(a + len).min(doc.len())];
            let all = all_grams(&doc);
            for g in cover(q) {
                prop_assert!(all.contains(g));
            }
        }

        #[test]
        fn cover_covers_every_bigram(q in ascii_text()) {
            let grams = cover(&q);
            if q.len() < MIN_GRAM_LEN {
                prop_assert!(grams.is_empty());
            } else {
                let base = q.as_ptr() as usize;
                let mut covered = vec![false; q.len() - 1];
                for g in &grams {
                    prop_assert!((MIN_GRAM_LEN..=MAX_GRAM_LEN).contains(&g.len()));
                    let start = g.as_ptr() as usize - base;
                    for c in &mut covered[start..start + g.len() - 1] {
                        *c = true;
                    }
                }
                prop_assert!(covered.iter().all(|&c| c));
            }
        }

        /// Cross-check against GitHub's implementation (sparse-ngrams 0.4) with its own weights.
        /// Its priorities are "low = rare", so invert them; restrict to ASCII, where its
        /// priorities are unique like ours.
        #[test]
        fn agrees_with_github_sparse_ngrams(s in ascii_text()) {
            let w = |a: u8, b: u8| u32::MAX - sparse_ngrams::bigram_priority(a, b);
            let mut ours = HashSet::new();
            for_each_span_by(&s, w, |start, len| {
                ours.insert(sparse_ngrams::NGram::from_bytes(&s[start..start + len]));
            });
            let theirs: HashSet<sparse_ngrams::NGram> = sparse_ngrams::collect_sparse_grams(&s)
                .into_iter()
                .filter(|g| g.len() >= MIN_GRAM_LEN)
                .collect();
            prop_assert_eq!(ours, theirs);
        }
    }

    #[test]
    fn every_trigram_is_a_gram() {
        let s = fold(b"fn main() { println!(\"hello\"); }");
        let all = all_grams(&s);
        for t in s.windows(3) {
            assert!(all.contains(t), "{:?}", String::from_utf8_lossy(t));
        }
    }

    #[test]
    fn short_inputs_have_no_grams() {
        assert!(cover(b"ab").is_empty());
        assert!(all_grams(b"ab").is_empty());
        assert_eq!(cover(b"abc"), vec![&b"abc"[..]]);
    }

    #[test]
    fn keys_separate_lengths_and_keep_trigrams_exact() {
        assert_ne!(key(b"abc"), key(b"abcd"));
        assert_eq!(key(b"abc") >> 29, 0);
        assert_eq!(key(b"abcdefgh") >> 29, 5);
        assert_eq!(key(b"abc") & 0x00FF_FFFF, 0x0063_6261);
    }

    #[test]
    fn weight_table_is_a_permutation() {
        let mut seen = vec![false; 128 * 128];
        for a in 0..128u8 {
            for b in 0..128u8 {
                let w = weight(a, b) as usize;
                assert!(!seen[w], "rank {w} used twice");
                seen[w] = true;
            }
        }
        assert!(weight(b'i', b'n') < weight(b'z', b'q'));
        assert!(weight(b'e', b'r') < weight(0x01, 0x02));
        assert!(weight(0xC3, 0xA9) > weight(0x7F, 0x7F));
    }

    #[test]
    fn doc_keys_fold_ascii_case() {
        assert_eq!(doc_keys(b"HashMap::new"), doc_keys(b"hashmap::NEW"));
        assert_ne!(doc_keys("\u{212A}elvin".as_bytes()), doc_keys(b"kelvin"));
    }
}
