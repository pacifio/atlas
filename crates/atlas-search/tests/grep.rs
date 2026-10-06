//! `grep` against real temp trees: correctness, safety, and the odd inputs
//! an agent's project contains.

mod support;

use std::time::{Duration, Instant};

use atlas_search::{grep, CancelToken, GrepRequest, OutputMode, SearchError};
use support::{git_tree, rels, set_mtime, sorted_rels, tree, write};

fn content(root: &std::path::Path, pattern: &str) -> GrepRequest {
    GrepRequest {
        mode: OutputMode::Content,
        ..GrepRequest::new(root, pattern)
    }
}

fn run(req: &GrepRequest) -> atlas_search::GrepResult {
    grep(req, &CancelToken::new()).expect("grep runs")
}

// ── Review focus 1: an agent greps for text it just wrote ───────────────────

#[test]
fn write_then_grep_finds_the_new_text() {
    let dir = tree(&[("src/lib.rs", b"fn old() {}\n")]);
    assert!(run(&GrepRequest::new(dir.path(), "fn brand_new"))
        .files
        .is_empty());
    write(
        dir.path(),
        "src/lib.rs",
        b"fn old() {}\nfn brand_new() {}\n",
    );
    let res = run(&content(dir.path(), "fn brand_new"));
    assert_eq!(rels(&res), ["src/lib.rs"]);
    assert_eq!(res.files[0].lines[0].line, 2);
}

// ── Review focus 2: huge or odd files ────────────────────────────────────────

#[test]
fn binary_skipped() {
    let dir = tree(&[
        ("blob.bin", b"needle\0\x01\x02needle"),
        ("text.txt", b"a needle here\n"),
    ]);
    assert_eq!(
        rels(&run(&GrepRequest::new(dir.path(), "needle"))),
        ["text.txt"]
    );
}

#[test]
fn long_line_clipped() {
    let line = format!("{}needle{}\n", "x".repeat(10_000), "y".repeat(10_000));
    let dir = tree(&[("min.js", line.as_bytes())]);
    let res = run(&content(dir.path(), "needle"));
    let text = &res.files[0].lines[0].text;
    assert!(text.contains("needle"), "clipped around the match: {text}");
    assert!(
        text.chars().count() <= 302,
        "{} chars",
        text.chars().count()
    );
    assert!(text.starts_with('…') && text.ends_with('…'));
}

#[test]
fn invalid_utf8_lossy() {
    let dir = tree(&[("latin1.txt", b"caf\xe9 needle\n")]);
    let res = run(&content(dir.path(), "needle"));
    assert_eq!(res.files[0].lines[0].text, "caf\u{FFFD} needle");
}

#[test]
fn crlf_lines() {
    let dir = tree(&[("win.txt", b"alpha\r\nbeta needle\r\ngamma\r\n")]);
    let res = run(&content(dir.path(), "needle"));
    assert_eq!(res.files[0].lines[0].line, 2);
    assert_eq!(res.files[0].lines[0].text, "beta needle", "no trailing \\r");
}

#[test]
fn utf16_with_a_bom_is_transcoded() {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "hello needle\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let dir = tree(&[("wide.txt", &bytes)]);
    let res = run(&content(dir.path(), "needle"));
    assert_eq!(res.files[0].lines[0].text, "hello needle");
}

#[test]
fn large_files_are_skipped_and_counted() {
    let big = vec![b'a'; (10 << 20) + 1];
    let dir = tree(&[("huge.log", &big), ("small.txt", b"a\n")]);
    let res = run(&GrepRequest::new(dir.path(), "a"));
    assert_eq!(rels(&res), ["small.txt"]);
    assert_eq!(res.skipped_large, 1);
}

// ── Review focus 3: model-supplied regex ────────────────────────────────────

#[test]
fn lookaround_error_is_actionable() {
    let dir = tree(&[("a.rs", b"x\n")]);
    let err = grep(
        &GrepRequest::new(dir.path(), "(?<=foo)bar"),
        &CancelToken::new(),
    )
    .unwrap_err();
    let SearchError::Regex(message) = err else {
        panic!("expected a regex error, got {err:?}")
    };
    assert!(message.contains("look-around"), "{message}");
    assert!(message.contains("literal=true"), "{message}");
    assert!(
        message.len() < 300 && !message.contains('\n'),
        "short and one line: {message}"
    );
}

#[test]
fn pathological_regex_bounded() {
    let dir = tree(&[("a.txt", "a".repeat(1 << 20).as_bytes())]);
    let started = Instant::now();
    // Too big to compile: refused fast, not built.
    let err = grep(
        &GrepRequest::new(dir.path(), "(?:a{1000}){1000}"),
        &CancelToken::new(),
    )
    .unwrap_err();
    assert!(matches!(err, SearchError::Regex(_)), "{err:?}");
    // Catastrophic for a backtracker, linear here.
    let res = run(&GrepRequest::new(dir.path(), "(a|aa)*c"));
    assert!(res.files.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn smart_case_is_the_default() {
    let dir = tree(&[("a.txt", b"Needle\n"), ("b.txt", b"needle\n")]);
    let mut lower = GrepRequest::new(dir.path(), "needle");
    lower.mode = OutputMode::Count;
    assert_eq!(
        run(&lower).total_files,
        2,
        "all-lowercase pattern: insensitive"
    );
    let upper = GrepRequest {
        pattern: "Needle".into(),
        ..lower.clone()
    };
    assert_eq!(
        rels(&run(&upper)),
        ["a.txt"],
        "an uppercase letter: sensitive"
    );
    let forced = GrepRequest {
        case_insensitive: Some(false),
        ..lower
    };
    assert_eq!(rels(&run(&forced)), ["b.txt"]);
}

/// Git for Windows checks files out with CRLF endings by default: `$` must
/// still match at the end of each line.
#[test]
fn line_end_anchor_matches_crlf_lines() {
    let dir = tree(&[("win.c", b"int a;\r\nint b\r\nint c;\r\n")]);
    let res = run(&content(dir.path(), ";$"));
    let lines: Vec<u64> = res.files[0].lines.iter().map(|l| l.line).collect();
    assert_eq!(lines, [1, 3]);
    assert_eq!(res.files[0].lines[0].text, "int a;");
    let multiline = GrepRequest {
        multiline: true,
        ..content(dir.path(), r"b$\s+int c")
    };
    let res = run(&multiline);
    let lines: Vec<u64> = res.files[0].lines.iter().map(|l| l.line).collect();
    assert_eq!(lines, [2, 3], "a match across a CRLF");
}

#[test]
fn line_anchors_match_every_line() {
    let dir = tree(&[("a.rs", b"// x\nfn one() {}\n")]);
    let res = run(&content(dir.path(), "^fn"));
    assert_eq!(res.files[0].lines[0].line, 2);
}

#[test]
fn literal_and_word_modes() {
    let dir = tree(&[("a.txt", b"call foo(x)\nfoobar\n")]);
    let literal = GrepRequest {
        literal: true,
        ..content(dir.path(), "foo(x)")
    };
    assert_eq!(run(&literal).total_matches, 1);
    let word = GrepRequest {
        word: true,
        ..content(dir.path(), "foo")
    };
    assert_eq!(run(&word).files[0].lines[0].line, 1);
    assert_eq!(run(&word).total_matches, 1);
}

#[test]
fn multiline_matches_span_lines() {
    let dir = tree(&[("a.rs", b"fn a() {\n    body();\n}\n")]);
    let req = GrepRequest {
        multiline: true,
        ..content(dir.path(), r"fn a\(\) \{\n\s+body")
    };
    let res = run(&req);
    let lines: Vec<u64> = res.files[0].lines.iter().map(|l| l.line).collect();
    assert_eq!(lines, [1, 2]);
}

// ── Review focus 4: paths outside the root and secrets ──────────────────────

#[test]
fn path_escape_refused() {
    let outer = tree(&[("secret.txt", b"needle\n")]);
    let dir = tree(&[("inside/a.txt", b"needle\n")]);
    for escape in [
        std::path::PathBuf::from("../"),
        std::path::PathBuf::from("inside/../../"),
        outer.path().join("secret.txt"),
    ] {
        let req = GrepRequest {
            path: Some(escape.clone()),
            ..GrepRequest::new(dir.path(), "needle")
        };
        let err = grep(&req, &CancelToken::new()).unwrap_err();
        assert!(
            matches!(err, SearchError::Path(ref m) if m.contains("outside")),
            "{escape:?}: {err:?}"
        );
    }
    let inside = GrepRequest {
        path: Some("inside".into()),
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(rels(&run(&inside)), ["inside/a.txt"]);
}

#[test]
fn deny_globs_hide_secrets() {
    let dir = tree(&[
        (".env", b"TOKEN=needle\n"),
        ("app/.env.local", b"TOKEN=needle\n"),
        (".env.example", b"TOKEN=needle\n"),
        ("certs/server.pem", b"needle\n"),
        ("certs/Server.PEM", b"needle\n"),
        ("upper/.ENV", b"needle\n"),
        ("home/id_rsa", b"needle\n"),
        ("src/main.rs", b"needle\n"),
    ]);
    assert_eq!(
        sorted_rels(&run(&GrepRequest::new(dir.path(), "needle"))),
        [".env.example", "src/main.rs"]
    );
    // Named explicitly, the file is searched: the agent asked for it.
    let named = GrepRequest {
        path: Some(".env".into()),
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(rels(&run(&named)), [".env"]);
}

#[cfg(unix)]
#[test]
fn symlink_not_followed() {
    let outer = tree(&[("secret.txt", b"needle\n")]);
    let dir = tree(&[("a.txt", b"nothing\n")]);
    std::os::unix::fs::symlink(outer.path(), dir.path().join("link_dir")).unwrap();
    std::os::unix::fs::symlink(
        outer.path().join("secret.txt"),
        dir.path().join("link_file"),
    )
    .unwrap();
    assert!(run(&GrepRequest::new(dir.path(), "needle"))
        .files
        .is_empty());
    let through = GrepRequest {
        path: Some("link_dir".into()),
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert!(matches!(
        grep(&through, &CancelToken::new()),
        Err(SearchError::Path(_))
    ));
}

// ── Walk rules ───────────────────────────────────────────────────────────────

#[test]
fn gitignore_is_respected_unless_include_ignored() {
    let dir = git_tree(&[
        (".gitignore", b"target/\n"),
        ("target/out.txt", b"needle\n"),
        ("src/a.rs", b"needle\n"),
        (".github/ci.yml", b"needle\n"),
    ]);
    assert_eq!(
        sorted_rels(&run(&GrepRequest::new(dir.path(), "needle"))),
        [".github/ci.yml", "src/a.rs"]
    );
    let all = GrepRequest {
        include_ignored: true,
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(run(&all).total_files, 3);
}

/// `.atlas/` holds Atlas's indexes and logs with the user's own prompts.
#[test]
fn the_atlas_dir_is_never_searched() {
    for dir in [
        tree(&[(".atlas/logs.jsonl", b"needle\n"), ("a.txt", b"needle\n")]),
        git_tree(&[(".atlas/logs.jsonl", b"needle\n"), ("a.txt", b"needle\n")]),
    ] {
        let all = GrepRequest {
            include_ignored: true,
            ..GrepRequest::new(dir.path(), "needle")
        };
        assert_eq!(rels(&run(&all)), ["a.txt"]);
        assert_eq!(
            rels(&run(&GrepRequest::new(dir.path(), "needle"))),
            ["a.txt"]
        );
    }
}

#[test]
fn vcs_dirs_are_never_searched() {
    let dir = git_tree(&[
        (".git/config", b"needle\n"),
        (".hg/x", b"needle\n"),
        ("a.txt", b"needle\n"),
    ]);
    let all = GrepRequest {
        include_ignored: true,
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(rels(&run(&all)), ["a.txt"]);
}

#[test]
fn glob_and_type_filters() {
    let dir = tree(&[
        ("src/a.rs", b"needle\n"),
        ("src/b.ts", b"needle\n"),
        ("web/c.tsx", b"needle\n"),
    ]);
    let globbed = GrepRequest {
        globs: vec!["*.{ts,tsx}".into()],
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(run(&globbed).total_files, 2);
    let excluded = GrepRequest {
        globs: vec!["!web/**".into()],
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(run(&excluded).total_files, 2);
    let typed = GrepRequest {
        file_type: Some("rust".into()),
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert_eq!(rels(&run(&typed)), ["src/a.rs"]);
    let unknown = GrepRequest {
        file_type: Some("nope".into()),
        ..GrepRequest::new(dir.path(), "needle")
    };
    assert!(matches!(
        grep(&unknown, &CancelToken::new()),
        Err(SearchError::Glob(_))
    ));
}

// ── Ordering, counting, context ─────────────────────────────────────────────

#[test]
fn files_come_newest_first_then_by_path() {
    let dir = tree(&[
        ("b.txt", b"needle\n"),
        ("a.txt", b"needle\n"),
        ("c.txt", b"needle\n"),
    ]);
    set_mtime(dir.path(), "a.txt", 1_000);
    set_mtime(dir.path(), "b.txt", 1_000);
    set_mtime(dir.path(), "c.txt", 2_000);
    assert_eq!(
        rels(&run(&GrepRequest::new(dir.path(), "needle"))),
        ["c.txt", "a.txt", "b.txt"]
    );
}

#[test]
fn content_keeps_twenty_lines_per_file_and_counts_the_rest() {
    let body: String = (0..30).map(|i| format!("needle {i}\n")).collect();
    let dir = tree(&[("many.txt", body.as_bytes())]);
    let res = run(&content(dir.path(), "needle"));
    assert_eq!(res.files[0].matches, 30);
    assert_eq!(res.files[0].lines.iter().filter(|l| l.is_match).count(), 20);
    assert_eq!(res.total_matches, 30);
}

#[test]
fn context_lines_surround_matches() {
    let dir = tree(&[("a.txt", b"one\ntwo\nneedle\nfour\nfive\n")]);
    let req = GrepRequest {
        before: 1,
        after: 1,
        ..content(dir.path(), "needle")
    };
    let lines: Vec<(u64, bool)> = run(&req).files[0]
        .lines
        .iter()
        .map(|l| (l.line, l.is_match))
        .collect();
    assert_eq!(lines, [(2, false), (3, true), (4, false)]);
}

#[test]
fn a_cancelled_search_is_partial() {
    let dir = tree(&[("a.txt", b"needle\n")]);
    let cancel = CancelToken::new();
    cancel.cancel();
    let res = grep(&GrepRequest::new(dir.path(), "needle"), &cancel).unwrap();
    assert!(res.partial);
    assert!(res.files.is_empty());
}

#[test]
fn the_match_cap_stops_a_runaway_pattern() {
    let body = "x\n".repeat(2_000);
    let files: Vec<(String, Vec<u8>)> = (0..10)
        .map(|i| (format!("f{i}.txt"), body.clone().into_bytes()))
        .collect();
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    let dir = tree(&refs);
    let mut req = GrepRequest::new(dir.path(), "x");
    req.mode = OutputMode::Count;
    req.limit = Some(1);
    let res = run(&req);
    assert!(res.match_cap_hit, "{res:?}");
    assert!(res.total_matches >= 10_000 && res.total_matches < 20_000);
}
