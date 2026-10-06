use super::*;
use crate::{tests::FakeEmbedder, SemanticQuery};

fn sq(q: &str) -> SemanticQuery {
    SemanticQuery {
        query: q.into(),
        path_glob: None,
        lang: None,
        within: None,
        limit: 10,
        offset: 0,
    }
}

fn project() -> (Project, CodeIndex) {
    let p = Project::new();
    p.write("src/config.rs", "/// Load settings from disk.\npub fn load_settings_file(path: &str) -> String {\n    std::fs::read_to_string(path).unwrap()\n}\n");
    p.write("src/net.rs", "/// Retry an HTTP request with exponential backoff.\npub fn retry_with_backoff(attempts: u32) {\n    let delay = 2u64.pow(attempts);\n}\n");
    p.write(
        "web/ui.ts",
        "export function renderButton(label: string) { return label; }\n",
    );
    let ix = p.built();
    (p, ix)
}

#[test]
fn bm25_only_without_an_embedder() {
    let (_p, ix) = project();
    let (hits, _) = ix.semantic_search(&sq("backoff retry"), None).unwrap();
    assert_eq!(hits[0].rel, "src/net.rs");
    assert!(!hits[0].legs.contains("dense"));
}

#[test]
fn dense_leg_finds_concepts_and_fuses() {
    let (_p, ix) = project();
    let e = FakeEmbedder::new("fake");
    ix.sync_vectors(&e, &atlas_search::CancelToken::new())
        .unwrap();
    let (hits, page) = ix
        .semantic_search(&sq("settings disk load"), Some(&e))
        .unwrap();
    assert_eq!(hits[0].rel, "src/config.rs");
    assert!(hits[0].legs.contains("dense"), "{}", hits[0].legs);
    assert!(hits[0].preview.contains("load_settings_file"));
    assert!(page.total >= 1);
}

#[test]
fn filters_dedup_and_determinism() {
    let (_p, ix) = project();
    let mut q = sq("label render settings retry");
    q.path_glob = Some("web/**".into());
    let (hits, _) = ix.semantic_search(&q, None).unwrap();
    assert!(hits.iter().all(|h| h.rel.starts_with("web/")));
    let a = ix.semantic_search(&sq("retry settings"), None).unwrap().0;
    let b = ix.semantic_search(&sq("retry settings"), None).unwrap().0;
    assert_eq!(a, b);
}

#[test]
fn symbol_leg_only_for_identifiers() {
    let (_p, ix) = project();
    let (hits, _) = ix
        .semantic_search(&sq("who calls retry_with_backoff"), None)
        .unwrap();
    assert_eq!(hits[0].rel, "src/net.rs");
    assert!(hits[0].legs.contains("symbol"), "{}", hits[0].legs);
    let (hits, _) = ix
        .semantic_search(&sq("where is renderButton"), None)
        .unwrap();
    assert!(hits
        .iter()
        .any(|h| h.rel == "web/ui.ts" && h.legs.contains("symbol")));
    let (hits, _) = ix.semantic_search(&sq("retry with backoff"), None).unwrap();
    assert!(hits.iter().all(|h| !h.legs.contains("symbol")));
}

#[test]
fn punctuation_only_query_is_invalid() {
    let (_p, ix) = project();
    assert!(ix.semantic_search(&sq("?!"), None).is_err());
}

#[test]
fn a_narrow_filter_still_finds_its_chunks_behind_many_better_ones() {
    let p = Project::new();
    for i in 0..120 {
        p.write(
            &format!("web/f{i:03}.ts"),
            &format!("// upload retry upload retry\nexport function upload{i}() {{}}\n"),
        );
    }
    p.write("src/up.rs", "/// upload retry\npub fn send_upload() {}\n");
    let ix = p.built();
    let e = FakeEmbedder::new("fake");
    ix.sync_vectors(&e, &atlas_search::CancelToken::new())
        .unwrap();
    for embedder in [None, Some(&e as &dyn crate::Embedder)] {
        let mut q = sq("upload retry");
        q.path_glob = Some("src/**".into());
        assert_eq!(
            ix.semantic_search(&q, embedder).unwrap().0[0].rel,
            "src/up.rs"
        );
        let mut q = sq("upload retry");
        q.within = Some("src".into());
        assert_eq!(
            ix.semantic_search(&q, embedder).unwrap().0[0].rel,
            "src/up.rs"
        );
    }
}

/// The symbol leg filters before its cut too: 60 `send_upload` definitions under `web/`
/// must not crowd the one under `src/` out of its first 50.
#[test]
fn the_symbol_leg_filters_before_its_cut() {
    let p = Project::new();
    for i in 0..60 {
        p.write(
            &format!("web/f{i:03}.ts"),
            "export function send_upload() {}\n",
        );
    }
    p.write("src/up.rs", "pub fn send_upload() {}\n");
    let ix = p.built();
    let mut q = sq("send_upload");
    q.path_glob = Some("src/**".into());
    let (hits, _) = ix.semantic_search(&q, None).unwrap();
    assert_eq!(hits[0].rel, "src/up.rs");
    assert!(hits[0].legs.contains("symbol"), "{}", hits[0].legs);
    let mut q = sq("send_upload");
    q.lang = Some("rust".into());
    let (hits, _) = ix.semantic_search(&q, None).unwrap();
    assert!(hits[0].legs.contains("symbol"), "{}", hits[0].legs);
}
