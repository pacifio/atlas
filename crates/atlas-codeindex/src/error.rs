/// Everything the index can fail with. `Display` is written for an agent or a
/// log line, not for a stack trace.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("index database: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("cancelled")]
    Cancelled,
    #[error("no symbol named `{query}`")]
    NotFound {
        query: String,
        suggestions: Vec<String>,
    },
    #[error("{0}")]
    Invalid(String),
}
