//! Atlas memory's retrieval core (`atlas-memory`): one way to key cached
//! embeddings, one vector file that heals, one fusion. It was shared with the
//! code index until ADR-0021 removed that; memory is its only consumer now. See docs/superpowers/plans/2026-10-03-memory-system/00-overview.md.

pub mod codec;
mod embedder;
mod error;
pub mod rrf;
pub mod vectors;

pub use embedder::Embedder;
pub use error::RetrievalError;

#[cfg(test)]
mod tests;
