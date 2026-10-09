use super::*;
use crate::{DiffHunk, RelatedQuery, Relation};

fn q(target: &str, relation: Relation, hops: u8) -> RelatedQuery {
    RelatedQuery {
        target: target.into(),
        relation,
        hops,
        include_tests: false,
        within: None,
        limit: 50,
        offset: 0,
    }
}

fn graph_project() -> (Project, CodeIndex) {
    let p = Project::new();
    // A crate root, so `use crate::a::…` resolves to src/a.rs.
    p.write(
        "Cargo.toml",
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    );
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
    const { assert!(crate::MAX_ROWS >= 1000) };
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

#[test]
fn a_reconcile_sees_a_config_file_no_watcher_reported() {
    let p = Project::new();
    p.write("src/lib.rs", "pub mod a;\npub mod b;\n");
    p.write("src/a.rs", "pub fn leaf() {}\n");
    p.write(
        "src/b.rs",
        "use crate::a::leaf;\npub fn top() { leaf(); }\n",
    );
    let ix = p.built();
    let importers = |ix: &CodeIndex| {
        ix.related(&q("src/a.rs", Relation::Importers, 1))
            .unwrap()
            .0
            .into_iter()
            .map(|h| h.rel)
            .collect::<Vec<_>>()
    };
    assert!(importers(&ix).is_empty(), "no crate root yet");
    p.write(
        "Cargo.toml",
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    );
    ix.reconcile(&atlas_search::CancelToken::new()).unwrap();
    assert_eq!(importers(&ix), ["src/b.rs"]);
}

/// Call edges by caller and callee qualified name (`(src, dst)` pairs).
fn call_edges(ix: &CodeIndex) -> Vec<(String, String)> {
    ix.with_reader(|c| {
        let mut stmt = c.prepare(
            "SELECT s.qualified_name, d.qualified_name FROM edges e
             JOIN symbols s ON s.id = e.src_symbol_id JOIN symbols d ON d.id = e.dst_symbol_id
             WHERE e.kind = 'call' ORDER BY 1, 2",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()?;
        Ok(rows)
    })
    .unwrap()
}

fn calls(edges: &[(String, String)], src: &str, dst: &str) -> bool {
    edges.iter().any(|(s, d)| s == src && d == dst)
}

const CARGO_DEMO: &str = "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";

/// A member call on a value whose type only a signature, a field or a smart pointer
/// names: rust-analyzer links all of these, and name matching alone linked none (the
/// method names are shared, or the receiver is untyped and the call crosses modules).
fn typed_receivers_project() -> (Project, CodeIndex) {
    let p = Project::new();
    p.write("Cargo.toml", CARGO_DEMO);
    p.write(
        "src/lib.rs",
        "pub mod store;\npub mod app;\npub mod other;\n",
    );
    p.write(
        "src/store.rs",
        "use std::sync::{Arc, Mutex};\n\
         pub struct Item;\n\
         impl Item {\n    pub fn name(&self) -> String { String::new() }\n    pub fn len(&self) -> usize { 0 }\n}\n\
         pub struct Registry {\n    items: Vec<Item>,\n}\n\
         impl Registry {\n    pub fn open() -> std::io::Result<Self> { Ok(Registry { items: Vec::new() }) }\n    pub fn find(&self, _id: u32) -> Option<&Item> { self.items.first() }\n    pub fn size(&self) -> usize { self.items.len() }\n}\n\
         pub struct Store;\n\
         impl Store {\n    pub fn request(&self) {}\n    pub fn registry(&self) -> Arc<Registry> { todo!() }\n}\n\
         pub fn new_store() -> (Store, u32) { (Store, 0) }\n\
         pub async fn connect() -> anyhow::Result<Store> { Ok(Store) }\n\
         pub struct Host {\n    inner: Arc<Mutex<Store>>,\n    reg: Registry,\n}\n\
         impl Host {\n    pub fn poke(&self) { self.inner.lock().unwrap().request(); }\n    pub fn lookup(&self) -> String { self.reg.find(1).unwrap().name() }\n}\n",
    );
    // Same method names elsewhere, so a name match is never unique.
    p.write(
        "src/other.rs",
        "pub struct Decoy;\n\
         impl Decoy {\n    pub fn request(&self) {}\n    pub fn size(&self) -> usize { 0 }\n    pub fn name(&self) -> String { String::new() }\n}\n",
    );
    p.write(
        "src/app.rs",
        "use std::sync::Arc;\n\
         use crate::store::{connect, new_store, Registry, Store};\n\
         pub fn tuple_local() {\n    let (store, _n) = new_store();\n    store.request();\n}\n\
         pub async fn awaited() -> anyhow::Result<()> {\n    let s = connect().await?;\n    s.request();\n    Ok(())\n}\n\
         pub fn opened() -> usize {\n    let r = Registry::open().unwrap();\n    r.size()\n}\n\
         pub fn param(s: Arc<Store>) {\n    s.request();\n}\n\
         pub fn chained(s: &Store) -> usize {\n    s.registry().size()\n}\n",
    );
    let ix = p.built();
    (p, ix)
}

#[test]
fn a_local_bound_from_a_call_is_typed_by_the_callees_return_type() {
    let (_p, ix) = typed_receivers_project();
    let e = call_edges(&ix);
    // `let (store, _) = new_store()`: the tuple's first element.
    assert!(calls(&e, "tuple_local", "Store::request"), "{e:?}");
    // `connect().await?`: an async fn's `anyhow::Result<Store>`, peeled.
    assert!(calls(&e, "awaited", "Store::request"), "{e:?}");
    // `Registry::open().unwrap()`: `io::Result<Self>`, with `Self` the impl type.
    assert!(calls(&e, "opened", "Registry::size"), "{e:?}");
    for caller in ["tuple_local", "awaited", "opened"] {
        assert!(
            !e.iter()
                .any(|(s, d)| s == caller && d.starts_with("Decoy::")),
            "{e:?}"
        );
    }
}

#[test]
fn smart_pointers_fields_and_method_chains_type_a_receiver() {
    let (_p, ix) = typed_receivers_project();
    let e = call_edges(&ix);
    // A parameter `Arc<Store>` is a `Store` to a method call.
    assert!(calls(&e, "param", "Store::request"), "{e:?}");
    // `s.registry()` returns `Arc<Registry>`.
    assert!(calls(&e, "chained", "Registry::size"), "{e:?}");
    // `self.inner: Arc<Mutex<Store>>` through `.lock().unwrap()`.
    assert!(calls(&e, "Host::poke", "Store::request"), "{e:?}");
    // `self.reg: Registry`, `find` returns `Option<&Item>`.
    assert!(calls(&e, "Host::lookup", "Registry::find"), "{e:?}");
    assert!(calls(&e, "Host::lookup", "Item::name"), "{e:?}");
    // `self.items: Vec<Item>`: `len` is the Vec's, not `Item::len`.
    assert!(!calls(&e, "Registry::size", "Item::len"), "{e:?}");
}

/// `tests/support/mod.rs` is declared by every test crate (`mod support;`), and each of
/// them calls into it; only the first crate to claim the file used to resolve.
#[test]
fn a_support_module_shared_by_test_crates_resolves_in_each() {
    let p = Project::new();
    p.write("Cargo.toml", CARGO_DEMO);
    // Same names in the library, so only the module path picks the right one.
    p.write(
        "src/lib.rs",
        "pub fn helper() {}\npub mod fake {\n    pub fn fake_server() {}\n}\n",
    );
    p.write(
        "tests/support/mod.rs",
        "pub mod fake;\npub fn helper() {}\n",
    );
    p.write("tests/support/fake.rs", "pub fn fake_server() {}\n");
    for t in ["a", "b"] {
        p.write(
            &format!("tests/{t}.rs"),
            &format!(
                "mod support;\nuse support::helper;\n#[test]\nfn t_{t}() {{\n    helper();\n    support::fake::fake_server();\n}}\n"
            ),
        );
    }
    let ix = p.built();
    let e = call_edges(&ix);
    for t in ["t_a", "t_b"] {
        let to_support = |name: &str| {
            ix.with_reader(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM edges e JOIN symbols s ON s.id = e.src_symbol_id
                     JOIN symbols d ON d.id = e.dst_symbol_id JOIN files f ON f.id = d.file_id
                     WHERE s.name = ?1 AND d.name = ?2 AND f.rel LIKE 'tests/support/%'",
                    [t, name],
                    |r| r.get::<_, i64>(0),
                )
            })
            .unwrap()
        };
        assert_eq!(to_support("helper"), 1, "{t}: {e:?}");
        assert_eq!(to_support("fake_server"), 1, "{t}: {e:?}");
    }
}

/// `use demo::*;` brings in a type whose method shares a name with a local `fn`: a bare
/// call is the local item (items shadow glob imports, and a bare name never calls a method).
#[test]
fn a_bare_call_prefers_a_local_fn_over_a_glob_imported_method() {
    let p = Project::new();
    p.write("Cargo.toml", CARGO_DEMO);
    p.write(
        "src/lib.rs",
        "pub struct Ev;\nimpl Ev {\n    pub fn id(&self) -> u32 { 0 }\n}\npub fn shared() {}\n",
    );
    p.write(
        "tests/t.rs",
        "use demo::*;\nfn id(x: u32) -> u32 { x }\n#[test]\nfn uses() {\n    id(1);\n    shared();\n}\n",
    );
    let ix = p.built();
    let e = call_edges(&ix);
    assert!(calls(&e, "uses", "id"), "{e:?}");
    assert!(!calls(&e, "uses", "Ev::id"), "{e:?}");
    assert!(
        calls(&e, "uses", "shared"),
        "the glob still resolves: {e:?}"
    );
}

/// A typed chain reads another file's return types and fields: editing only that file
/// re-types the receiver (the calling file is unchanged, so only the surface rule reaches it).
#[test]
fn a_changed_return_type_or_field_re_types_a_receiver_in_another_file() {
    let p = Project::new();
    p.write("Cargo.toml", CARGO_DEMO);
    p.write(
        "src/lib.rs",
        "pub mod kinds;\npub mod make;\npub mod app;\n",
    );
    p.write(
        "src/kinds.rs",
        "pub struct A;\nimpl A {\n    pub fn go(&self) {}\n}\npub struct B;\nimpl B {\n    pub fn go(&self) {}\n}\n",
    );
    let make = |ret: &str, field: &str| {
        format!(
            "use crate::kinds::{{A, B}};\npub fn make() -> {ret} {{ todo!() }}\npub struct Holder {{\n    pub inner: {field},\n}}\n"
        )
    };
    p.write("src/make.rs", &make("A", "A"));
    p.write(
        "src/app.rs",
        "use crate::make::{make, Holder};\npub fn run() {\n    let x = make();\n    x.go();\n}\npub fn held(h: &Holder) {\n    h.inner.go();\n}\n",
    );
    let ix = p.built();
    let e = call_edges(&ix);
    assert!(
        calls(&e, "run", "A::go") && calls(&e, "held", "A::go"),
        "{e:?}"
    );
    p.write("src/make.rs", &make("B", "B"));
    ix.update_paths(&[p.path("src/make.rs")]).unwrap();
    let e = call_edges(&ix);
    assert!(
        calls(&e, "run", "B::go") && calls(&e, "held", "B::go"),
        "{e:?}"
    );
    assert!(
        !calls(&e, "run", "A::go") && !calls(&e, "held", "A::go"),
        "{e:?}"
    );
}

/// `let (mut store, _) = new_store();` and `let c = Arc::new(Store::new());`.
#[test]
fn mutable_bindings_and_shared_pointers_keep_their_type() {
    let p = Project::new();
    p.write("Cargo.toml", CARGO_DEMO);
    p.write(
        "src/lib.rs",
        "pub mod store;\npub mod other;\npub mod app;\n",
    );
    p.write(
        "src/store.rs",
        "pub struct Store;\nimpl Store {\n    pub fn new() -> Self { Store }\n    pub fn request(&mut self) {}\n}\npub fn new_store() -> (Store, u32) { (Store, 0) }\n",
    );
    p.write(
        "src/other.rs",
        "pub struct Decoy;\nimpl Decoy {\n    pub fn request(&self) {}\n}\n",
    );
    p.write(
        "src/app.rs",
        "use std::sync::Arc;\nuse crate::store::{new_store, Store};\n\
         pub fn tuple_mut() {\n    let (mut store, _n) = new_store();\n    store.request();\n}\n\
         pub fn shared() {\n    let c = Arc::new(Store::new());\n    c.request();\n}\n",
    );
    let ix = p.built();
    let e = call_edges(&ix);
    assert!(calls(&e, "tuple_mut", "Store::request"), "{e:?}");
    assert!(calls(&e, "shared", "Store::request"), "{e:?}");
    assert!(!e.iter().any(|(_, d)| d == "Decoy::request"), "{e:?}");
}
