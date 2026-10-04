#[derive(Debug, thiserror::Error)]
pub enum RetrievalError {
    #[error("usearch: {0}")]
    Index(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
