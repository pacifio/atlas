//! The embedding-provider seam.
//!
//! Ported into Atlas from `cersei-embeddings`. Only the trait and its error type
//! were carried over — the SDK's hosted OpenAI/Gemini providers and its
//! in-memory `EmbeddingStore`/`VectorIndex` are not used here (they have no
//! save/load/remove; `crate::store` drives `usearch` directly).
//!
//! [`MiniLmProvider`](crate::MiniLmProvider) is the only implementor today. The
//! trait stays async and batch-shaped so a remote BYOK provider can drop in
//! behind it without touching call sites.

use async_trait::async_trait;
use thiserror::Error;

/// Why an embedding call failed.
///
/// `Http` is deliberately absent (the Cersei original carried a
/// `#[from] reqwest::Error`): the on-device provider makes no network calls, and
/// a remote implementor can map its transport errors onto [`Api`](Self::Api).
#[derive(Debug, Error)]
pub enum EmbeddingError {
    #[error("API error: {0}")]
    Api(String),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Index error: {0}")]
    Index(String),

    #[error("Config error: {0}")]
    Config(String),
}

/// Produces vector embeddings from text.
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    /// Short identifier, recorded in the index manifest. A change here forces a
    /// full re-embed, so it encodes the model id and dimensionality.
    fn name(&self) -> &str;

    /// Dimensionality of the vectors this provider emits — sizes the HNSW index.
    fn dimensions(&self) -> usize;

    /// Embed a single string. Defaults to delegating to [`embed_batch`](Self::embed_batch).
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let mut out = self.embed_batch(&[text.to_string()]).await?;
        out.pop()
            .ok_or_else(|| EmbeddingError::Api("empty response".into()))
    }

    /// Embed a batch. Implementations handle their own batch-size limits.
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError>;
}
