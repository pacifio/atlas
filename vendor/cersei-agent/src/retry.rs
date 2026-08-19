//! ATLAS PATCH (retry-classified-v1): provider-error classification and
//! backoff schedule for the runner's model-call attempt loop.
//!
//! Mirrors Zed's native-agent retry table (`retry_strategy_for`):
//! - HTTP 429 / rate limit          → server's `retry-after` when stated,
//!   else exponential 5s·2^(n-1); max 4 attempts
//! - 529/503/overloaded             → fixed `retry_after` (or 5s), max 4
//! - other 5xx / stream/read errors → fixed 5s, max 3
//! - auth (401/403/…) and fatal (400/413/too-large/…) → never retried
//! - anything unrecognized          → never retried (conservative: a genuine
//!   model/tool error must not be replayed on a timer)
//!
//! Classification is by message substring because both failure surfaces
//! deliver strings: `provider.complete()` errors stringify `CerseiError`, and
//! mid-stream failures arrive as `StreamEvent::Error { message }` formatted
//! `"HTTP {status}: {body}"` by the provider's SSE task.

use std::time::Duration;

/// How to space retries for one class of error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backoff {
    /// `base · 2^(attempt-1)` — rate limits.
    Exponential { base_secs: u64 },
    /// Same delay every time — overloads / transient 5xx.
    Fixed { secs: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetrySchedule {
    pub max_attempts: u32,
    pub backoff: Backoff,
}

impl RetrySchedule {
    /// Delay before retry number `attempt` (1-based).
    pub fn delay(&self, attempt: u32) -> Duration {
        match self.backoff {
            Backoff::Exponential { base_secs } => {
                Duration::from_secs(base_secs.saturating_mul(1u64 << (attempt.saturating_sub(1)).min(6)))
            }
            Backoff::Fixed { secs } => Duration::from_secs(secs),
        }
    }
}

/// Decide whether (and how) to retry a failed model call. `None` = surface
/// the error; the turn fails.
pub fn schedule_for(message: &str) -> Option<RetrySchedule> {
    let m = message.to_ascii_lowercase();

    // Auth / fatal first — these can match generic tokens below (e.g. a 401
    // body mentioning "request"), so they short-circuit.
    const NEVER: &[&str] = &[
        "http 401",
        "http 403",
        "authentication",
        "unauthorized",
        "invalid x-api-key",
        "invalid api key",
        "api key not",
        "permission_error",
        "http 400",
        "invalid_request",
        "http 413",
        "prompt is too long",
        "too large",
        "credit balance is too low",
        "billing",
    ];
    if NEVER.iter().any(|t| m.contains(t)) {
        return None;
    }

    if m.contains("http 429") || m.contains("rate limit") || m.contains("rate_limit") {
        // ATLAS PATCH (retry-after-v1): honor a server-stated retry-after
        // over the exponential guess — the provider folds the Retry-After
        // header into the error string as "(retry-after: Ns)" (see
        // cersei-provider `retry_after_suffix`).
        return Some(match retry_after_secs(&m) {
            Some(secs) => RetrySchedule {
                max_attempts: 4,
                backoff: Backoff::Fixed { secs },
            },
            None => RetrySchedule {
                max_attempts: 4,
                backoff: Backoff::Exponential { base_secs: 5 },
            },
        });
    }

    if m.contains("http 529")
        || m.contains("http 503")
        || m.contains("overloaded")
        || m.contains("service unavailable")
    {
        return Some(RetrySchedule {
            max_attempts: 4,
            backoff: Backoff::Fixed {
                secs: retry_after_secs(&m).unwrap_or(5),
            },
        });
    }

    const TRANSIENT: &[&str] = &[
        "http 500",
        "http 502",
        "http 504",
        "internal server error",
        "bad gateway",
        "connection refused",
        "connection reset",
        "connection closed",
        "reset by peer",
        "timed out",
        "timeout",
        "error sending request",
        "error decoding",
        "failed to decode response",
        "stream ended",
        "unexpected eof",
        "dns error",
    ];
    if TRANSIENT.iter().any(|t| m.contains(t)) {
        return Some(RetrySchedule {
            max_attempts: 3,
            backoff: Backoff::Fixed { secs: 5 },
        });
    }

    None
}

/// Best-effort `retry_after` extraction from an error body (seconds).
fn retry_after_secs(lower_msg: &str) -> Option<u64> {
    let idx = lower_msg
        .find("retry_after")
        .or_else(|| lower_msg.find("retry-after"))?;
    let tail = &lower_msg[idx..];
    let digits: String = tail
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let secs: u64 = digits.parse().ok()?;
    // Clamp: a server asking for an hour is treated as "a while", not a hang.
    Some(secs.clamp(1, 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_driven_classification() {
        // (message, expected max_attempts or None)
        let cases: &[(&str, Option<u32>)] = &[
            // rate limits → exponential, 4
            ("HTTP 429: {\"error\":{\"type\":\"rate_limit_error\"}}", Some(4)),
            ("Provider error: rate limit exceeded", Some(4)),
            // overload → fixed, 4
            ("HTTP 529: overloaded_error", Some(4)),
            ("HTTP 503: Service Unavailable", Some(4)),
            ("the model is overloaded, try again", Some(4)),
            // transient 5xx / stream → fixed, 3
            ("HTTP 500: internal server error", Some(3)),
            ("HTTP 502: bad gateway", Some(3)),
            ("error sending request for url", Some(3)),
            ("connection reset by peer", Some(3)),
            ("request timed out", Some(3)),
            ("failed to decode response: missing field", Some(3)),
            // auth → never
            ("HTTP 401: authentication_error", None),
            ("HTTP 403: permission_error", None),
            ("invalid x-api-key", None),
            // fatal → never
            ("HTTP 400: invalid_request_error", None),
            ("HTTP 413: prompt is too long", None),
            ("your credit balance is too low", None),
            // unknown → never (conservative)
            ("something odd happened", None),
            // auth wins over transient tokens in the same body
            ("HTTP 401: authentication_error while error sending request", None),
        ];
        for (msg, want) in cases {
            let got = schedule_for(msg).map(|s| s.max_attempts);
            assert_eq!(got, *want, "classification for {msg:?}");
        }
    }

    #[test]
    fn exponential_delays_double_from_five_seconds() {
        let s = schedule_for("HTTP 429: nope").unwrap();
        assert_eq!(s.delay(1), Duration::from_secs(5));
        assert_eq!(s.delay(2), Duration::from_secs(10));
        assert_eq!(s.delay(3), Duration::from_secs(20));
    }

    #[test]
    fn rate_limit_honors_retry_after_header() {
        // The provider folds the Retry-After header in as "(retry-after: Ns)".
        let s = schedule_for("HTTP 429 (retry-after: 17s): rate_limit_error").unwrap();
        assert_eq!(s.delay(1), Duration::from_secs(17));
        assert_eq!(s.delay(3), Duration::from_secs(17), "fixed, not exponential");
        // A body-side retry_after works the same way.
        let s = schedule_for("HTTP 429: {\"retry_after\": 8}").unwrap();
        assert_eq!(s.delay(1), Duration::from_secs(8));
        // An absurd server ask is clamped, not obeyed.
        let s = schedule_for("HTTP 429 (retry-after: 3600s): slow down").unwrap();
        assert_eq!(s.delay(1), Duration::from_secs(60));
    }

    #[test]
    fn overload_honors_retry_after() {
        let s = schedule_for("HTTP 529: {\"retry_after\": 12}").unwrap();
        assert_eq!(s.delay(1), Duration::from_secs(12));
        assert_eq!(s.delay(3), Duration::from_secs(12), "fixed backoff");
        // absent → 5s default
        let s = schedule_for("HTTP 529: overloaded").unwrap();
        assert_eq!(s.delay(1), Duration::from_secs(5));
    }
}
