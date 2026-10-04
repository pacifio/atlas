//! Regex -> gram query. Russ Cox's codesearch algebra (`index/regexp.go`) over `regex-syntax`
//! HIR, with `trigrams(s)` replaced by the sparse cover of `s`.
//!
//! Contract: every text the regex matches satisfies the returned [`Query`] (as a set of gram
//! keys). The query may admit texts the regex rejects; the real matcher removes those.
//! All strings here are already ASCII-folded, like the index.

use std::collections::BTreeSet;

use regex_syntax::hir::{Class, Hir, HirKind};
use regex_syntax::ParserBuilder;

use crate::gram::{cover, fold, MAX_GRAM_LEN, MIN_GRAM_LEN};

/// Exact sets larger than this are flushed into prefix/suffix (csearch `maxExact`).
pub const MAX_EXACT: usize = 7;
/// Prefix/suffix sets are shrunk until they are at most this big (csearch `maxSet`).
pub const MAX_SET: usize = 20;
/// Classes with more code points (or bytes) than this are "any char" (csearch's threshold).
pub const MAX_CLASS: u32 = 100;
/// After a flush, prefixes and suffixes keep this many bytes: a gram crossing a seam takes at
/// most `MAX_GRAM_LEN - 1` bytes from each side.
const EDGE: usize = MAX_GRAM_LEN - 1;
/// Exact sets whose shortest string is this long are flushed (csearch uses 4 for trigrams).
const FLUSH_LEN: usize = MAX_GRAM_LEN;
/// `e{n,m}` is unrolled at most this many times.
const MAX_UNROLL: u32 = 3;

type Set = BTreeSet<Vec<u8>>;

/// A boolean query over grams (folded gram bytes; `gram::key` maps them to index keys).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Query {
    All,
    Nothing,
    Gram(Box<[u8]>),
    And(Vec<Query>),
    Or(Vec<Query>),
}

impl Query {
    pub fn and(self, other: Query) -> Query {
        Query::all_of(vec![self, other])
    }

    pub fn or(self, other: Query) -> Query {
        Query::any_of(vec![self, other])
    }

    /// Conjunction, flattened, sorted, deduplicated, with `x AND (x OR y) = x`.
    pub fn all_of(parts: Vec<Query>) -> Query {
        let mut out = Vec::new();
        for p in parts {
            match p {
                Query::All => {}
                Query::Nothing => return Query::Nothing,
                Query::And(sub) => out.extend(sub),
                q => out.push(q),
            }
        }
        out.sort();
        out.dedup();
        let atoms: Vec<Query> = out
            .iter()
            .filter(|q| !matches!(q, Query::Or(_)))
            .cloned()
            .collect();
        out.retain(|q| match q {
            Query::Or(alts) => !alts.iter().any(|a| atoms.binary_search(a).is_ok()),
            _ => true,
        });
        match out.len() {
            0 => Query::All,
            1 => out.remove(0),
            _ => Query::And(out),
        }
    }

    /// Disjunction, flattened, sorted, deduplicated, with `x OR (x AND y) = x`.
    pub fn any_of(parts: Vec<Query>) -> Query {
        let mut out = Vec::new();
        for p in parts {
            match p {
                Query::Nothing => {}
                Query::All => return Query::All,
                Query::Or(sub) => out.extend(sub),
                q => out.push(q),
            }
        }
        out.sort();
        out.dedup();
        let atoms: Vec<Query> = out
            .iter()
            .filter(|q| !matches!(q, Query::And(_)))
            .cloned()
            .collect();
        out.retain(|q| match q {
            Query::And(all) => !all.iter().any(|a| atoms.binary_search(a).is_ok()),
            _ => true,
        });
        match out.len() {
            0 => Query::Nothing,
            1 => out.remove(0),
            _ => Query::Or(out),
        }
    }

    /// AND of the sparse cover of the folded literal `s`; `All` when `s` is too short.
    pub fn literal(s: &[u8]) -> Query {
        Query::all_of(
            cover(s)
                .into_iter()
                .map(|g| Query::Gram(g.into()))
                .collect(),
        )
    }

    /// Calls `f` on every gram in the query.
    pub fn for_each_gram(&self, f: &mut impl FnMut(&[u8])) {
        match self {
            Query::All | Query::Nothing => {}
            Query::Gram(g) => f(g),
            Query::And(subs) | Query::Or(subs) => subs.iter().for_each(|s| s.for_each_gram(f)),
        }
    }
}

/// OR over the strings of `set` of the AND of each string's cover (csearch `andTrigrams`).
fn cover_any(set: &Set) -> Query {
    if set.is_empty() || set.iter().any(|s| s.len() < MIN_GRAM_LEN) {
        return Query::All;
    }
    Query::any_of(set.iter().map(|s| Query::literal(s)).collect())
}

fn cross(xs: &Set, ys: &Set) -> Set {
    let mut out = Set::new();
    for x in xs {
        for y in ys {
            let mut s = x.clone();
            s.extend_from_slice(y);
            out.insert(s);
        }
    }
    out
}

fn min_len(set: &Set) -> usize {
    set.iter().map(Vec::len).min().unwrap_or(0)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Prefix,
    Suffix,
}

#[derive(Clone, Debug)]
struct Info {
    can_empty: bool,
    /// `Some(set)`: every match is one of these strings. `None`: unknown; use prefix/suffix.
    exact: Option<Set>,
    prefix: Set,
    suffix: Set,
    /// True when the covers of `prefix` and `suffix` are already implied by `matches`, so
    /// saving them again would only add redundant lookups.
    edges_saved: bool,
    matches: Query,
}

impl Info {
    fn no_match() -> Info {
        Info {
            can_empty: false,
            exact: None,
            prefix: Set::new(),
            suffix: Set::new(),
            edges_saved: false,
            matches: Query::Nothing,
        }
    }

    fn empty_string() -> Info {
        Info::exact(Set::from([Vec::new()]))
    }

    fn any_char() -> Info {
        let edge = Set::from([Vec::new()]);
        Info {
            can_empty: false,
            exact: None,
            prefix: edge.clone(),
            suffix: edge,
            edges_saved: false,
            matches: Query::All,
        }
    }

    fn any_match() -> Info {
        Info {
            can_empty: true,
            ..Info::any_char()
        }
    }

    fn exact(set: Set) -> Info {
        Info {
            can_empty: set.contains(&Vec::new()),
            exact: Some(set),
            prefix: Set::new(),
            suffix: Set::new(),
            edges_saved: false,
            matches: Query::All,
        }
    }

    fn prefixes(&self) -> &Set {
        self.exact.as_ref().unwrap_or(&self.prefix)
    }

    fn suffixes(&self) -> &Set {
        self.exact.as_ref().unwrap_or(&self.suffix)
    }

    fn add_exact(&mut self) {
        if let Some(exact) = &self.exact {
            self.matches = std::mem::replace(&mut self.matches, Query::All).and(cover_any(exact));
        }
    }

    /// csearch `simplify`: flush large or long exact sets into prefix/suffix, then shrink those.
    fn simplify(&mut self, force: bool) {
        let flush = self.exact.as_ref().is_some_and(|e| {
            e.len() > MAX_EXACT || (force && min_len(e) >= MIN_GRAM_LEN) || min_len(e) >= FLUSH_LEN
        });
        if flush {
            self.add_exact();
            for s in self.exact.take().unwrap_or_default() {
                let n = s.len();
                self.prefix.insert(s[..n.min(EDGE)].to_vec());
                self.suffix.insert(s[n - n.min(EDGE)..].to_vec());
            }
            // The cut strings are substrings of the exact strings just saved.
            self.edges_saved = true;
        }
        if self.exact.is_none() {
            if !self.edges_saved {
                let saved = cover_any(&self.prefix).and(cover_any(&self.suffix));
                self.matches = std::mem::replace(&mut self.matches, Query::All).and(saved);
                self.edges_saved = true;
            }
            self.prefix = shrink(&self.prefix, Side::Prefix);
            self.suffix = shrink(&self.suffix, Side::Suffix);
        }
    }
}

/// csearch `simplifySet` after its save step: cut strings to `EDGE` bytes (fewer while the set
/// is too big), then drop strings implied by a shorter one.
fn shrink(set: &Set, side: Side) -> Set {
    let cut = |set: &Set, n: usize| -> Set {
        set.iter()
            .map(|s| match side {
                Side::Prefix => s[..s.len().min(n)].to_vec(),
                Side::Suffix => s[s.len() - s.len().min(n)..].to_vec(),
            })
            .collect()
    };
    let mut n = EDGE;
    let mut out = cut(set, n);
    while out.len() > MAX_SET && n > 0 {
        n -= 1;
        out = cut(&out, n);
    }
    let all: Vec<Vec<u8>> = out.iter().cloned().collect();
    out.retain(|s| {
        !all.iter().any(|t| {
            t.len() < s.len()
                && match side {
                    Side::Prefix => s.starts_with(t),
                    Side::Suffix => s.ends_with(t),
                }
        })
    });
    out
}

fn concat(x: Info, y: Info) -> Info {
    let mut xy = Info {
        can_empty: x.can_empty && y.can_empty,
        exact: None,
        prefix: Set::new(),
        suffix: Set::new(),
        edges_saved: false,
        matches: x.matches.clone().and(y.matches.clone()),
    };
    match (&x.exact, &y.exact) {
        (Some(xe), Some(ye)) => xy.exact = Some(cross(xe, ye)),
        _ => {
            xy.prefix = match &x.exact {
                Some(xe) => {
                    let mut p = cross(xe, y.prefixes());
                    if y.can_empty {
                        p.extend(xe.iter().cloned());
                    }
                    p
                }
                None => {
                    let mut p = x.prefix.clone();
                    if x.can_empty {
                        p.extend(y.prefixes().iter().cloned());
                    }
                    p
                }
            };
            xy.suffix = match &y.exact {
                Some(ye) => {
                    let mut s = cross(x.suffixes(), ye);
                    if x.can_empty {
                        s.extend(ye.iter().cloned());
                    }
                    s
                }
                None => {
                    let mut s = y.suffix.clone();
                    if y.can_empty {
                        s.extend(x.suffixes().iter().cloned());
                    }
                    s
                }
            };
        }
    }
    // The seam: some string of suffix(x) x prefix(y) occurs in every match.
    if x.exact.is_none()
        && y.exact.is_none()
        && x.suffix.len() <= MAX_SET
        && y.prefix.len() <= MAX_SET
        && min_len(&x.suffix) + min_len(&y.prefix) >= MIN_GRAM_LEN
    {
        xy.matches = xy.matches.and(cover_any(&cross(&x.suffix, &y.prefix)));
    }
    xy.simplify(false);
    xy
}

fn alternate(mut x: Info, mut y: Info) -> Info {
    let mut xy = Info::no_match();
    match (x.exact.clone(), y.exact.clone()) {
        (Some(xe), Some(ye)) => xy.exact = Some(xe.union(&ye).cloned().collect()),
        (Some(xe), None) => {
            xy.prefix = xe.union(&y.prefix).cloned().collect();
            xy.suffix = xe.union(&y.suffix).cloned().collect();
            x.add_exact();
        }
        (None, Some(ye)) => {
            xy.prefix = x.prefix.union(&ye).cloned().collect();
            xy.suffix = x.suffix.union(&ye).cloned().collect();
            y.add_exact();
        }
        (None, None) => {
            xy.prefix = x.prefix.union(&y.prefix).cloned().collect();
            xy.suffix = x.suffix.union(&y.suffix).cloned().collect();
        }
    }
    xy.can_empty = x.can_empty || y.can_empty;
    xy.matches = x.matches.or(y.matches);
    xy.simplify(false);
    xy
}

fn class(c: &Class) -> Info {
    let strings: Set = match c {
        Class::Unicode(u) => {
            let count: u32 = u
                .ranges()
                .iter()
                .map(|r| u32::from(r.end()) - u32::from(r.start()) + 1)
                .sum();
            if count > MAX_CLASS {
                return Info::any_char();
            }
            u.ranges()
                .iter()
                .flat_map(|r| r.start()..=r.end())
                .map(|ch| fold(ch.to_string().as_bytes()))
                .collect()
        }
        Class::Bytes(b) => {
            let count: u32 = b
                .ranges()
                .iter()
                .map(|r| u32::from(r.end()) - u32::from(r.start()) + 1)
                .sum();
            if count > MAX_CLASS {
                return Info::any_char();
            }
            b.ranges()
                .iter()
                .flat_map(|r| r.start()..=r.end())
                .map(|byte| fold(&[byte]))
                .collect()
        }
    };
    if strings.is_empty() {
        return Info::no_match();
    }
    Info::exact(strings)
}

fn analyze(h: &Hir) -> Info {
    let mut info = match h.kind() {
        HirKind::Empty | HirKind::Look(_) => return Info::empty_string(),
        HirKind::Literal(lit) => Info::exact(Set::from([fold(&lit.0)])),
        HirKind::Class(c) => class(c),
        HirKind::Capture(cap) => return analyze(&cap.sub),
        HirKind::Concat(subs) => {
            return subs
                .iter()
                .fold(Info::empty_string(), |acc, s| concat(acc, analyze(s)))
        }
        HirKind::Alternation(subs) => {
            return subs
                .iter()
                .fold(Info::no_match(), |acc, s| alternate(acc, analyze(s)));
        }
        HirKind::Repetition(rep) => {
            if rep.min == 0 {
                return if rep.max == Some(1) {
                    alternate(analyze(&rep.sub), Info::empty_string())
                } else {
                    Info::any_match()
                };
            }
            let sub = analyze(&rep.sub);
            let unroll = rep.min.min(MAX_UNROLL);
            let mut out = sub.clone();
            for _ in 1..unroll {
                out = concat(out, sub.clone());
            }
            if rep.max == Some(rep.min) && rep.min <= MAX_UNROLL {
                return out; // e{n} with n <= MAX_UNROLL is exactly e^n
            }
            // e{n,m}: begins with e^unroll and ends with one e.
            Info {
                can_empty: sub.can_empty,
                exact: None,
                prefix: out.prefixes().clone(),
                suffix: sub.suffixes().clone(),
                edges_saved: false,
                matches: out.matches,
            }
        }
    };
    info.simplify(false);
    info
}

/// Query for a parsed pattern.
pub fn plan_hir(hir: &Hir) -> Query {
    let mut info = analyze(hir);
    info.simplify(true);
    info.add_exact();
    info.matches
}

/// Query for a grep request's pattern, or `None` when it does not parse (the scan path then
/// reports the error). `case_insensitive: None` (smart case) plans case-insensitively, a
/// superset of either outcome. `-w` adds only zero-width assertions, so it is ignored.
pub fn plan_pattern(pattern: &str, literal: bool, case_insensitive: Option<bool>) -> Option<Query> {
    let escaped;
    let pattern = if literal {
        escaped = regex_syntax::escape(pattern);
        escaped.as_str()
    } else {
        pattern
    };
    let hir = ParserBuilder::new()
        .unicode(true)
        .utf8(false)
        .multi_line(true)
        .case_insensitive(case_insensitive != Some(false))
        .build()
        .parse(pattern)
        .ok()?;
    Some(plan_hir(&hir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(p: &str) -> Query {
        plan_pattern(p, false, Some(false)).expect("parses")
    }

    fn lit(s: &str) -> Query {
        Query::literal(s.as_bytes())
    }

    fn gram(s: &str) -> Query {
        Query::Gram(s.as_bytes().into())
    }

    #[test]
    fn literal_is_its_cover() {
        assert_eq!(plan("abc"), gram("abc"));
        assert_eq!(plan("hello_world_handler"), lit("hello_world_handler"));
    }

    #[test]
    fn short_literal_and_empty_are_all() {
        assert_eq!(plan("ab"), Query::All);
        assert_eq!(plan(""), Query::All);
        assert_eq!(plan("^$"), Query::All);
    }

    #[test]
    fn literal_is_ascii_folded() {
        assert_eq!(plan("HashMap"), lit("hashmap"));
    }

    #[test]
    fn alternation_ors_branches() {
        assert_eq!(plan("abc|xyz"), gram("abc").or(gram("xyz")));
        assert_eq!(plan("(?:abc|ab)"), Query::All);
    }

    #[test]
    fn small_class_is_enumerated() {
        assert_eq!(plan("ab[cd]"), gram("abc").or(gram("abd")));
    }

    #[test]
    fn large_class_is_any_char() {
        assert_eq!(plan(r"abc\wxyz"), gram("abc").and(gram("xyz")));
        assert_eq!(plan(r"\w+\s*="), Query::All);
    }

    #[test]
    fn star_and_question_keep_the_rest() {
        assert_eq!(plan("abc(def)*ghi"), gram("abc").and(gram("ghi")));
        assert_eq!(plan("abc(?:def)?ghi"), lit("abcdefghi").or(lit("abcghi")));
    }

    #[test]
    fn plus_keeps_one_copy() {
        assert_eq!(plan("(?:abc)+"), gram("abc"));
        assert_eq!(
            plan("x(?:abc)+y"),
            Query::all_of(vec![gram("abc"), lit("xabc"), lit("abcy")])
        );
    }

    #[test]
    fn counted_repetition_unrolls() {
        assert_eq!(plan("(?:ab){2}"), lit("abab"));
        assert_eq!(
            plan("[ab]{3}"),
            Query::any_of(
                ["aaa", "aab", "aba", "abb", "baa", "bab", "bba", "bbb"]
                    .iter()
                    .map(|s| gram(s))
                    .collect(),
            )
        );
    }

    #[test]
    fn seam_rule_joins_unknown_sides() {
        // `a.*b` style: neither side exact, but the seam crosses a dot-free boundary.
        let q = plan(r"(?:foo|bar)+(?:baz|qux)+");
        let expected = Query::all_of(vec![
            gram("foo").or(gram("bar")),
            gram("baz").or(gram("qux")),
            Query::any_of(
                ["foobaz", "fooqux", "barbaz", "barqux"]
                    .iter()
                    .map(|s| lit(s))
                    .collect(),
            ),
        ]);
        assert_eq!(q, expected);
    }

    #[test]
    fn anchors_and_word_boundaries_are_empty() {
        assert_eq!(plan(r"^\bfoo_bar\b$"), lit("foo_bar"));
    }

    #[test]
    fn literal_flag_escapes_metacharacters() {
        assert_eq!(plan_pattern("a.c(", true, Some(false)), Some(lit("a.c(")));
        assert_eq!(plan_pattern("(unclosed", false, Some(false)), None);
    }

    #[test]
    fn unicode_case_folding_includes_kelvin_sign() {
        // (?i)k matches U+212A KELVIN SIGN; the plan must admit its UTF-8 bytes.
        let q = plan_pattern("kelvin", false, Some(true)).unwrap();
        let kelvin = "\u{212A}elvin".as_bytes();
        let mut grams = Vec::new();
        q.for_each_gram(&mut |g| grams.push(g.to_vec()));
        let doc: std::collections::HashSet<Vec<u8>> = {
            let mut s = std::collections::HashSet::new();
            crate::gram::for_each_gram(&fold(kelvin), |g| {
                s.insert(g.to_vec());
            });
            s
        };
        assert!(
            eval_set(&q, &doc),
            "plan {q:?} rejects the Kelvin-sign spelling"
        );
    }

    #[test]
    fn smart_case_plans_case_insensitively() {
        assert_eq!(
            plan_pattern("kelvin", false, None),
            plan_pattern("kelvin", false, Some(true))
        );
    }

    #[test]
    fn absorption_simplifies() {
        let a = gram("abc");
        let b = gram("def");
        assert_eq!(a.clone().or(a.clone().and(b.clone())), a);
        assert_eq!(a.clone().and(a.clone().or(b)), a);
        assert_eq!(Query::Nothing.or(Query::All), Query::All);
        assert_eq!(Query::Nothing.and(Query::All), Query::Nothing);
    }

    fn eval_set(q: &Query, doc: &std::collections::HashSet<Vec<u8>>) -> bool {
        match q {
            Query::All => true,
            Query::Nothing => false,
            Query::Gram(g) => doc.contains(&g.to_vec()),
            Query::And(s) => s.iter().all(|q| eval_set(q, doc)),
            Query::Or(s) => s.iter().any(|q| eval_set(q, doc)),
        }
    }

    mod soundness {
        use super::*;
        use proptest::prelude::*;
        use std::collections::HashSet;

        /// A random regex together with a string it matches (when its `\b`s line up).
        fn regex_and_sample() -> impl Strategy<Value = (String, String)> {
            let leaf = prop_oneof![
                6 => "[a-dkX_]{1,8}".prop_map(|s| (regex_syntax::escape(&s), s)),
                1 => "[a-dX_]".prop_map(|c| (".".to_string(), c)),
                1 => "[a-d_]".prop_map(|c| (r"\w".to_string(), c)),
                2 => "[a-c]".prop_map(|c| ("[a-c]".to_string(), c)),
                1 => "[b-d]".prop_map(|c| ("[^a]".to_string(), c)),
                1 => Just((r"\b".to_string(), String::new())),
            ];
            leaf.prop_recursive(4, 24, 4, |inner| {
                prop_oneof![
                    prop::collection::vec(inner.clone(), 2..4).prop_map(|v| {
                        (
                            v.iter().map(|x| x.0.as_str()).collect(),
                            v.iter().map(|x| x.1.as_str()).collect(),
                        )
                    }),
                    (
                        prop::collection::vec(inner.clone(), 2..4),
                        any::<prop::sample::Index>()
                    )
                        .prop_map(|(v, i)| {
                            let alts: Vec<&str> = v.iter().map(|x| x.0.as_str()).collect();
                            (
                                format!("(?:{})", alts.join("|")),
                                v[i.index(v.len())].1.clone(),
                            )
                        }),
                    (inner.clone(), any::<bool>()).prop_map(|((r, s), take)| (
                        format!("(?:{r})?"),
                        if take { s } else { String::new() }
                    )),
                    (inner.clone(), 1usize..3)
                        .prop_map(|((r, s), k)| (format!("(?:{r})+"), s.repeat(k))),
                    (inner.clone(), 0usize..3)
                        .prop_map(|((r, s), k)| (format!("(?:{r})*"), s.repeat(k))),
                    (inner, 1usize..5)
                        .prop_map(|((r, s), n)| (format!("(?:{r}){{{n}}}"), s.repeat(n))),
                ]
            })
        }

        /// Case-insensitive spellings, including the non-ASCII ones Unicode folding allows.
        fn respell(s: &str, choices: &[u8]) -> String {
            s.chars()
                .zip(choices.iter().cycle())
                .map(|(c, &pick)| match (c, pick) {
                    ('k', 2) => '\u{212A}',
                    (c, 1 | 2) => c.to_ascii_uppercase(),
                    (c, _) => c,
                })
                .collect()
        }

        fn doc_grams(text: &[u8]) -> HashSet<Vec<u8>> {
            let mut s = HashSet::new();
            crate::gram::for_each_gram(&fold(text), |g| {
                s.insert(g.to_vec());
            });
            s
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(4000))]

            /// For any regex and text: if the regex matches the text, the plan admits the text.
            #[test]
            fn plan_admits_every_matching_text(
                (re, sample) in regex_and_sample(),
                before in "[a-dX_ \n]{0,8}",
                after in "[a-dX_ \n]{0,8}",
                ci in any::<bool>(),
                choices in prop::collection::vec(0u8..3, 1..8),
            ) {
                let sample = if ci { respell(&sample, &choices) } else { sample };
                let text = format!("{before}{sample}{after}");
                let matcher = regex::bytes::RegexBuilder::new(&re).case_insensitive(ci).multi_line(true).build();
                prop_assume!(matcher.is_ok());
                if matcher.unwrap().is_match(text.as_bytes()) {
                    let q = plan_pattern(&re, false, Some(ci)).unwrap();
                    prop_assert!(eval_set(&q, &doc_grams(text.as_bytes())), "{re:?} matches {text:?} but plan {q:?} rejects it");
                }
            }
        }
    }
}
