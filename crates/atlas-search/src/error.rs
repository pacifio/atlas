//! What a search can fail with. Every message is written for the model that
//! will read it: short, and saying what to do instead.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchError {
    /// The pattern does not compile (or is too big to).
    Regex(String),
    /// A glob, file type or deny pattern is malformed.
    Glob(String),
    /// A path is missing or outside the session root.
    Path(String),
    /// The root could not be read at all.
    Io(String),
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Regex(m) => write!(f, "regex error: {m}"),
            Self::Glob(m) => write!(f, "glob error: {m}"),
            Self::Path(m) => write!(f, "path error: {m}"),
            Self::Io(m) => write!(f, "io error: {m}"),
        }
    }
}

impl std::error::Error for SearchError {}
