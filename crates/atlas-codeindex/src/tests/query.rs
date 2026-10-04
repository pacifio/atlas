//! Symbol search ranking, outlines, symbol source, the grep locator, and
//! the picker list.

use crate::store::{split_name, split_words};
use crate::{IndexError, SymbolQuery};

use super::Project;

fn q(query: &str) -> SymbolQuery {
    SymbolQuery {
        query: query.into(),
        ..SymbolQuery::default()
    }
}

fn names(hits: &[crate::SymbolHit]) -> Vec<String> {
    hits.iter()
        .map(|h| format!("{} {}", h.kind, h.qualified_name))
        .collect()
}

fn search_fixture() -> Project {
    let p = Project::new();
    p.write("src/store.rs", "pub struct Store;\nimpl Store {\n    pub fn open() -> Self { Store }\n    pub fn open_store_now() {}\n}\n")
        .write("src/util.rs", "pub fn store_helper() {}\npub fn update_cloud_client() {}\n")
        .write("web/client.ts", "export function updateCloudClient() {}\nexport class StoreView {}\n")
        .write("tests/store_test.rs", "#[test]\nfn store() {}\n");
    p
}

#[test]
fn exact_name_ranks_first() {
    let p = search_fixture();
    let ix = p.built();
    let (hits, page) = ix.find_symbol(&q("Store")).unwrap();
    assert_eq!(names(&hits)[0], "struct Store");
    // Exact-but-test comes after exact non-test; prefix matches follow.
    assert_eq!(names(&hits)[1], "fn store");
    assert!(hits[1].is_test);
    assert!(page.total >= 4 && page.total_exact);
}

#[test]
fn camel_and_snake_parts_match_either_spelling() {
    let p = search_fixture();
    let ix = p.built();
    let (hits, _) = ix.find_symbol(&q("cloud client")).unwrap();
    assert_eq!(
        names(&hits),
        ["fn update_cloud_client", "fn updateCloudClient"]
    );
    // A name prefix outranks a word match.
    let (hits, _) = ix.find_symbol(&q("updateCloud")).unwrap();
    assert_eq!(
        names(&hits),
        ["fn updateCloudClient", "fn update_cloud_client"]
    );
}

#[test]
fn qualified_name_query_hits_the_method() {
    let p = search_fixture();
    let ix = p.built();
    let (hits, _) = ix.find_symbol(&q("Store::open")).unwrap();
    assert_eq!(names(&hits)[0], "method Store::open");
}

#[test]
fn filters_and_stable_paging() {
    let p = search_fixture();
    let ix = p.built();
    let only_fns = SymbolQuery {
        kind: Some("fn".into()),
        exclude_tests: true,
        ..q("store")
    };
    let (hits, _) = ix.find_symbol(&only_fns).unwrap();
    assert!(
        hits.iter().all(|h| h.kind == "fn" && !h.is_test),
        "{hits:?}"
    );
    let in_web = SymbolQuery {
        path_prefix: Some("web/".into()),
        ..q("store")
    };
    let (hits, _) = ix.find_symbol(&in_web).unwrap();
    assert_eq!(names(&hits), ["class StoreView"]);
    let all = ix.find_symbol(&q("store")).unwrap().0;
    let first = ix
        .find_symbol(&SymbolQuery {
            limit: 2,
            ..q("store")
        })
        .unwrap();
    assert_eq!(first.0, all[..2]);
    assert_eq!(first.1.next_offset, Some(2));
    assert_eq!(first.1.truncation, Some("page_limit"));
    let second = ix
        .find_symbol(&SymbolQuery {
            limit: 2,
            offset: 2,
            ..q("store")
        })
        .unwrap();
    assert_eq!(second.0, all[2..4]);
}

#[test]
fn punctuation_only_query_is_an_error() {
    let p = search_fixture();
    let ix = p.built();
    assert!(matches!(
        ix.find_symbol(&q("::")),
        Err(IndexError::Invalid(_))
    ));
}

#[test]
fn outline_lists_members_after_their_parent() {
    let p = search_fixture();
    let ix = p.built();
    let outline = ix.outline("src/store.rs").unwrap();
    assert_eq!(
        names(&outline),
        [
            "struct Store",
            "impl Store",
            "method Store::open",
            "method Store::open_store_now"
        ]
    );
    assert_eq!(outline[2].parent_id, Some(outline[1].id));
    assert!(ix.outline("nope.rs").unwrap().is_empty());
}

#[test]
fn read_symbol_returns_current_source() {
    let p = search_fixture();
    let ix = p.built();
    let s = ix.read_symbol("Store::open", 200).unwrap();
    assert_eq!(
        s.source.as_deref(),
        Some("    pub fn open() -> Self { Store }")
    );
    assert_eq!((s.symbol.start_line, s.symbol.end_line), (3, 3));
    assert!(!s.stale);
    // The struct beats the impl block and the test fn of a similar name.
    let s = ix.read_symbol("Store", 200).unwrap();
    assert_eq!(s.symbol.kind, "struct");
    assert_eq!(
        s.alternatives
            .iter()
            .map(|h| h.kind.as_str())
            .collect::<Vec<_>>(),
        ["impl"]
    );
    // Edited after indexing: still read from disk, flagged stale.
    p.write("src/store.rs", "// moved\npub struct Store;\n");
    assert!(ix.read_symbol("Store", 200).unwrap().stale);
}

#[test]
fn long_symbol_returns_members_not_source() {
    let p = Project::new();
    let body: String = (0..30)
        .map(|i| format!("    pub fn m{i}(&self) {{}}\n"))
        .collect();
    p.write(
        "src/big.rs",
        &format!(
            "pub struct Big;\nimpl Big {{\n{body}}}\npub fn long() {{\n{}}}\n",
            "    1;\n".repeat(50)
        ),
    );
    let ix = p.built();
    let s = ix.read_symbol("src/big.rs#Big", 10).unwrap();
    assert_eq!(s.symbol.kind, "struct");
    let s = ix.read_symbol("long", 10).unwrap();
    assert!(s.truncated && s.members.is_empty());
    assert_eq!(s.source.unwrap().lines().count(), 10);
}

#[test]
fn read_symbol_on_an_impl_returns_members() {
    let p = Project::new();
    let body: String = (0..30)
        .map(|i| format!("    pub fn m{i}(&self) {{}}\n"))
        .collect();
    p.write("src/only_impl.rs", &format!("impl Remote {{\n{body}}}\n"));
    let ix = p.built();
    let s = ix.read_symbol("Remote", 10).unwrap();
    assert_eq!(s.symbol.kind, "impl");
    assert!(s.source.is_none());
    assert_eq!(s.members.len(), 30);
    assert_eq!(s.members[0].qualified_name, "Remote::m0");
}

#[test]
fn read_symbol_unknown_name_suggests() {
    let p = search_fixture();
    let ix = p.built();
    match ix.read_symbol("updateCloud", 200) {
        Err(IndexError::NotFound { suggestions, .. }) => {
            assert_eq!(
                suggestions,
                [
                    "updateCloudClient (web/client.ts:1)",
                    "update_cloud_client (src/util.rs:2)"
                ]
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn locator_finds_the_smallest_enclosing_symbol() {
    let p = search_fixture();
    let ix = p.built();
    let loc = ix.locator();
    let m = loc.enclosing("src/store.rs", 3).unwrap();
    assert_eq!(
        (m.qualified_name.as_str(), m.kind.as_str(), m.callers),
        ("Store::open", "method", 0)
    );
    assert_eq!(loc.enclosing("src/store.rs", 5).unwrap().kind, "impl");
    assert!(loc.enclosing("src/store.rs", 99).is_none());
    assert!(loc.enclosing("missing.rs", 1).is_none());
}

#[test]
fn picker_symbols_leave_out_impl_blocks() {
    let p = search_fixture();
    let ix = p.built();
    let picked = ix.picker_symbols(100).unwrap();
    assert!(picked.iter().all(|h| h.kind != "impl"));
    assert!(picked.last().unwrap().is_test, "tests rank last");
    assert_eq!(ix.picker_symbols(2).unwrap().len(), 2);
}

#[test]
fn name_splitting() {
    assert_eq!(
        split_name("updateCloudClient"),
        "updateCloudClient update cloud client"
    );
    assert_eq!(split_name("HTTPServer"), "HTTPServer http server");
    assert_eq!(split_name("toUtf8String"), "toUtf8String to utf8 string");
    assert_eq!(split_name("plain"), "plain");
    assert_eq!(split_words("CodeIndex::open"), ["code", "index", "open"]);
    assert_eq!(split_words("find_symbol"), ["find", "symbol"]);
}
