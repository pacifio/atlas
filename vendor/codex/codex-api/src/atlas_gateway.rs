// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! Atlas's error-classification arm for the Atlas AI gateway (spec D13).
//!
//! Added by Atlas; upstream has no equivalent, because upstream talks to one
//! provider whose error vocabulary its own classifier already knows.
//!
//! # Why this exists at all
//!
//! The engine's typed retry classification is calibrated to OpenAI's errors,
//! and it lands every gateway-specific code in the wrong bucket. Two of those
//! are actively harmful rather than merely wrong:
//!
//! - **`402 cap_exceeded` would be auto-retried.** The gateway returns `402`
//!   for a filled spend cap *specifically because* stock SDKs auto-retry `429`
//!   with backoff, and a monthly cap answering `429` puts every capped agent
//!   into a retry loop against a wall it cannot clear for up to three weeks.
//!   Anything here that retries a `402` reintroduces exactly the loop the
//!   gateway's status choice was made to prevent.
//! - **`429 rate_limited` would be abandoned instantly, and its `Retry-After`
//!   ignored** — the one case where waiting is not only safe but instructed.
//!
//! # Branch on `code`, never on `message`
//!
//! The gateway says so, and it is right: messages are diagnostic and change.
//! One status carries several meanings that need opposite handling — `401` is
//! either "re-authenticate" or "refresh once", and `403` is three different
//! terminal reasons — so the status alone is not enough either.

use std::time::Duration;

use http::StatusCode;
use serde::Deserialize;

use crate::error::ApiError;

/// What the client should do about a gateway error.
///
/// Deliberately not `bool`-shaped. "Retryable" collapses three behaviours the
/// gateway keeps distinct: wait a stated interval, refresh a credential and
/// try once, or stop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// Stop. Nothing about retrying this makes it succeed.
    Terminal { message: String },
    /// The access token expired mid-session. Mint a new one and retry **once**.
    ///
    /// On the streaming path this variant is a *label*, not the mechanism: the
    /// dialect intercepts a `401` before the error is ever classified and runs
    /// the engine's own `UnauthorizedRecovery`, which is what asks the D10 token
    /// provider for a fresh token and retries exactly once. The variant carries
    /// the distinction for the unary calls that have no such interception,
    /// where "retryable" is what lets the auth provider re-resolve on the next
    /// attempt. Keeping the two `401`s apart is the point either way — the
    /// other one must not be retried at all.
    RefreshAuthThenRetryOnce { message: String },
    /// Wait, then retry. The delay is the gateway's, not ours.
    RetryAfter { message: String, delay: Duration },
    /// An upstream failure that may not recur. Retry, bounded.
    RetryCautiously { message: String },
}

/// The gateway's error envelope. OpenAI's shape plus Atlas's detail.
#[derive(Debug, Default, Deserialize)]
struct GatewayEnvelope {
    error: Option<GatewayError>,
}

#[derive(Debug, Default, Deserialize)]
struct GatewayError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: Option<String>,
    // `402` only. Carried so the user is told which ceiling tripped and when it
    // rolls over — without those a cap error is "you cannot work" with no
    // answer to "until when".
    #[serde(default)]
    window: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    used: Option<u64>,
    #[serde(default)]
    cap: Option<u64>,
    #[serde(default)]
    reset: Option<String>,
}

/// `Retry-After`, in seconds.
///
/// The gateway sets `1` for a concurrency refusal and `60` for the per-minute
/// limit. Absent or unparseable falls back to 60: the longer of the two, since
/// retrying too soon against a rate limit earns another one.
///
/// Clamped at 60 either way (#68): the value is slept verbatim downstream,
/// and a *parseable* absurd one — `Retry-After: 86400` from an intervening
/// CDN or WAF, whose 429 reaches this arm because `classify` falls back
/// gracefully on a non-envelope body — would stall the turn for hours behind
/// "Reconnecting…". 60 is the longest interval the gateway documents, and the
/// same bound the connection-retry branch already enforces; a source that
/// really wants a longer wait will answer the retry with another 429.
fn retry_after(header: Option<&str>) -> Duration {
    const LONGEST_DOCUMENTED: Duration = Duration::from_secs(60);
    header
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(LONGEST_DOCUMENTED)
        .min(LONGEST_DOCUMENTED)
}

fn cap_detail(err: &GatewayError) -> String {
    let mut detail = if err.message.is_empty() {
        "The AI budget for this account is spent.".to_string()
    } else {
        err.message.clone()
    };
    if let (Some(used), Some(cap)) = (err.used, err.cap) {
        detail.push_str(&format!(" Used {used} of {cap}"));
        if let Some(window) = &err.window {
            detail.push_str(&format!(" for the {window} window"));
        }
        // Whose ceiling: "org" | "personal" | "member". Without it a shared
        // cap reads as the user's own, and they go looking for a personal
        // setting that will not fix it.
        if let Some(scope) = &err.scope {
            detail.push_str(&format!(" ({scope})"));
        }
        detail.push('.');
    } else if let Some(window) = &err.window {
        detail.push_str(&format!(" The {window} window is full."));
    }
    if let Some(reset) = &err.reset {
        detail.push_str(&format!(" Resets {reset}."));
    }
    detail
}

/// Classifies one gateway error response.
///
/// `body` is the raw response body; a body that is not the expected envelope is
/// not an error here — the status still decides, and a gateway that changed its
/// shape should not become an unclassified retry.
pub fn classify(status: StatusCode, body: &str, retry_after_header: Option<&str>) -> Disposition {
    let err = serde_json::from_str::<GatewayEnvelope>(body)
        .ok()
        .and_then(|e| e.error)
        .unwrap_or_default();
    let code = err.code.as_deref().unwrap_or_default();
    let message = if err.message.is_empty() {
        format!("the gateway returned {status}")
    } else {
        err.message.clone()
    };

    match (status.as_u16(), code) {
        // Stop and tell the user. Never a retry — see the module docs.
        (402, _) => Disposition::Terminal {
            message: cap_detail(&err),
        },

        // The one auth case that is not terminal. Refresh once, then retry;
        // the D10 token provider is what performs the refresh.
        (401, "token_expired") => Disposition::RefreshAuthThenRetryOnce { message },
        // Missing, malformed or unverifiable. Backing off would not help, and
        // the gateway says explicitly not to.
        (401, _) => Disposition::Terminal { message },

        // Back off and retry — the only status where waiting is instructed.
        (429, _) => Disposition::RetryAfter {
            message,
            delay: retry_after(retry_after_header),
        },

        // Atlas's own backstop. "Atlas is broken, not you" — not a
        // client-fixable condition, so retrying only adds load to something
        // already failing.
        (503, _) => Disposition::Terminal {
            message: if err.message.is_empty() {
                "Atlas is temporarily unavailable. This is not something you did.".to_string()
            } else {
                message
            },
        },

        // Upstream failed, or the gateway refused its own call. May not recur.
        (502, _) => Disposition::RetryCautiously { message },

        // Everything else the gateway defines is terminal: 400 (bad request),
        // 403 (no grant / wrong org / model not allowed), 404, 405, 413, 501.
        //
        // 413 deserves compaction rather than a retry, and gets none here —
        // resending the same oversized prompt would fail identically.
        _ => Disposition::Terminal { message },
    }
}

/// Classifies the gateway's **in-stream** `{"error":…}` frame.
///
/// A mid-stream failure carries no status of its own — the response was already
/// a `200` when the stream opened — so the frame's `code` is the only thing
/// that names it. The gateway documents this case as travelling "the same
/// `502`-frame-and-withhold-`[DONE]` path as any other provider failure", and
/// that is the default here.
///
/// The codes listed below are read back to the status they belong to instead.
/// None of them can reach a stream in the gateway as documented — a filled cap
/// is refused before the provider is called — but the failure of guessing wrong
/// is asymmetric: treating a terminal condition as a cautious retry is the
/// retry storm this whole file exists to stop, while treating a provider blip
/// as terminal costs one turn.
pub fn classify_stream_frame(frame: &str) -> Disposition {
    let code = serde_json::from_str::<GatewayEnvelope>(frame)
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| error.code)
        .unwrap_or_default();
    let status = match code.as_str() {
        "cap_exceeded" => StatusCode::PAYMENT_REQUIRED,
        "token_expired" | "unauthorized" => StatusCode::UNAUTHORIZED,
        "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
        "no_entitlement" | "org_not_covered" | "model_not_allowed" => StatusCode::FORBIDDEN,
        "request_too_large" | "prompt_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        "atlas_backstop_tripped" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_GATEWAY,
    };
    classify(status, frame, None)
}

impl Disposition {
    /// Whether the engine should try this request again.
    ///
    /// The property the acceptance bar checks: a `402` must produce **zero**
    /// automatic re-requests.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RetryAfter { .. } | Self::RetryCautiously { .. } | Self::RefreshAuthThenRetryOnce { .. }
        )
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Terminal { message }
            | Self::RefreshAuthThenRetryOnce { message }
            | Self::RetryAfter { message, .. }
            | Self::RetryCautiously { message } => message,
        }
    }

    /// The engine's own error type.
    pub fn into_api_error(self) -> ApiError {
        match self {
            // `InvalidRequest`, not `Api { status }`, and the difference is the
            // whole point of this file: `ApiError::Api` becomes
            // `CodexErr::UnexpectedStatus`, which the turn loop treats as
            // **retryable** — so a "terminal" disposition would still have been
            // retried five times. `InvalidRequest` is the non-retryable variant
            // that keeps its message, and the message is where the cap detail
            // lives. Pinned by `a_terminal_disposition_is_not_retryable_once_it_is_an_engine_error`.
            Self::Terminal { message } => ApiError::InvalidRequest { message },
            Self::RefreshAuthThenRetryOnce { message } | Self::RetryCautiously { message } => {
                ApiError::Retryable {
                    message,
                    delay: None,
                }
            }
            Self::RetryAfter { message, delay } => ApiError::Retryable {
                message,
                delay: Some(delay),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(code: &str, message: &str) -> String {
        format!(r#"{{"error":{{"message":"{message}","code":"{code}"}}}}"#)
    }

    fn classify_code(status: u16, code: &str) -> Disposition {
        let Ok(status) = StatusCode::from_u16(status) else {
            panic!("{status} is not a status code");
        };
        classify(status, &body(code, "something happened"), None)
    }

    #[test]
    fn a_filled_cap_never_retries() {
        // The single most important line in this file. The gateway returns 402
        // rather than 429 *because* stock SDKs auto-retry 429, and a monthly
        // cap answering 429 loops a capped agent against a wall for up to
        // three weeks. Retrying here reintroduces exactly that.
        let d = classify_code(402, "cap_exceeded");
        assert!(!d.is_retryable(), "a filled cap must produce zero retries");
        assert!(matches!(d, Disposition::Terminal { .. }));
    }

    #[test]
    fn a_cap_error_tells_the_user_which_ceiling_and_when_it_resets() {
        // Without these a cap error is "you cannot work" with no answer to
        // "until when", which is the difference between a wall and a wait.
        let body = r#"{"error":{"message":"The org monthly AI budget is spent.",
            "code":"cap_exceeded","window":"monthly","scope":"org",
            "used":307425,"cap":350000,"reset":"2026-09-01T00:00:00.000Z"}}"#;
        let d = classify(StatusCode::PAYMENT_REQUIRED, body, None);
        let m = d.message();
        assert!(m.contains("307425"), "used missing: {m}");
        assert!(m.contains("350000"), "cap missing: {m}");
        assert!(m.contains("monthly"), "window missing: {m}");
        assert!(m.contains("org"), "scope missing — a shared cap must not read as personal: {m}");
        assert!(m.contains("2026-09-01"), "reset missing: {m}");
    }

    #[test]
    fn a_rate_limit_waits_the_interval_the_gateway_stated() {
        // The gateway sets 1 for a concurrency refusal and 60 for the
        // per-minute limit. Ignoring the header is how a client turns a
        // one-second wait into a minute, or a minute into a hammering.
        let d = classify(StatusCode::TOO_MANY_REQUESTS, &body("rate_limited", "slow down"), Some("1"));
        assert_eq!(
            d,
            Disposition::RetryAfter {
                message: "slow down".to_string(),
                delay: Duration::from_secs(1),
            },
        );
        assert!(d.is_retryable());

        let d = classify(StatusCode::TOO_MANY_REQUESTS, &body("rate_limited", "slow down"), Some("60"));
        assert!(matches!(d, Disposition::RetryAfter { delay, .. } if delay == Duration::from_secs(60)));
    }

    #[test]
    fn a_missing_retry_after_waits_the_longer_interval() {
        // Retrying too soon against a rate limit earns another one, so the
        // fallback is the longer of the two the gateway uses.
        let d = classify(StatusCode::TOO_MANY_REQUESTS, &body("rate_limited", "x"), None);
        assert!(matches!(d, Disposition::RetryAfter { delay, .. } if delay == Duration::from_secs(60)));
        let d = classify(StatusCode::TOO_MANY_REQUESTS, &body("rate_limited", "x"), Some("garbage"));
        assert!(matches!(d, Disposition::RetryAfter { delay, .. } if delay == Duration::from_secs(60)));
    }

    #[test]
    fn an_absurd_retry_after_is_clamped_rather_than_slept() {
        // A parseable value is honoured downstream verbatim, so a CDN's
        // `Retry-After: 86400` would stall the turn for a day behind
        // "Reconnecting…" (#68). 60 is the longest interval the gateway
        // documents; nothing may wait longer on this header's say-so.
        let d = classify(StatusCode::TOO_MANY_REQUESTS, &body("rate_limited", "x"), Some("86400"));
        assert!(matches!(d, Disposition::RetryAfter { delay, .. } if delay == Duration::from_secs(60)));
        // The documented short interval still passes through untouched.
        let d = classify(StatusCode::TOO_MANY_REQUESTS, &body("rate_limited", "x"), Some("1"));
        assert!(matches!(d, Disposition::RetryAfter { delay, .. } if delay == Duration::from_secs(1)));
    }

    #[test]
    fn the_two_kinds_of_401_are_not_the_same_error() {
        // An expired token is the normal end of a long session and recovers by
        // minting a new one. An unverifiable one does not, and the gateway says
        // explicitly not to back off and retry it.
        let expired = classify_code(401, "token_expired");
        assert!(matches!(expired, Disposition::RefreshAuthThenRetryOnce { .. }));
        assert!(expired.is_retryable());

        let unauthorized = classify_code(401, "unauthorized");
        assert!(matches!(unauthorized, Disposition::Terminal { .. }));
        assert!(!unauthorized.is_retryable());
    }

    #[test]
    fn every_403_is_terminal_because_none_of_them_change_by_asking_again() {
        for code in ["no_entitlement", "org_not_covered", "model_not_allowed"] {
            let d = classify_code(403, code);
            assert!(!d.is_retryable(), "{code} must not retry");
        }
    }

    #[test]
    fn an_oversized_prompt_is_terminal_rather_than_retried() {
        // Resending the same body fails identically. The right answer is
        // compaction, which is a turn-level decision and not this layer's.
        for code in ["request_too_large", "prompt_too_large"] {
            assert!(!classify_code(413, code).is_retryable(), "{code}");
        }
    }

    #[test]
    fn atlas_own_backstop_stops_rather_than_adding_load() {
        // "Atlas is broken, not you." Retrying only adds load to something
        // that is already failing, and the user cannot fix it either way.
        let d = classify_code(503, "atlas_backstop_tripped");
        assert!(!d.is_retryable());
        let quiet = classify(StatusCode::SERVICE_UNAVAILABLE, "{}", None);
        assert!(
            quiet.message().contains("not something you did"),
            "a backstop with no message should still not read as the user's fault: {}",
            quiet.message(),
        );
    }

    #[test]
    fn an_upstream_failure_is_retried_cautiously() {
        let d = classify_code(502, "provider_error");
        assert!(matches!(d, Disposition::RetryCautiously { .. }));
        assert!(d.is_retryable());
    }

    #[test]
    fn a_bad_request_is_terminal() {
        for code in ["unknown_parameter", "invalid_parameter"] {
            assert!(!classify_code(400, code).is_retryable(), "{code}");
        }
    }

    #[test]
    fn every_code_the_gateway_defines_is_classified() {
        // The classification-table test the acceptance criteria asks for: every
        // status/code pair in the gateway's error reference, and what each one
        // must do. A pair missing from here is a pair the engine handles by
        // accident.
        let table: &[(u16, &str, bool)] = &[
            (400, "unknown_parameter", false),
            (400, "invalid_parameter", false),
            (401, "unauthorized", false),
            (401, "token_expired", true),
            (402, "cap_exceeded", false),
            (403, "no_entitlement", false),
            (403, "org_not_covered", false),
            (403, "model_not_allowed", false),
            (404, "not_found", false),
            (404, "unknown_feature", false),
            (405, "method_not_allowed", false),
            (413, "request_too_large", false),
            (413, "prompt_too_large", false),
            (429, "rate_limited", true),
            (501, "not_implemented", false),
            (502, "provider_error", true),
            (503, "atlas_backstop_tripped", false),
        ];
        for (status, code, retryable) in table {
            let d = classify_code(*status, code);
            assert_eq!(
                d.is_retryable(),
                *retryable,
                "{status} {code} classified wrong: {d:?}",
            );
            assert!(!d.message().is_empty(), "{status} {code} has no message");
        }
    }

    #[test]
    fn a_body_that_is_not_the_expected_envelope_still_classifies_by_status() {
        // A gateway that changed its error shape must not become an
        // unclassified retry — least of all on a 402.
        let d = classify(StatusCode::PAYMENT_REQUIRED, "<html>gateway</html>", None);
        assert!(!d.is_retryable());
        let d = classify(StatusCode::TOO_MANY_REQUESTS, "", Some("1"));
        assert!(d.is_retryable());
    }

    #[test]
    fn a_terminal_disposition_is_not_retryable_once_it_is_an_engine_error() {
        // The bug this catches shipped in the first cut of this file, and every
        // test above passed while it was there: `Disposition::is_retryable`
        // said false, `into_api_error` produced `ApiError::Api { status }`, and
        // the bridge turns that into `CodexErr::UnexpectedStatus` — which the
        // turn loop retries. A 402 was still being re-sent five times.
        //
        // So the assertion has to run the whole way through the bridge. Asking
        // the disposition alone is what missed it.
        for (status, code) in [
            (402, "cap_exceeded"),
            (401, "unauthorized"),
            (403, "no_entitlement"),
            (413, "prompt_too_large"),
            (503, "atlas_backstop_tripped"),
            (400, "invalid_parameter"),
        ] {
            let engine_error = crate::map_api_error(classify_code(status, code).into_api_error());
            assert!(
                !engine_error.is_retryable(),
                "{status} {code} is still retryable after the bridge: {engine_error:?}",
            );
        }
    }

    #[test]
    fn a_cap_error_keeps_its_detail_all_the_way_through_the_bridge() {
        // Non-retryable is not enough on its own: the variant also has to be
        // one that carries a message, or the user is told nothing but "error".
        let body = r#"{"error":{"message":"The org monthly AI budget is spent.",
            "code":"cap_exceeded","window":"monthly","scope":"org",
            "used":307425,"cap":350000,"reset":"2026-09-01T00:00:00.000Z"}}"#;
        let engine_error =
            crate::map_api_error(classify(StatusCode::PAYMENT_REQUIRED, body, None).into_api_error());
        let rendered = engine_error.to_string();
        assert!(rendered.contains("307425"), "cap detail lost: {rendered}");
        assert!(rendered.contains("2026-09-01"), "reset lost: {rendered}");
    }

    #[test]
    fn a_retryable_disposition_stays_retryable_through_the_bridge() {
        // The other direction, so the fix above cannot be "make everything
        // terminal".
        for (status, code) in [(429, "rate_limited"), (502, "provider_error")] {
            let engine_error = crate::map_api_error(classify_code(status, code).into_api_error());
            assert!(
                engine_error.is_retryable(),
                "{status} {code} should be retried: {engine_error:?}",
            );
        }
    }

    #[test]
    fn an_in_stream_error_frame_is_the_gateways_own_502_path() {
        // A mid-stream failure has no status of its own; the gateway documents
        // it as the same 502-frame-and-withhold-[DONE] path. Cautious retry,
        // and the frame's own message rather than a generic one.
        let frame = r#"{"error":{"type":"provider_error","code":"provider_error","message":"upstream hung up"}}"#;
        let d = classify_stream_frame(frame);
        assert!(matches!(d, Disposition::RetryCautiously { .. }));
        assert_eq!(d.message(), "upstream hung up");
    }

    #[test]
    fn an_in_stream_frame_carrying_a_terminal_code_is_still_terminal() {
        // The frame is classified by its code first, so a cap that somehow
        // surfaced mid-stream does not become a retry because of where it
        // arrived.
        let frame = r#"{"error":{"code":"cap_exceeded","message":"budget spent"}}"#;
        let d = classify_stream_frame(frame);
        assert!(
            !d.is_retryable(),
            "a cap must not become retryable by arriving mid-stream: {d:?}",
        );
    }
}
