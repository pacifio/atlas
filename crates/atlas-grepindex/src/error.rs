use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("git: {0}")]
    Git(String),
    #[error("grep index file is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("{} is not the root of a git work tree", .0.display())]
    NotWorktreeRoot(PathBuf),
    #[error("the repository has no HEAD commit yet")]
    NoHead,
    #[error("the index would exceed the limits of format v1")]
    TooLarge,
    #[error("cancelled")]
    Cancelled,
    #[error(
        "the grep index runs on Unix only: elsewhere a file stamp cannot prove a file unchanged"
    )]
    Unsupported,
}

pub(crate) fn git_err(e: impl std::fmt::Display) -> Error {
    Error::Git(e.to_string())
}
