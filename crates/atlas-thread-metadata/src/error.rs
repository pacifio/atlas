//! The store's failure modes.

/// Something went wrong reading or writing the store.
#[derive(Debug)]
pub enum Error {
    /// The database was written by a newer build of Atlas. Opening it anyway
    /// would mean operating on a schema this build does not understand, which
    /// is how a record gets corrupted.
    SchemaTooNew { found: i64, supported: i64 },
    /// The store's directory could not be created or opened.
    Storage(String),
    /// The database itself refused a statement. Kept typed rather than folded
    /// into `Storage` so a caller can tell a corrupt store (`SQLITE_CORRUPT`)
    /// from a busy one without parsing a message.
    Sqlite(rusqlite::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::SchemaTooNew { found, supported } => write!(
                f,
                "thread-metadata store is at schema {found}, this build supports {supported}"
            ),
            Error::Storage(msg) => write!(f, "thread-metadata store: {msg}"),
            Error::Sqlite(e) => write!(f, "thread-metadata store: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Sqlite(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sqlite(e)
    }
}
