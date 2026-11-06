//! The failure taxonomy for the artifacts read surface.
//!
//! Shaped like `atlas_comms::CommsError` and for the same reason: the caller
//! has to be able to tell "your credential was refused" from "the network
//! blinked", because only the first one is worth surfacing to the developer and
//! only the second one is worth retrying.

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No credential, or one the server refused (401).
    ///
    /// **An indeterminate mint is not this.** A mint that failed because the
    /// auth service was unreachable is a `Transport` — classifying it here
    /// would tell a developer on a flaky connection that they had been signed
    /// out, which is the mistake `commands/comms.rs` documents at length.
    #[error("not authorized: {0}")]
    Unauthorized(String),

    /// The server understood and refused (403). Terminal for this Project
    /// until membership changes — retrying cannot help.
    #[error("forbidden: {0}")]
    Forbidden(String),

    /// No such Project or Session, or one this identity may not see. The server
    /// deliberately answers 404 rather than 403 for an invisible Project, so
    /// these are the same case from here.
    #[error("not found: {0}")]
    NotFound(String),

    /// Rate limited. `retry_after` is delta-seconds, as the server sends it.
    #[error("rate limited; retry after {retry_after}s")]
    RateLimited { retry_after: u64 },

    /// The request never completed. Always retryable.
    #[error("transport: {0}")]
    Transport(String),

    /// It completed, and the body was not what the contract says.
    #[error("protocol: {0}")]
    Protocol(String),
}

impl Error {
    /// Is trying this again later reasonable?
    ///
    /// `Forbidden` is deliberately absent: a refusal the server is sure about
    /// does not become an acceptance by being asked twice.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::RateLimited { .. })
    }

    /// Map an HTTP status onto the taxonomy.
    pub fn from_status(status: u16, context: impl fmt::Display) -> Self {
        match status {
            401 => Self::Unauthorized(context.to_string()),
            403 => Self::Forbidden(context.to_string()),
            404 => Self::NotFound(context.to_string()),
            429 => Self::RateLimited { retry_after: 60 },
            _ => Self::Transport(format!("{context}: server returned {status}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forbidden_is_never_retried() {
        // Terminal by design: the drain and the socket both stop on it rather
        // than hammering a Project the identity has been removed from.
        assert!(!Error::Forbidden("gone".into()).retryable());
        assert!(!Error::Unauthorized("no token".into()).retryable());
        assert!(!Error::NotFound("no such session".into()).retryable());
        assert!(Error::Transport("dns".into()).retryable());
        assert!(Error::RateLimited { retry_after: 60 }.retryable());
    }

    #[test]
    fn statuses_map_onto_the_taxonomy() {
        assert!(matches!(
            Error::from_status(401, "read"),
            Error::Unauthorized(_)
        ));
        assert!(matches!(
            Error::from_status(403, "read"),
            Error::Forbidden(_)
        ));
        assert!(matches!(
            Error::from_status(404, "read"),
            Error::NotFound(_)
        ));
        assert!(matches!(
            Error::from_status(429, "read"),
            Error::RateLimited { .. }
        ));
        // Anything else is the network's fault until proven otherwise, so it
        // stays retryable rather than becoming a permanent local failure.
        assert!(Error::from_status(503, "read").retryable());
        assert!(Error::from_status(500, "read").retryable());
    }
}
