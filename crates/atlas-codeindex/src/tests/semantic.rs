use super::*;
use crate::{tests::FakeEmbedder, SemanticQuery};

fn sq(q: &str) -> SemanticQuery {
    SemanticQuery {
        query: q.into(),
        path_glob: None,
        lang: None,
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
