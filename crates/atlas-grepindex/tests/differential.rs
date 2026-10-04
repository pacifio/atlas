//! Differential test: on a fixture repository with a dirty work tree, `grep` with the index
//! must return exactly what the plain scan returns, for random regexes and flags.

mod common;

use std::sync::{Arc, OnceLock};

use atlas_grepindex::GrepIndex;
use common::{both, rels, request, Repo};
use proptest::prelude::*;

const VOCAB: &[&str] = &[
    "fn",
    "let",
    "mut",
    "self",
    "Parser",
    "parse_expr",
    "HashMap",
    "insert",
    "kelvin",
    "\u{212A}elvin",
    "\u{17F}tate",
    "state",
    "R\u{E9}sum\u{E9}",
    "_x1",
    "0x1F",
    "=>",
    "(",
    ")",
    "{",
    "}",
    ";",
    "::",
    "\n",
    "\t",
    " ",
    "    ",
    "\"str\"",
    "// note",
    "TODO",
    "unsafe",
    "impl",
    "Trait",
    "for",
    "while",
    "return",
    "match",
    "Some",
    "None",
    "Ok",
    "Err",
    "QUERY_LIMIT",
];

/// Rare strings placed in a few files of each kind, so random regexes also hit the index path.
const MARKERS: &[&str] = &[
    "marker_committed",
    "marker_noted",
    "marker_silent",
    "marker_untracked",
    "marker_fresh",
];

/// Deterministic pseudo-random content (64-bit LCG), so failures reproduce.
fn content(seed: u64, tokens: usize) -> String {
    let mut x = seed
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    let mut out = String::new();
    for _ in 0..tokens {
        x = x
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        out.push_str(VOCAB[(x >> 33) as usize % VOCAB.len()]);
        if (x >> 20).is_multiple_of(3) {
            out.push(' ');
        }
    }
    out
}

/// 150 committed files, then: 10 edited + noted, 10 edited silently before a resync, 3
/// deleted, 5 untracked, 5 edited silently after the resync (fresh mtimes), plus an ignored
/// directory and a binary file.
fn fixture() -> &'static (Repo, Arc<GrepIndex>) {
    static FIXTURE: OnceLock<(Repo, Arc<GrepIndex>)> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let repo = Repo::new();
        for i in 0..150u64 {
            let mut text = content(i, 40 + (i as usize * 7) % 300);
            if i.is_multiple_of(25) {
                text.push_str("\nmarker_committed\n");
            }
            repo.write(&format!("src/m{}/f{i:03}.rs", i % 7), text);
        }
        repo.write("assets/logo.bin", b"QUERY_LIMIT\0\x00\x01binary");
        repo.write(".gitignore", "target/\n");
        repo.write("target/debug/out.rs", content(999, 200));
        repo.commit_all("init");
        repo.backdate();
        let idx = repo.index();
        for i in 0..10u64 {
            let p = repo.write(
                &format!("src/m{}/f{i:03}.rs", i % 7),
                content(1000 + i, 120) + "marker_noted",
            );
            idx.note_write(&p);
        }
        for i in 10..20u64 {
            repo.write(
                &format!("src/m{}/f{i:03}.rs", i % 7),
                content(2000 + i, 120) + "marker_silent",
            );
        }
        for i in 20..23u64 {
            std::fs::remove_file(repo.root.join(format!("src/m{}/f{i:03}.rs", i % 7))).unwrap();
        }
        for i in 0..5u64 {
            repo.write(
                &format!("new/u{i}.rs"),
                content(3000 + i, 150) + "marker_untracked",
            );
        }
        repo.backdate();
        idx.resync().unwrap();
        for i in 30..35u64 {
            repo.write(
                &format!("src/m{}/f{i:03}.rs", i % 7),
                content(4000 + i, 120) + "marker_fresh",
            );
        }
        (repo, idx)
    })
}

fn regex_strategy() -> impl Strategy<Value = String> {
    let leaf = prop_oneof![
        6 => prop::sample::select(VOCAB).prop_map(regex_syntax::escape),
        3 => prop::sample::select(MARKERS).prop_map(str::to_string),
        2 => (prop::sample::select(VOCAB), prop::sample::select(VOCAB))
            .prop_map(|(a, b)| regex_syntax::escape(&format!("{a}{b}"))),
        1 => Just(".".to_string()),
        1 => Just(r"\w+".to_string()),
        1 => Just(r"\d".to_string()),
        1 => Just("[a-f]".to_string()),
        1 => Just(r"\s*".to_string()),
        1 => Just(r"\b".to_string()),
    ];
    leaf.prop_recursive(3, 12, 3, |inner| {
        prop_oneof![
            3 => prop::collection::vec(inner.clone(), 2..4).prop_map(|v| v.concat()),
            2 => prop::collection::vec(inner.clone(), 2..4).prop_map(|v| format!("(?:{})", v.join("|"))),
            1 => inner.clone().prop_map(|r| format!("(?:{r})?")),
            1 => inner.clone().prop_map(|r| format!("(?:{r})+")),
            1 => inner.prop_map(|r| format!("(?:{r}){{1,2}}")),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn indexed_grep_equals_scan(
        pattern in regex_strategy(),
        case in prop_oneof![Just(None), Just(Some(true)), Just(Some(false))],
        literal in any::<bool>(),
    ) {
        let (repo, idx) = fixture();
        let mut req = request(&repo.root, &pattern, case);
        req.literal = literal;
        let (scan, indexed) = both(idx, &req);
        prop_assert_eq!(rels(&indexed), rels(&scan), "pattern {:?} case {:?} literal {}", pattern, case, literal);
        prop_assert_eq!(indexed.total_matches, scan.total_matches);
    }
}

#[test]
fn selective_queries_use_the_index() {
    let (repo, idx) = fixture();
    for pattern in MARKERS
        .iter()
        .copied()
        .chain([r"marker_(?:noted|fresh)", r"(?i)MARKER_c\w+"])
    {
        let (scan, indexed) = both(idx, &request(&repo.root, pattern, None));
        assert_eq!(rels(&indexed), rels(&scan), "{pattern}");
        assert!(indexed.skipped_by_index > 0, "{pattern}: index not used");
    }
}
