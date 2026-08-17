use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("unknown plugin id: {0}")]
    UnknownPlugin(String),
    #[error("unknown session")]
    UnknownSession,
    #[error("session already exists")]
    SessionExists,
    #[error("session worker is gone")]
    WorkerGone,
    #[error("mode is not advertised by this session: {0}")]
    InvalidMode(String),
    #[error("acp: {0}")]
    Acp(#[from] atlas_acp::AcpError),
    #[error("io: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn other(msg: impl Into<String>) -> Self {
        Error::Other(msg.into())
    }

    /// Classify this failure for display/routing, using the same taxonomy the
    /// actor stamps onto `TurnFailed.error_kind`.
    ///
    /// The command boundary needs this because some failures never reach a
    /// turn at all: Cursor rejects `session/new` outright when unauthenticated,
    /// so the bind fails and no `atlas:auth-required` is ever emitted. Without
    /// a kind on the error itself the frontend was left substring-matching a
    /// message string to decide whether to offer sign-in.
    pub fn class(&self) -> atlas_acp::ErrorClass {
        match self {
            Error::Acp(e) => e.class(),
            Error::WorkerGone => atlas_acp::ErrorClass::ProcessDead,
            Error::UnknownPlugin(_) | Error::InvalidMode(_) => atlas_acp::ErrorClass::Fatal,
            Error::UnknownSession | Error::SessionExists => atlas_acp::ErrorClass::Unknown,
            Error::Io(m) | Error::Other(m) => atlas_acp::classify_message(m),
        }
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
