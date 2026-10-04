//! Evaluates a [`Query`] against the base snapshot (posting lists) or one overlay document.

use crate::error::Error;
use crate::format::{BaseIndex, Posting};
use crate::gram::key;
use crate::plan::Query;

/// Stop intersecting once this few candidates remain; dropping a conjunct is always sound.
const ENOUGH: usize = 64;
/// Skip a conjunct whose list is this many times longer than the current candidate set.
const SKEW: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cands {
    All,
    /// Ascending doc ids.
    Docs(Vec<u32>),
}

pub fn eval_base(q: &Query, base: &BaseIndex) -> Result<Cands, Error> {
    match q {
        Query::All => Ok(Cands::All),
        Query::Nothing => Ok(Cands::Docs(Vec::new())),
        Query::Gram(g) => Ok(Cands::Docs(match base.lookup(key(g))? {
            Some(p) => base.docs_of(p)?,
            None => Vec::new(),
        })),
        Query::Or(subs) => {
            let mut acc = Vec::new();
            for s in subs {
                match eval_base(s, base)? {
                    Cands::All => return Ok(Cands::All),
                    Cands::Docs(d) => acc = union(&acc, &d),
                }
            }
            Ok(Cands::Docs(acc))
        }
        Query::And(subs) => {
            // Gram conjuncts first, rarest first; a missing gram empties the whole AND.
            let mut postings = Vec::new();
            for s in subs {
                if let Query::Gram(g) = s {
                    match base.lookup(key(g))? {
                        Some(p) => postings.push(p),
                        None => return Ok(Cands::Docs(Vec::new())),
                    }
                }
            }
            postings.sort_by_key(Posting::df);
            let mut acc: Option<Vec<u32>> = None;
            for p in postings {
                if let Some(a) = &acc {
                    if a.len() <= ENOUGH || u64::from(p.df()) > SKEW * a.len() as u64 {
                        break;
                    }
                }
                let docs = base.docs_of(p)?;
                let next = match acc {
                    None => docs,
                    Some(a) => intersect(&a, &docs),
                };
                if next.is_empty() {
                    return Ok(Cands::Docs(next));
                }
                acc = Some(next);
            }
            for s in subs.iter().filter(|s| !matches!(s, Query::Gram(_))) {
                if acc.as_ref().is_some_and(|a| a.len() <= ENOUGH) {
                    break;
                }
                if let Cands::Docs(d) = eval_base(s, base)? {
                    let next = match acc {
                        None => d,
                        Some(a) => intersect(&a, &d),
                    };
                    if next.is_empty() {
                        return Ok(Cands::Docs(next));
                    }
                    acc = Some(next);
                }
            }
            Ok(acc.map_or(Cands::All, Cands::Docs))
        }
    }
}

/// Whether a document with these (sorted) gram keys satisfies `q`.
pub fn eval_keys(q: &Query, keys: &[u32]) -> bool {
    match q {
        Query::All => true,
        Query::Nothing => false,
        Query::Gram(g) => keys.binary_search(&key(g)).is_ok(),
        Query::And(subs) => subs.iter().all(|s| eval_keys(s, keys)),
        Query::Or(subs) => subs.iter().any(|s| eval_keys(s, keys)),
    }
}

/// Intersection of two ascending lists; gallops through the longer one when sizes are skewed.
pub fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let mut out = Vec::with_capacity(small.len());
    if large.len() / 8 > small.len() {
        let mut base = 0;
        for &x in small {
            let rest = &large[base..];
            let mut bound = 1;
            while bound < rest.len() && rest[bound - 1] < x {
                bound *= 2;
            }
            match rest[..bound.min(rest.len())].binary_search(&x) {
                Ok(i) => {
                    out.push(x);
                    base += i + 1;
                }
                Err(i) => base += i,
            }
            if base >= large.len() {
                break;
            }
        }
    } else {
        let (mut i, mut j) = (0, 0);
        while i < small.len() && j < large.len() {
            match small[i].cmp(&large[j]) {
                std::cmp::Ordering::Less => i += 1,
                std::cmp::Ordering::Greater => j += 1,
                std::cmp::Ordering::Equal => {
                    out.push(small[i]);
                    i += 1;
                    j += 1;
                }
            }
        }
    }
    out
}

pub fn union(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => {
                out.push(a[i]);
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                out.push(b[j]);
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

/// `a` minus `b`, both ascending.
pub fn difference(a: &[u32], b: &[u32]) -> Vec<u32> {
    a.iter()
        .copied()
        .filter(|x| b.binary_search(x).is_err())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::BTreeSet;

    fn sorted() -> impl Strategy<Value = Vec<u32>> {
        prop::collection::btree_set(0u32..2000, 0..300).prop_map(|s| s.into_iter().collect())
    }

    proptest! {
        #[test]
        fn set_ops_match_btreeset(a in sorted(), b in sorted(), tiny in prop::collection::btree_set(0u32..2000, 0..4)) {
            let (sa, sb): (BTreeSet<u32>, BTreeSet<u32>) = (a.iter().copied().collect(), b.iter().copied().collect());
            prop_assert_eq!(intersect(&a, &b), sa.intersection(&sb).copied().collect::<Vec<_>>());
            prop_assert_eq!(union(&a, &b), sa.union(&sb).copied().collect::<Vec<_>>());
            prop_assert_eq!(difference(&a, &b), sa.difference(&sb).copied().collect::<Vec<_>>());
            let tiny: Vec<u32> = tiny.into_iter().collect();
            let st: BTreeSet<u32> = tiny.iter().copied().collect();
            prop_assert_eq!(intersect(&tiny, &a), st.intersection(&sa).copied().collect::<Vec<_>>());
        }
    }

    #[test]
    fn eval_keys_follows_the_tree() {
        let doc = crate::gram::doc_keys(b"let parser = Parser::new();");
        let hit = crate::plan::plan_pattern("parser::new", false, Some(false)).unwrap();
        let miss = crate::plan::plan_pattern("lexer::new", false, Some(false)).unwrap();
        assert!(eval_keys(&hit, &doc));
        assert!(!eval_keys(&miss, &doc));
        assert!(eval_keys(&Query::All, &doc));
        assert!(!eval_keys(&Query::Nothing, &doc));
    }
}
