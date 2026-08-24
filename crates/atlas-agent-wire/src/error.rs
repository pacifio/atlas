//! How a failure should be classified — the `turn_failed.error_kind` tokens.
//!
//! This lives with the wire because it IS wire: `error_kind` is a frozen field
//! on `SessionDelta::TurnFailed` (`docs/agents/delta-wire-contract.md`) and the
//! frontend routes on its exact values — `auth` sends the user to sign-in
//! rather than showing a protocol error. Both ACP stacks classify failures, so
//! neither can own the taxonomy.
//!
//! Moved verbatim from `atlas-acp/src/error.rs` (the 1.3 stack) at Stage 3 of
//! the Zed port; the classifier's substring tables are unchanged, because a
//! message that routed to sign-in yesterday must still route there today.

/// The shared failure taxonomy. Used to annotate `TurnFailed` and to give
/// command rejections a `kind` the frontend can act on instead of substring
/// matching English prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Worth retrying with backoff (rate limit / overload / IO hiccup).
    Transient,
    /// Needs (re)authentication — never retried, routed to the auth flow.
    Auth,
    /// Will never succeed as-is (bad request / too large / no key).
    Fatal,
    /// The agent process or connection died.
    ProcessDead,
    /// Nothing recognizable — treated as fatal for retry purposes.
    Unknown,
}

impl ErrorClass {
    /// Wire token for `TurnFailed.error_kind` (additive, optional field).
    pub fn wire_token(self) -> &'static str {
        match self {
            ErrorClass::Transient => "transient",
            ErrorClass::Auth => "auth",
            ErrorClass::Fatal => "fatal",
            ErrorClass::ProcessDead => "process_dead",
            ErrorClass::Unknown => "unknown",
        }
    }
}

/// Classify an error message string (provider bodies, adapter errors).
pub fn classify_message(message: &str) -> ErrorClass {
    let m = message.to_ascii_lowercase();
    const AUTH: &[&str] = &[
        "http 401",
        "http 403",
        "authentication",
        "unauthorized",
        "invalid x-api-key",
        "invalid api key",
        "api key not",
        "permission_error",
        "no api key configured",
        "auth required",
        "not authenticated",
        "please run /login",
    ];
    if AUTH.iter().any(|t| m.contains(t)) {
        return ErrorClass::Auth;
    }
    const FATAL: &[&str] = &[
        "http 400",
        "invalid_request",
        "http 413",
        "prompt is too long",
        "too large",
        "credit balance is too low",
        "billing",
        "no model selected",
    ];
    if FATAL.iter().any(|t| m.contains(t)) {
        return ErrorClass::Fatal;
    }
    const DEAD: &[&str] = &[
        "agent disconnected",
        "driver disconnected",
        "driver exited",
        "process exited",
        "channel closed",
    ];
    if DEAD.iter().any(|t| m.contains(t)) {
        return ErrorClass::ProcessDead;
    }
    const TRANSIENT: &[&str] = &[
        "http 429",
        "rate limit",
        "rate_limit",
        "http 529",
        "http 503",
        "overloaded",
        "service unavailable",
        "http 500",
        "http 502",
        "http 504",
        "internal server error",
        "timed out",
        "timeout",
        "connection refused",
        "connection reset",
        "error sending request",
        "error decoding",
        "failed to decode response",
        "gave up after",
    ];
    if TRANSIENT.iter().any(|t| m.contains(t)) {
        return ErrorClass::Transient;
    }
    ErrorClass::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is the contract: each of these routed somewhere specific in
    /// the old stack and must keep routing there.
    #[test]
    fn table_driven_classification() {
        let cases: &[(&str, ErrorClass)] = &[
            ("HTTP 429: rate_limit_error", ErrorClass::Transient),
            ("HTTP 529: overloaded_error", ErrorClass::Transient),
            ("HTTP 503: Service Unavailable", ErrorClass::Transient),
            ("request timed out", ErrorClass::Transient),
            ("error sending request for url", ErrorClass::Transient),
            ("HTTP 429: x (gave up after 4 attempts)", ErrorClass::Transient),
            ("HTTP 401: authentication_error", ErrorClass::Auth),
            ("HTTP 403: permission_error", ErrorClass::Auth),
            ("invalid x-api-key", ErrorClass::Auth),
            (
                "No API key configured for 'anthropic'. Add one in Settings.",
                ErrorClass::Auth,
            ),
            ("Auth required — please run /login", ErrorClass::Auth),
            ("HTTP 400: invalid_request_error", ErrorClass::Fatal),
            ("HTTP 413: prompt is too long", ErrorClass::Fatal),
            (
                "agent disconnected: driver exited cleanly",
                ErrorClass::ProcessDead,
            ),
            ("some novel failure", ErrorClass::Unknown),
        ];
        for (msg, want) in cases {
            assert_eq!(classify_message(msg), *want, "for {msg:?}");
        }
    }

    /// Auth wins over transient when a message could read as either — the
    /// user-facing consequence (sign in vs. wait) makes the wrong pick worse
    /// than useless.
    #[test]
    fn auth_is_checked_before_transient() {
        assert_eq!(
            classify_message("HTTP 401: authentication failed, connection reset"),
            ErrorClass::Auth
        );
    }

    #[test]
    fn wire_tokens_are_the_documented_ones() {
        for (class, token) in [
            (ErrorClass::Auth, "auth"),
            (ErrorClass::Transient, "transient"),
            (ErrorClass::Fatal, "fatal"),
            (ErrorClass::ProcessDead, "process_dead"),
            (ErrorClass::Unknown, "unknown"),
        ] {
            assert_eq!(class.wire_token(), token);
        }
    }
}
