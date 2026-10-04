//! The retrieval core shared by Atlas memory (`atlas-memory`) and the code
//! index (`atlas-codeindex`): one way to key cached embeddings, one vector
//! file that heals, one fusion. See docs/superpowers/plans/2026-10-03-memory-system/00-overview.md.

pub mod codec;
mod embedder;
mod error;
pub mod rrf;
pub mod vectors;

pub use embedder::Embedder;
pub use error::RetrievalError;

#[cfg(test)]
mod tests;
