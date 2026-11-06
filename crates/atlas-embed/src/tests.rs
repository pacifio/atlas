//! Unit tests that need no downloaded model.
//!
//! The vector-store half is pure arithmetic. The embedder half runs against a
//! tiny BERT built on the spot — random weights written through candle's own
//! `VarMap`, a word-level tokenizer, eight hidden dimensions — so the whole
//! load → warm-up → forward path is real, just small. The GPU fallbacks run on
//! the CPU through [`crate::test_seam`], which stands a CPU device in for the
//! GPU and injects panics where candle's kernels throw them.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use candle_core::Device;
use candle_nn::{VarBuilder, VarMap};
use candle_transformers::models::bert::{BertModel, Config, DTYPE};

use super::*;
use crate::test_seam::{Fault, FAKE_GPU, FAULT, GPU_ATTEMPTS};

// ── Vector store ────────────────────────────────────────────────────────────

fn unit(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / norm).collect()
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-5
}

#[test]
fn cosine_of_unit_vectors_is_their_dot_product() {
    let x = unit(&[1.0, 0.0]);
    let y = unit(&[0.0, 1.0]);
    let d = unit(&[1.0, 1.0]);
    assert!(close(cosine(&x, &x), 1.0));
    assert!(close(cosine(&x, &y), 0.0));
    assert!(close(cosine(&x, &[-1.0, 0.0]), -1.0));
    assert!(close(cosine(&x, &d), std::f32::consts::FRAC_1_SQRT_2));
    // Symmetric.
    assert_eq!(cosine(&x, &d), cosine(&d, &x));
}

#[test]
fn cosine_against_the_zero_vector_is_zero_not_nan() {
    // What `forward_current` returns for text that tokenizes to nothing: it
    // must score as unrelated to everything rather than poison a sort.
    assert_eq!(cosine(&[0.0; 3], &unit(&[1.0, 2.0, 3.0])), 0.0);
}

#[test]
fn search_returns_the_best_k_best_first() {
    let store = BruteForce::new(vec![
        unit(&[0.0, 1.0]),  // 0: orthogonal to the query
        unit(&[1.0, 0.1]),  // 1: nearly the query
        unit(&[-1.0, 0.0]), // 2: opposite
        unit(&[1.0, 1.0]),  // 3: 45 degrees off
    ]);
    let query = unit(&[1.0, 0.0]);

    let hits = store.search(&query, 3);
    let order: Vec<usize> = hits.iter().map(|(i, _)| *i).collect();
    assert_eq!(order, [1, 3, 0]);
    assert!(hits.windows(2).all(|w| w[0].1 >= w[1].1));

    // k larger than the store returns everything, still ordered.
    let all: Vec<usize> = store.search(&query, 10).iter().map(|(i, _)| *i).collect();
    assert_eq!(all, [1, 3, 0, 2]);
    assert!(store.search(&query, 0).is_empty());
}

#[test]
fn search_breaks_ties_by_insertion_order() {
    // `sort_by` is stable, so equal scores keep index order — the ranking is
    // deterministic across runs.
    let v = unit(&[1.0, 1.0]);
    let store = BruteForce::new(vec![v.clone(), v.clone(), v.clone()]);
    let order: Vec<usize> = store.search(&v, 3).iter().map(|(i, _)| *i).collect();
    assert_eq!(order, [0, 1, 2]);
}

#[test]
fn an_empty_store_finds_nothing() {
    let store = BruteForce::new(Vec::new());
    assert!(store.is_empty());
    assert_eq!(store.len(), 0);
    assert!(store.search(&[1.0, 0.0], 5).is_empty());
    assert!(store.all_pairs_topk(5).is_empty());
}

#[test]
fn all_pairs_topk_excludes_self_and_orders_neighbours() {
    let store = BruteForce::new(vec![
        unit(&[1.0, 0.0]),
        unit(&[1.0, 0.2]),
        unit(&[0.0, 1.0]),
    ]);
    assert_eq!(store.len(), 3);

    let graph = store.all_pairs_topk(2);
    assert_eq!(graph.len(), 3, "one neighbour list per vector");
    for (i, neighbours) in graph.iter().enumerate() {
        assert_eq!(neighbours.len(), 2);
        assert!(neighbours.iter().all(|(j, _)| *j != i), "{i} lists itself");
        assert!(neighbours.windows(2).all(|w| w[0].1 >= w[1].1));
    }
    assert_eq!(graph[0][0].0, 1);
    assert_eq!(graph[1][0].0, 0);
    assert_eq!(graph[2][0].0, 1, "[1, 0.2] is nearer [0, 1] than [1, 0] is");

    let top1 = store.all_pairs_topk(1);
    assert!(top1.iter().all(|n| n.len() == 1));

    // A single vector has no neighbours at all.
    assert_eq!(
        BruteForce::new(vec![unit(&[1.0])]).all_pairs_topk(3),
        vec![vec![]]
    );
}

// ── A tiny real model ───────────────────────────────────────────────────────

const HIDDEN: usize = 8;

/// A scratch directory removed on drop. The crate has no dev-dependencies, and
/// adding `tempfile` would move `Cargo.lock`.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "atlas-embed-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Write `config.json`, `tokenizer.json` and `model.safetensors` for a
/// one-layer, eight-dimension BERT. The weights are whatever candle's
/// initialisers produce: nothing here depends on the model being good, only on
/// it being a model.
fn tiny_model() -> Scratch {
    let dir = Scratch::new();
    let config = r#"{
        "vocab_size": 8,
        "hidden_size": 8,
        "num_hidden_layers": 1,
        "num_attention_heads": 2,
        "intermediate_size": 16,
        "hidden_act": "gelu",
        "hidden_dropout_prob": 0.0,
        "max_position_embeddings": 512,
        "type_vocab_size": 2,
        "initializer_range": 0.02,
        "layer_norm_eps": 1e-12,
        "pad_token_id": 0,
        "classifier_dropout": null,
        "model_type": "bert"
    }"#;
    std::fs::write(dir.path().join("config.json"), config).unwrap();

    // Word-level, whitespace-split, with no special tokens and no
    // post-processor — so empty text genuinely tokenizes to zero ids.
    let tokenizer = r#"{
        "version": "1.0",
        "truncation": null,
        "padding": null,
        "added_tokens": [],
        "normalizer": null,
        "pre_tokenizer": {"type": "Whitespace"},
        "post_processor": null,
        "decoder": null,
        "model": {
            "type": "WordLevel",
            "vocab": {"[UNK]": 0, "hello": 1, "world": 2, "warm": 3, "atlas": 4},
            "unk_token": "[UNK]"
        }
    }"#;
    std::fs::write(dir.path().join("tokenizer.json"), tokenizer).unwrap();

    let config: Config = serde_json::from_str(config).unwrap();
    let varmap = VarMap::new();
    let vb = VarBuilder::from_varmap(&varmap, DTYPE, &Device::Cpu);
    BertModel::load(vb, &config).expect("candle creates every weight it asks for");
    varmap.save(dir.path().join("model.safetensors")).unwrap();
    dir
}

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

#[test]
fn a_loaded_model_embeds_to_unit_vectors_of_its_hidden_size() {
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).unwrap();
    assert_eq!(embedder.dim(), HIDDEN);
    assert_eq!(embedder.backend(), "cpu");

    let v = embedder.embed_one("hello world").unwrap();
    assert_eq!(v.len(), HIDDEN);
    assert!(
        close(norm(&v), 1.0),
        "L2-normalised, so cosine is a dot: {}",
        norm(&v)
    );
    assert_eq!(
        v,
        embedder.embed_one("hello world").unwrap(),
        "deterministic"
    );

    let batch = embedder
        .embed(&["hello".to_string(), "atlas world".to_string()])
        .unwrap();
    assert_eq!(batch.len(), 2);
    // One padded batch: the shorter text's padding is masked out, so it
    // matches its own forward up to float summation order.
    let single = embedder.embed_one("hello").unwrap();
    assert!(
        batch[0]
            .iter()
            .zip(&single)
            .all(|(a, b)| (a - b).abs() < 1e-5),
        "{:?} vs {single:?}",
        batch[0]
    );
}

#[test]
fn text_that_tokenizes_to_nothing_embeds_to_the_zero_vector() {
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).unwrap();
    for empty in ["", "   ", "\n\t"] {
        assert_eq!(
            embedder.embed_one(empty).unwrap(),
            vec![0.0; HIDDEN],
            "{empty:?}"
        );
    }
}

#[test]
fn text_longer_than_the_position_table_is_truncated_not_rejected() {
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).unwrap();
    let long = "hello ".repeat(ModelSpec::default().max_tokens * 2);
    let v = embedder.embed_one(&long).unwrap();
    assert!(close(norm(&v), 1.0));
}

#[test]
fn a_directory_missing_a_file_fails_to_load() {
    let model = tiny_model();
    std::fs::remove_file(model.path().join("model.safetensors")).unwrap();
    assert!(Embedder::load(model.path()).is_err());
}

// ── The GPU fallbacks, on a fake GPU ────────────────────────────────────────

/// `ATLAS_EMBED_CPU` is process-wide, so every test that reaches the GPU
/// decision holds this lock: one of them setting the variable must not turn
/// another's GPU load into a CPU one.
static ENV: Mutex<()> = Mutex::new(());

/// Arms the fake GPU on this thread (and the env lock) for its lifetime.
struct FakeGpu {
    _env: MutexGuard<'static, ()>,
}

impl FakeGpu {
    fn with(fault: Fault) -> Self {
        let env = ENV
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        FAKE_GPU.with(|f| f.set(true));
        FAULT.with(|f| f.set(fault));
        GPU_ATTEMPTS.with(|n| n.set(0));
        Self { _env: env }
    }

    fn fault(&self, fault: Fault) {
        FAULT.with(|f| f.set(fault));
    }

    fn attempts(&self) -> usize {
        GPU_ATTEMPTS.with(Cell::get)
    }
}

impl Drop for FakeGpu {
    fn drop(&mut self) {
        FAKE_GPU.with(|f| f.set(false));
        FAULT.with(|f| f.set(Fault::None));
    }
}

fn marker(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(GPU_INCOMPATIBLE_MARKER)).ok()
}

#[test]
fn a_healthy_gpu_is_used_and_no_marker_is_written() {
    let gpu = FakeGpu::with(Fault::None);
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).unwrap();
    assert_eq!(gpu.attempts(), 1);
    assert_eq!(embedder.backend(), "gpu");
    assert_eq!(marker(model.path()), None);
}

/// The Metal kernel-compile panic: candle unwinds while building the model on
/// the GPU. `load`'s `catch_unwind` must turn that into a CPU model, and
/// persist the marker so the next launch does not try again.
///
/// Debug tests always unwind, so this proves the handling. It cannot prove the
/// release profile keeps `panic = "unwind"` (root `Cargo.toml`) — under
/// `abort` the guard never runs and the app dies at launch instead.
#[test]
fn a_panic_while_loading_on_the_gpu_falls_back_to_cpu_and_writes_the_marker() {
    let gpu = FakeGpu::with(Fault::PanicInBuild);
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).expect("the panic must not escape");
    assert_eq!(gpu.attempts(), 1);
    assert_eq!(embedder.backend(), "cpu");
    assert!(close(norm(&embedder.embed_one("hello").unwrap()), 1.0));
    assert_eq!(
        marker(model.path()).as_deref(),
        Some("embedder load failed on gpu\n")
    );
}

/// The other load-time shape: the weights load, then a warm-up forward hits a
/// kernel that will not compile. `forward_current` turns that panic into an
/// `Err`, which `load` must treat exactly like the panic above.
#[test]
fn a_warm_up_failure_on_the_gpu_falls_back_to_cpu_and_writes_the_marker() {
    let _gpu = FakeGpu::with(Fault::PanicInForward);
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).unwrap();
    assert_eq!(embedder.backend(), "cpu");
    assert!(marker(model.path()).is_some());
}

#[test]
fn the_marker_skips_the_gpu_on_the_next_load() {
    let gpu = FakeGpu::with(Fault::PanicInBuild);
    let model = tiny_model();
    drop(Embedder::load(model.path()).unwrap());
    assert_eq!(gpu.attempts(), 1);

    // The GPU would now load fine, but the marker says this machine cannot,
    // and a marker is only ever cleared by re-downloading the model.
    gpu.fault(Fault::None);
    let embedder = Embedder::load(model.path()).unwrap();
    assert_eq!(gpu.attempts(), 1, "no second GPU attempt");
    assert_eq!(embedder.backend(), "cpu");
}

#[test]
fn atlas_embed_cpu_skips_the_gpu_entirely() {
    let gpu = FakeGpu::with(Fault::None);
    let model = tiny_model();
    // Edition 2021: `set_var` is safe to call, and `ENV` serialises every test
    // that reads the variable.
    std::env::set_var("ATLAS_EMBED_CPU", "1");
    let loaded = Embedder::load(model.path());
    std::env::remove_var("ATLAS_EMBED_CPU");

    let embedder = loaded.unwrap();
    assert_eq!(gpu.attempts(), 0);
    assert_eq!(embedder.backend(), "cpu");
    assert_eq!(
        marker(model.path()),
        None,
        "forcing CPU is not a GPU failure"
    );
}

/// A GPU that loaded and warmed up cleanly can still fail on a new shape
/// mid-session. The request must still succeed — rebuilt on the CPU in place,
/// with the marker persisted — and callers must not see the transient.
#[test]
fn a_gpu_failure_at_request_time_rebuilds_on_cpu_and_retries() {
    let gpu = FakeGpu::with(Fault::None);
    let model = tiny_model();
    let embedder = Embedder::load(model.path()).unwrap();
    assert_eq!(embedder.backend(), "gpu");
    let before = embedder.embed_one("hello world").unwrap();

    gpu.fault(Fault::PanicInForward);
    let after = embedder
        .embed_one("hello world")
        .expect("the retry on CPU succeeds");
    assert_eq!(embedder.backend(), "cpu");
    assert_eq!(
        marker(model.path()).as_deref(),
        Some("embedder gpu failed at request time\n")
    );
    // Same weights, same (CPU) arithmetic underneath the fake GPU.
    assert_eq!(before, after);

    // Healed: later requests go straight to the CPU core.
    assert_eq!(embedder.embed_one("hello world").unwrap(), after);
}

#[test]
fn a_model_forced_onto_the_cpu_never_takes_the_gpu_fallback() {
    // The request-time fallback is keyed on the core being a GPU one. A core
    // that started on the CPU has nothing to fall back to, so it is never
    // rebuilt and never marks the model — even with the GPU fault armed.
    let gpu = FakeGpu::with(Fault::PanicInForward);
    let model = tiny_model();
    std::env::set_var("ATLAS_EMBED_CPU", "1");
    let loaded = Embedder::load(model.path());
    std::env::remove_var("ATLAS_EMBED_CPU");
    let embedder = loaded.unwrap();
    assert_eq!(gpu.attempts(), 0);
    assert!(embedder.embed_one("hello").is_ok());
    assert_eq!(embedder.backend(), "cpu");
    assert_eq!(marker(model.path()), None);
}

// ── Batched multi-architecture embedder (Phase 4) ───────────────────────────

/// Needs a downloaded model: ATLAS_TEST_MODEL_DIR=/path/to/all-MiniLM-L6-v2 (or granite-embedding-small-r2, coderankembed).
#[test]
#[ignore = "needs ATLAS_TEST_MODEL_DIR"]
fn batched_equals_single_when_model_available() {
    let dir = std::path::PathBuf::from(std::env::var("ATLAS_TEST_MODEL_DIR").unwrap());
    let e = Embedder::load(&dir).unwrap();
    let texts = [
        "fn a() {}",
        "a much longer text that needs padding against the short one in the same batch",
    ];
    let batch = e.embed_documents(&texts).unwrap();
    for (t, b) in texts.iter().zip(&batch) {
        let one = e.embed_documents(&[t]).unwrap().remove(0);
        let cos: f32 = one.iter().zip(b).map(|(x, y)| x * y).sum();
        assert!(cos > 0.9999, "{t}: {cos}");
    }
    let q = e.embed_query("parse a config file").unwrap();
    assert_eq!(q.len(), e.dim());
}

#[test]
fn unknown_model_type_is_a_clear_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("config.json"), r#"{"model_type":"llama"}"#).unwrap();
    std::fs::write(dir.path().join("tokenizer.json"), "{}").unwrap();
    let err = Embedder::load(dir.path()).err().unwrap().to_string();
    assert!(err.contains("llama") || err.contains("tokenizer"), "{err}");
}
