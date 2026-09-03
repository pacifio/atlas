//! Failure modes, kept in one vocabulary across the socket and REST.
//!
//! The contract answers `404` for every closed door — a private channel, a DM,
//! a conversation we were removed from, and an id that was never real are
//! deliberately indistinguishable, so nothing here tries to tell them apart.
//! The one exception is the socket handshake, where `403` means "valid token,
//! not a member of this organisation" and is worth its own variant because it
//! is the difference between backing off and giving up.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CommsError {
    #[error("no account token: {0}")]
    Token(String),

    /// The handshake or a REST call was refused for want of a valid credential.
    /// Worth one immediate re-mint before giving up: the JWT lives ten minutes
    /// and can expire between minting and dialling.
    #[error("unauthorized")]
    Unauthorized,

    /// Valid token, but not a member. Retrying cannot help.
    #[error("forbidden")]
    Forbidden,

    /// Every closed door.
    #[error("not found")]
    NotFound,

    /// A structured refusal from the server, carrying its own code and detail —
    /// `group_dm_frozen` with its `fork_hint`, `quota_exceeded` with its byte
    /// counts. Passed through rather than flattened, because the detail is what
    /// the UI has to render.
    #[error("{code}: {message}")]
    Refused {
        code: String,
        message: String,
        detail: Option<serde_json::Value>,
    },

    #[error("transport: {0}")]
    Transport(String),

    #[error("protocol: {0}")]
    Protocol(String),

    #[error("store: {0}")]
    Store(String),
}

pub type Result<T> = std::result::Result<T, CommsError>;

impl From<rusqlite::Error> for CommsError {
    fn from(e: rusqlite::Error) -> Self {
        CommsError::Store(e.to_string())
    }
}

impl From<reqwest::Error> for CommsError {
    fn from(e: reqwest::Error) -> Self {
        CommsError::Transport(e.to_string())
    }
}

impl From<serde_json::Error> for CommsError {
    fn from(e: serde_json::Error) -> Self {
        CommsError::Protocol(e.to_string())
    }
}
