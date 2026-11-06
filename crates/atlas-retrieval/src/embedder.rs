/// A text embedding model. Memory adapts `atlas-embed`'s MiniLM to it; the
/// code index adapts its code model (code-index plan, Phase 4).
pub trait Embedder: Send + Sync {
    fn model_id(&self) -> &str;
    fn dims(&self) -> usize;
    fn embed_documents(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String>;
    fn embed_query(&self, text: &str) -> Result<Vec<f32>, String>;
}
