use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::Embedder;

/// Deterministic bag-of-words vectors: cosine ≈ word overlap.
pub(crate) struct FakeEmbedder {
    pub id: String,
    pub calls: AtomicUsize,
}

impl FakeEmbedder {
    pub(crate) fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            calls: AtomicUsize::new(0),
        }
    }
    fn vec(text: &str) -> Vec<f32> {
        let mut v = vec![0f32; 64];
        for w in text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
        {
            let h = blake3::hash(w.to_lowercase().as_bytes()).as_bytes()[0] as usize % 64;
            v[h] += 1.0;
        }
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        v.iter().map(|x| x / n).collect()
    }
}

impl Embedder for FakeEmbedder {
    fn model_id(&self) -> &str {
        &self.id
    }
    fn dims(&self) -> usize {
        64
    }
    fn embed_documents(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        self.calls.fetch_add(texts.len(), Ordering::SeqCst);
        Ok(texts.iter().map(|t| Self::vec(t)).collect())
    }
    fn embed_query(&self, text: &str) -> Result<Vec<f32>, String> {
        Ok(Self::vec(text))
    }
}

#[test]
fn sync_embeds_once_then_only_what_changed() {
    let p = Project::new();
    p.write("src/a.rs", "pub fn alpha() {}\n")
        .write("src/b.rs", "pub fn beta() {}\n");
    let ix = p.built();
    let e = FakeEmbedder::new("fake");
    let s = ix
        .sync_vectors(&e, &atlas_search::CancelToken::new())
        .unwrap();
    assert_eq!((s.added, s.embedded), (2, 2));
    assert_eq!(
        ix.sync_vectors(&e, &atlas_search::CancelToken::new())
            .unwrap(),
        crate::VectorStats::default()
    );
    p.write("src/a.rs", "pub fn alpha_two() {}\n");
    ix.update_paths(&[p.path("src/a.rs")]).unwrap();
    let s = ix
        .sync_vectors(&e, &atlas_search::CancelToken::new())
        .unwrap();
    assert_eq!((s.added, s.removed, s.embedded), (1, 1, 1));
    assert_eq!(e.calls.load(Ordering::SeqCst), 3);
}

#[test]
fn reverting_an_edit_hits_the_embedding_cache() {
    let p = Project::new();
    p.write("src/a.rs", "pub fn alpha() {}\n");
    let ix = p.built();
    let e = FakeEmbedder::new("fake");
    let cancel = atlas_search::CancelToken::new();
    ix.sync_vectors(&e, &cancel).unwrap();
    p.write("src/a.rs", "pub fn other() {}\n");
    ix.update_paths(&[p.path("src/a.rs")]).unwrap();
    ix.sync_vectors(&e, &cancel).unwrap();
    p.write("src/a.rs", "pub fn alpha() {}\n");
    ix.update_paths(&[p.path("src/a.rs")]).unwrap();
    let s = ix.sync_vectors(&e, &cancel).unwrap();
    assert_eq!((s.cached, s.embedded), (1, 0));
}

#[test]
fn model_switch_uses_a_separate_vector_file() {
    let p = Project::new();
    p.write("src/a.rs", "pub fn alpha() {}\n");
    let ix = p.built();
    let cancel = atlas_search::CancelToken::new();
    ix.sync_vectors(&FakeEmbedder::new("m1"), &cancel).unwrap();
    let s = ix.sync_vectors(&FakeEmbedder::new("m2"), &cancel).unwrap();
    assert_eq!(s.added, 1, "m2 starts empty");
    let dir = p.path(".atlas/code-index");
    assert!(dir.join("chunks.m1.usearch").is_file() && dir.join("chunks.m2.usearch").is_file());
}

#[test]
fn stale_file_text_is_skipped() {
    let p = Project::new();
    p.write("src/a.rs", "pub fn alpha() {}\n");
    let ix = p.built();
    p.write("src/a.rs", "pub fn changed_behind_the_index() {}\n"); // no update_paths
    let s = ix
        .sync_vectors(
            &FakeEmbedder::new("fake"),
            &atlas_search::CancelToken::new(),
        )
        .unwrap();
    assert_eq!((s.added, s.skipped_stale), (0, 1));
}

#[test]
fn a_crash_before_save_heals_on_reopen_from_the_cache() {
    let p = Project::new();
    p.write("src/a.rs", "pub fn alpha() {}\n")
        .write("src/b.rs", "pub fn beta() {}\n");
    let ix = p.built();
    let e = FakeEmbedder::new("fake");
    let cancel = atlas_search::CancelToken::new();
    ix.sync_vectors(&e, &cancel).unwrap();
    drop(ix);
    // A crash after `chunk_vectors` was committed but before the file was
    // saved leaves rows for vectors the file lacks. Recreate that state.
    let file = p.path(".atlas/code-index/chunks.fake.usearch");
    let db = rusqlite::Connection::open(p.path(".atlas/code-index/index.db")).unwrap();
    let lost: i64 = db
        .query_row(
            "SELECT vkey FROM chunk_vectors ORDER BY vkey LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    let (v, _) = atlas_retrieval::vectors::VectorFile::open(file, 64).unwrap();
    v.remove(lost);
    v.save().unwrap();
    drop(v);
    let ix = crate::CodeIndex::open(p.root()).unwrap();
    let s = ix.sync_vectors(&e, &cancel).unwrap();
    assert_eq!(
        (s.added, s.embedded, s.cached),
        (1, 0, 1),
        "re-added from embed_cache, no model call"
    );
    assert_eq!(e.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        ix.sync_vectors(&e, &cancel).unwrap(),
        crate::VectorStats::default()
    );
}

#[test]
fn sync_on_empty_index_is_a_no_op() {
    let p = Project::new();
    let ix = p.built();
    assert_eq!(
        ix.sync_vectors(
            &FakeEmbedder::new("fake"),
            &atlas_search::CancelToken::new()
        )
        .unwrap(),
        crate::VectorStats::default()
    );
}
