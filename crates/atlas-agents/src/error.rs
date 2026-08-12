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
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
