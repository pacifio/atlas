use thiserror::Error;

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("registry fetch failed: {0}")]
    Fetch(String),
    #[error("registry manifest parse failed: {0}")]
    Parse(String),
    #[error("unknown registry agent: {0}")]
    UnknownAgent(String),
    #[error("agent {0} is not installed")]
    NotInstalled(String),
    #[error("agent {id} has no distribution usable on this platform ({reason})")]
    UnsupportedPlatform { id: String, reason: String },
    #[error("unsupported archive format: {0} (only .zip, .tar.gz/.tgz and raw binaries are handled)")]
    UnsupportedArchiveFormat(String),
    #[error("sha256 mismatch for {id}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        id: String,
        expected: String,
        actual: String,
    },
    #[error("download failed: {0}")]
    Download(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, RegistryError>;
