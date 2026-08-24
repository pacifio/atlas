//! `MiniLmProvider` — bridges Atlas's on-device MiniLM embedder ([`atlas_embed::Embedder`])
//! into Cersei's [`EmbeddingProvider`] trait, so the same HNSW pipeline can later
//! accept a BYOK remote provider behind the same interface.
//!
//! Embeddings stay **on-device** (no network). The blocking candle forward pass
//! runs inside [`tokio::task::spawn_blocking`] so it never stalls the async
//! runtime / IPC channel.

use std::sync::Arc;

use async_trait::async_trait;
use atlas_embed::Embedder;
use crate::embedding::{EmbeddingError, EmbeddingProvider};

/// Default provider identifier recorded in a *fresh* manifest before the first
/// index pass reconciles it to the actually-selected model. A mismatch between
/// the manifest's `provider_name` and the loaded provider's [`name`](EmbeddingProvider::name)
/// forces a full re-embed (see `MemoryEngine::index_params_match`).
pub const PROVIDER_NAME: &str = "atlas-minilm-384";
/// Default embedding dimensionality (`all-MiniLM-L6-v2`). The live provider
/// reports the loaded model's actual dim via [`dimensions`](EmbeddingProvider::dimensions),
/// which may differ (e.g. 768 for BGE/GTE-base).
pub const DIM: usize = 384;

/// On-device embedding provider. Wraps a shared [`Embedder`] (the model is loaded
/// once, then cloned cheaply via `Arc` into each blocking task). The provider is
/// tagged with the selected model's id + its actual output dim so the memory
/// index can detect a model switch and rebuild.
pub struct MiniLmProvider {
    embedder: Arc<Embedder>,
    /// Stable manifest tag: `<model_id>-<dim>`. Switching models (or a dim change)
    /// changes this, which triggers a full re-embed of the project index.
    name: String,
    /// The loaded model's output dimensionality (read from the embedder).
    dim: usize,
}

impl MiniLmProvider {
    /// Wrap an already-loaded embedder, tagged with the selected `model_id`.
    /// The dimensionality is read from the embedder; the manifest tag embeds both
    /// the model id and dim so a switch is always detected. Loading the model from
    /// disk is the caller's responsibility ([`Embedder::load`]).
    pub fn new(embedder: Arc<Embedder>, model_id: impl Into<String>) -> Self {
        let dim = embedder.dim();
        let name = format!("{}-{dim}", model_id.into());
        Self {
            embedder,
            name,
            dim,
        }
    }

    /// The wrapped on-device embedder, for callers that need synchronous
    /// `embed_one` / `embed` inside their own `spawn_blocking` (memory graph,
    /// index query, policy distillation, memory-chat). A cheap `Arc` clone — the
    /// underlying MiniLM model is loaded once (via [`MemoryRegistry::provider`])
    /// and shared everywhere, so no call site ever re-loads it from disk.
    pub fn embedder(&self) -> Arc<Embedder> {
        self.embedder.clone()
    }

    /// The manifest tag for the loaded model (`<model_id>-<dim>`). Inherent accessor
    /// so callers don't need the `EmbeddingProvider` trait in scope.
    pub fn provider_name(&self) -> &str {
        &self.name
    }

    /// The loaded model's output dimensionality (inherent accessor).
    pub fn dim(&self) -> usize {
        self.dim
    }
}

#[async_trait]
impl EmbeddingProvider for MiniLmProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn dimensions(&self) -> usize {
        self.dim
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let embedder = self.embedder.clone();
        let texts = texts.to_vec();
        // The candle forward pass is blocking CPU work — keep it off the async
        // runtime so the IPC channel never stalls (CLAUDE.md convention).
        tokio::task::spawn_blocking(move || embedder.embed(&texts))
            .await
            .map_err(|e| EmbeddingError::Api(format!("embed join error: {e}")))?
            .map_err(|e| EmbeddingError::Api(format!("on-device embed failed: {e}")))
    }
}

// Compile-time guarantee the provider is object-safe-friendly and shareable.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<MiniLmProvider>();
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Locate a local MiniLM model dir if one is installed, else `None`. Tests
    /// that need real embeddings skip cleanly when absent (no hard-fail / no
    /// network download).
    fn find_model_dir() -> Option<std::path::PathBuf> {
        if let Ok(dir) = std::env::var("ATLAS_MINILM_DIR") {
            let p = std::path::PathBuf::from(dir);
            if p.join("model.safetensors").exists() {
                return Some(p);
            }
        }
        None
    }

    #[test]
    fn name_and_dimensions_are_stable() {
        // Defaults are unchanged (fresh-manifest tag + MiniLM dim).
        assert_eq!(PROVIDER_NAME, "atlas-minilm-384");
        assert_eq!(DIM, 384);

        if let Some(dir) = find_model_dir() {
            let embedder = Embedder::load(&dir).expect("load MiniLM model");
            let provider = MiniLmProvider::new(Arc::new(embedder), "all-MiniLM-L6-v2");
            // Name embeds the model id + actual dim; MiniLM is 384-d.
            assert_eq!(provider.name(), "all-MiniLM-L6-v2-384");
            assert_eq!(provider.dimensions(), 384);
        }
    }

    #[test]
    fn embed_produces_384d_when_model_available() {
        let Some(dir) = find_model_dir() else {
            eprintln!("skipping: no MiniLM model dir (set ATLAS_MINILM_DIR to enable)");
            return;
        };
        let embedder = Embedder::load(&dir).expect("load MiniLM model");
        let provider = MiniLmProvider::new(Arc::new(embedder), "all-MiniLM-L6-v2");
        let rt = tokio::runtime::Runtime::new().expect("tokio rt");
        let vecs = rt
            .block_on(provider.embed_batch(&["hello world".to_string()]))
            .expect("embed");
        assert_eq!(vecs.len(), 1);
        assert_eq!(vecs[0].len(), 384);
    }
}
