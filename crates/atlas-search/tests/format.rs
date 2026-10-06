//! The model-facing text: golden shapes, paging, and the byte budget.

mod support;

use atlas_search::format::{find_text, grep_text};
use atlas_search::{
    grep, CancelToken, EnclosingSymbol, FindRequest, FindResult, GrepRequest, OutputMode,
    SymbolLocator, DEFAULT_BUDGET_BYTES,
};
use support::{set_mtime, tree};

fn text(req: &GrepRequest) -> String {
    let res = grep(req, &CancelToken::new()).expect("grep runs");
    grep_text(&res, req, None, DEFAULT_BUDGET_BYTES)
}

#[test]
fn files_mode_is_a_table_with_the_count_first() {
    let dir = tree(&[("a.rs", b"needle\n"), ("b.rs", b"needle\n")]);
    set_mtime(dir.path(), "a.rs", 1_000);
    set_mtime(dir.path(), "b.rs", 2_000);
    assert_eq!(
        text(&GrepRequest::new(dir.path(), "needle")),
        "grep /needle/: 2 files, newest first\nfiles: 2  (cols: path)\n  b.rs\n  a.rs\ntotal: 2\n"
    );
}

/// A capped search's totals are lower bounds, and the header says so.
#[test]
fn a_capped_count_is_marked_as_a_lower_bound() {
    let body = "x\n".repeat(2_000);
    let files: Vec<(String, Vec<u8>)> = (0..10)
        .map(|i| (format!("f{i}.txt"), body.clone().into_bytes()))
        .collect();
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    let dir = tree(&refs);
    let req = GrepRequest {
        mode: OutputMode::Count,
        limit: Some(1),
        ..GrepRequest::new(dir.path(), "x")
    };
    let out = text(&req);
    assert!(out.contains(": >="), "{out}");
    assert!(
        out.contains("partial: stopped after 10000 matching lines"),
        "{out}"
    );
}

#[test]
fn content_mode_is_ripgrep_heading_style() {
    let dir = tree(&[
        (
            "src/a.rs",
            b"fn one() {}\nlet x = 1;\nfn two() {}\nlet y = 2;\nlet z = 3;\nfn three() {}\n",
        ),
        ("b.rs", b"fn four() {}\n"),
    ]);
    set_mtime(dir.path(), "src/a.rs", 2_000);
    set_mtime(dir.path(), "b.rs", 1_000);
    let req = GrepRequest {
        mode: OutputMode::Content,
        after: 1,
        ..GrepRequest::new(dir.path(), "^fn")
    };
    assert_eq!(
        text(&req),
        "grep /^fn/: 4 matching lines in 2 files, newest first (at most 20 shown per file)\n\
         src/a.rs\n\
         1:fn one() {}\n\
         2-let x = 1;\n\
         3:fn two() {}\n\
         4-let y = 2;\n\
         --\n\
         6:fn three() {}\n\
         \n\
         b.rs\n\
         1:fn four() {}\n\
         total: 4\n"
    );
}

#[test]
fn content_paging_is_stable_and_complete() {
    let body: String = (1..=7).map(|i| format!("needle {i}\n")).collect();
    let dir = tree(&[("a.txt", body.as_bytes())]);
    let page = |offset| {
        let req = GrepRequest {
            mode: OutputMode::Content,
            limit: Some(3),
            offset,
            ..GrepRequest::new(dir.path(), "needle")
        };
        text(&req)
    };
    let first = page(0);
    assert!(
        first.contains("1:needle 1")
            && first.contains("3:needle 3")
            && !first.contains("4:needle 4")
    );
    assert!(
        first.contains("next_offset: 3\ntruncation: page_limit\n"),
        "{first}"
    );
    let second = page(3);
    assert!(second.contains("4:needle 4") && second.contains("6:needle 6"));
    let last = page(6);
    assert!(
        last.contains("7:needle 7") && !last.contains("next_offset"),
        "{last}"
    );
    assert_eq!(page(3), second, "the same page twice is the same text");
}

#[test]
fn format_never_exceeds_budget() {
    let line = format!("needle {}\n", "z".repeat(280));
    let body = line.repeat(20);
    let files: Vec<(String, Vec<u8>)> = (0..150)
        .map(|i| (format!("f{i:03}.txt"), body.clone().into_bytes()))
        .collect();
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    let dir = tree(&refs);
    for mode in [
        OutputMode::FilesWithMatches,
        OutputMode::Count,
        OutputMode::Content,
    ] {
        for budget in [1_000, 4_000, DEFAULT_BUDGET_BYTES] {
            let req = GrepRequest {
                mode,
                limit: Some(500),
                before: 2,
                ..GrepRequest::new(dir.path(), "needle")
            };
            let res = grep(&req, &CancelToken::new()).unwrap();
            let out = grep_text(&res, &req, None, budget);
            assert!(
                out.len() <= budget,
                "{mode:?} @ {budget}: {} bytes",
                out.len()
            );
            // 150 paths need ~1.5 KB; 150 files of 20 long lines need ~900 KB.
            if budget == 1_000 || mode == OutputMode::Content {
                assert!(
                    out.contains("truncation: output_budget"),
                    "{mode:?} @ {budget}:\n{out}"
                );
                assert!(out.contains("next_offset: "), "{mode:?} @ {budget}");
            }
        }
    }
}

struct OneSymbol;
impl SymbolLocator for OneSymbol {
    fn enclosing(&self, _rel: &str, line: u32) -> Option<EnclosingSymbol> {
        (line <= 3).then(|| EnclosingSymbol {
            qualified_name: "app::run".into(),
            kind: "fn".into(),
            start_line: 1,
            end_line: 3,
            callers: 12,
        })
    }
}

#[test]
fn a_locator_names_the_symbol_each_group_sits_in() {
    let dir = tree(&[("a.rs", b"fn run() {\n    needle();\n}\n")]);
    let req = GrepRequest {
        mode: OutputMode::Content,
        ..GrepRequest::new(dir.path(), "needle")
    };
    let res = grep(&req, &CancelToken::new()).unwrap();
    let out = grep_text(&res, &req, Some(&OneSymbol), DEFAULT_BUDGET_BYTES);
    assert!(
        out.contains("a.rs\n@ fn app::run L1-3 (12 callers)\n2:    needle();\n"),
        "{out}"
    );
}

#[test]
fn no_matches_says_what_was_searched_and_how_to_widen() {
    let dir = tree(&[("a.rs", b"x\n")]);
    assert_eq!(
        text(&GrepRequest::new(dir.path(), "needle")),
        "No matches for /needle/ in the project (searched 1 files; gitignored files excluded — set include_ignored=true to include).\n"
    );
}

#[test]
fn find_text_pages_like_every_other_tool() {
    let dir = tree(&[]);
    let req = FindRequest {
        limit: 2,
        ..FindRequest::new(dir.path(), "*.rs")
    };
    let res = FindResult {
        paths: vec!["b.rs".into(), "a.rs".into()],
        total: 3,
        partial: false,
    };
    assert_eq!(
        find_text(&res, &req, DEFAULT_BUDGET_BYTES),
        "find_files \"*.rs\": 3 paths, newest first\npaths: 2  (cols: path)\n  b.rs\n  a.rs\ntotal: 3\nnext_offset: 2\ntruncation: page_limit\n"
    );
}

#[test]
fn index_skips_are_reported() {
    let res = atlas_search::GrepResult {
        searched_files: 3,
        skipped_by_index: 40,
        ..Default::default()
    };
    let req = GrepRequest::new("/tmp", "x");
    let out = grep_text(&res, &req, None, DEFAULT_BUDGET_BYTES);
    assert!(out.contains("40") && out.contains("index"), "{out}");
}
