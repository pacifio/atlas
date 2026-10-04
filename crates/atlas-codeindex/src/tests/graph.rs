use super::*;
use crate::{DiffHunk, RelatedQuery, Relation};

fn q(target: &str, relation: Relation, hops: u8) -> RelatedQuery {
    RelatedQuery {
        target: target.into(),
        relation,
        hops,
        include_tests: false,
        limit: 50,
        offset: 0,
    }
}

fn graph_project() -> (Project, CodeIndex) {
    let p = Project::new();
    p.write("src/lib.rs", "pub mod a;\npub mod b;\n");
    p.write("src/a.rs", "pub fn leaf() {}\npub fn mid() { leaf(); }\n");
    p.write("src/b.rs", "use crate::a::{mid, leaf};\npub fn top() { mid(); }\npub fn other() { leaf(); }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { super::top(); }\n}\n");
    let ix = p.built();
    (p, ix)
}

#[test]
fn callers_walk_hops_with_risk_and_skip_tests_by_default() {
    let (_p, ix) = graph_project();
    let (hits, page) = ix.related(&q("leaf", Relation::Callers, 2)).unwrap();
    let names: Vec<(String, u8)> = hits
        .iter()
        .map(|h| {
            (
                h.qualified_name.rsplit("::").next().unwrap().to_string(),
                h.hop,
            )
        })
        .collect();
    assert_eq!(
        names,
        [("mid".into(), 1), ("other".into(), 1), ("top".into(), 2)]
    );
    assert_eq!(hits[0].risk(), "CRITICAL");
    assert!(page.total_exact);
    let mut with_tests = q("top", Relation::Callers, 1);
    with_tests.include_tests = true;
    assert!(ix.related(&with_tests).unwrap().0.iter().any(|h| h.is_test));
    assert!(ix
        .related(&q("top", Relation::Callers, 1))
        .unwrap()
        .0
        .is_empty());
}

#[test]
fn tests_relation_returns_only_tests_and_callees_go_down() {
    let (_p, ix) = graph_project();
    let tests = ix.related(&q("mid", Relation::Tests, 3)).unwrap().0;
    assert_eq!(tests.len(), 1);
    assert!(tests[0].is_test);
    let callees = ix.related(&q("top", Relation::Callees, 2)).unwrap().0;
    assert!(callees
        .iter()
        .any(|h| h.qualified_name.ends_with("leaf") && h.hop == 2));
}

#[test]
fn importers_are_files() {
    let (_p, ix) = graph_project();
    let hits = ix
        .related(&q("src/a.rs", Relation::Importers, 1))
        .unwrap()
        .0;
    assert_eq!(
        hits.iter()
            .map(|h| (h.kind.as_str(), h.rel.as_str()))
            .collect::<Vec<_>>(),
        [("file", "src/b.rs")]
    );
}

#[test]
fn bfs_terminates_on_cycles_and_caps_rows() {
    let p = Project::new();
    p.write("src/lib.rs", "pub fn ping(n: u32) { if n > 0 { pong(n - 1) } }\npub fn pong(n: u32) { if n > 0 { ping(n - 1) } }\n");
    let ix = p.built();
    let (hits, _) = ix.related(&q("ping", Relation::Callers, 3)).unwrap();
    assert_eq!(hits.len(), 1, "pong once, not a loop: {hits:?}");
    assert!(crate::MAX_ROWS >= 1000);
}

#[test]
fn unknown_target_is_not_found_with_suggestions() {
    let (_p, ix) = graph_project();
    match ix.related(&q("lef", Relation::Callers, 1)).unwrap_err() {
        crate::IndexError::NotFound { suggestions, .. } => {
            assert!(suggestions.contains(&"leaf".to_string()), "{suggestions:?}")
        }
        e => panic!("expected NotFound, got {e}"),
    }
}

#[test]
fn impact_seeds_innermost_symbols_and_handles_deleted_and_new_files() {
    let (_p, ix) = graph_project();
    let hunks = vec![
        DiffHunk {
            rel: "src/a.rs".into(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            deleted_file: false,
        },
        DiffHunk {
            rel: "gone.rs".into(),
            old_start: 1,
            old_lines: 3,
            new_start: 0,
            new_lines: 0,
            deleted_file: true,
        },
        DiffHunk {
            rel: "notes.txt".into(),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: u32::MAX,
            deleted_file: false,
        },
    ];
    let r = ix.impact_of_diff(&hunks, 2).unwrap();
    assert_eq!(r.changed_files, ["gone.rs", "notes.txt", "src/a.rs"]);
    assert_eq!(
        r.changed
            .iter()
            .map(|h| h.qualified_name.rsplit("::").next().unwrap())
            .collect::<Vec<_>>(),
        ["leaf"]
    );
    let impacted: Vec<(&str, u8)> = r
        .impacted
        .iter()
        .map(|h| (h.qualified_name.rsplit("::").next().unwrap(), h.hop))
        .collect();
    assert!(
        impacted.contains(&("mid", 1))
            && impacted.contains(&("other", 1))
            && impacted.contains(&("top", 2)),
        "{impacted:?}"
    );
}
