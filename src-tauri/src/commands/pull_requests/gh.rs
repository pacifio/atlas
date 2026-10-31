//! The transport under the pull-request surface: every GitHub request it
//! makes is one `gh api -i …` process, under the user's own `gh` login.
//!
//! Atlas never holds a token. `gh` signs the request and picks the host from
//! the checkout's remote; this module only shapes the request, bounds the
//! process (a timeout, a shared permit pool) and reads the answer back. `-i`
//! makes `gh` print the status line and headers before the body, on success
//! and failure alike, so the answer is read here as an HTTP response — which
//! is what lets a refusal be told apart (rate limit, not found, refused
//! credential) and lets an ETag be revalidated.
//!
//! Three policies ride on that, each mirroring a GitHub rule:
//!
//! - **Rate limits.** [`is_rate_limited`] reads a refusal the way GitHub
//!   documents it (a 429, an exhausted quota, a secondary-limit 403, or a
//!   GraphQL `RATE_LIMITED` with HTTP 200). A refusal pauses that quota until
//!   the time GitHub named, or a doubling cool-down when it named none, and a
//!   background read stops while less than a tenth of a quota is left so that
//!   what the user does next still has room.
//! - **Conditional reads.** A REST read can revalidate its last answer with
//!   `If-None-Match`; GitHub answers an unchanged resource with a 304, which
//!   costs no quota, and the cached body is reused.
//! - **Concurrency.** [`PR_PERMITS`] bounds how many `gh` run at once for
//!   the API; images have their own [`IMAGE_PERMITS`], so a page of avatars
//!   never queues ahead of the reads the user is waiting on.

use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use super::model::PrError;

/// How many `gh` processes the pull-request surface runs at once. Opening a
/// pull request reads four things side by side (detail, activity, the first
/// page of files, viewed state); the two permits the sidebar's badges share
/// (`git_pr::GH_PERMITS`) would queue those behind each other and behind every
/// badge. GitHub's secondary limits punish bursts of concurrent requests, so
/// this stays a small pool of its own rather than an open door: four here plus
/// the badges' two is still under the eight concurrent requests GitHub treats
/// as polite, and each permit is a whole process, not a pooled connection.
pub(crate) static PR_PERMITS: Semaphore = Semaphore::const_new(4);

/// How many image fetches run at once. A comment thread can name dozens of
/// avatars and screenshots; they wait on each other here rather than on the
/// detail, activity and diff reads behind [`PR_PERMITS`]. They are not API
/// requests, so GitHub's concurrency guidance for the API does not count them.
pub(crate) static IMAGE_PERMITS: Semaphore = Semaphore::const_new(3);

/// The permit pool a request of `resource` waits in.
pub(crate) fn permits_for(resource: Resource) -> &'static Semaphore {
    match resource {
        Resource::Unmetered => &IMAGE_PERMITS,
        Resource::Core | Resource::Graphql => &PR_PERMITS,
    }
}

/// A read the user is waiting on. Longer than the sidebar's five seconds: a
/// detail read is one large GraphQL document.
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(20);
/// A page of a large diff, or a whole file.
pub(crate) const DIFF_TIMEOUT: Duration = Duration::from_secs(60);
/// A write; GitHub can take a while to merge.
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// Past this a response is refused rather than read: a large pull request's
/// page of files can run to megabytes, but nothing honest needs more.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// `gh`'s documented exit code for "authentication required".
const GH_EXIT_AUTH_REQUIRED: i32 = 4;

/// The quota a request spends, as GitHub's `x-ratelimit-resource` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Resource {
    /// REST.
    Core,
    /// GraphQL.
    Graphql,
    /// Not the API at all (an image host): no quota to keep.
    Unmetered,
}

impl Resource {
    fn key(self) -> &'static str {
        match self {
            Resource::Core => "core",
            Resource::Graphql => "graphql",
            Resource::Unmetered => "",
        }
    }
}

/// One answer, as `gh api -i` printed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpResponse {
    pub status: u16,
    /// Lowercased names; a repeated header keeps its last value.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// How one `gh` process ended, before anything is decided about it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunOutcome {
    /// `gh` reached GitHub and printed an answer (any status).
    Http(HttpResponse),
    /// `gh` exited without an HTTP answer: offline, not signed in, not a
    /// GitHub checkout. Its exit code and stderr say which.
    NoResponse { exit: Option<i32>, stderr: String },
    /// The binary could not be started.
    Missing,
    /// It ran past its timeout and was killed.
    TimedOut,
}

/// Parse `gh api -i` output: a status line, headers, a blank line, the body.
/// Redirects that `gh` followed may leave an earlier block in front; the last
/// block whose status is not a redirect or `100 Continue` is the answer.
pub(crate) fn parse_http(raw: &[u8]) -> Option<HttpResponse> {
    let mut rest = raw;
    loop {
        if !rest.starts_with(b"HTTP/") {
            return None;
        }
        let (head, body) = split_head(rest)?;
        let head = std::str::from_utf8(head).ok()?;
        let mut lines = head.lines();
        let status_line = lines.next()?;
        let status: u16 = status_line.split_whitespace().nth(1)?.parse().ok()?;
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        if (status == 100 || (300..400).contains(&status) && status != 304)
            && body.starts_with(b"HTTP/")
        {
            rest = body;
            continue;
        }
        return Some(HttpResponse {
            status,
            headers,
            body: body.to_vec(),
        });
    }
}

/// The header block and what follows its blank line.
fn split_head(raw: &[u8]) -> Option<(&[u8], &[u8])> {
    if let Some(at) = find(raw, b"\r\n\r\n") {
        return Some((&raw[..at], &raw[at + 4..]));
    }
    if let Some(at) = find(raw, b"\n\n") {
        return Some((&raw[..at], &raw[at + 2..]));
    }
    // Headers with no body at all (a 204 or 304 at the very end).
    Some((raw, &[]))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// One `gh` invocation.
#[derive(Debug, Clone)]
pub(crate) struct GhCall {
    pub args: Vec<String>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
}

/// Run `program` with `call` in `cwd`. Async process handling: the child is
/// killed on drop, so the timeout dropping the future is the kill.
pub(crate) async fn run(program: &OsStr, cwd: &str, call: &GhCall) -> RunOutcome {
    // A directory that is gone (a removed worktree) fails the spawn with the
    // same NotFound as a missing binary; it must not read as "no `gh`".
    if !std::path::Path::new(cwd).is_dir() {
        return RunOutcome::NoResponse {
            exit: None,
            stderr: "not a git repository".into(),
        };
    }
    let mut cmd = atlas_process::async_command(program);
    cmd.args(&call.args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GH_PAGER", "")
        .stdin(if call.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RunOutcome::Missing,
        Err(e) => {
            return RunOutcome::NoResponse {
                exit: None,
                stderr: e.to_string(),
            }
        }
    };
    let stdin = child.stdin.take();
    let input = call.stdin.clone();
    let work = async move {
        if let (Some(mut pipe), Some(bytes)) = (stdin, input) {
            // A child that exits early closes the pipe; its own answer says why.
            let _ = pipe.write_all(&bytes).await;
            drop(pipe);
        }
        child.wait_with_output().await
    };
    let output = match tokio::time::timeout(call.timeout, work).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return RunOutcome::NoResponse {
                exit: None,
                stderr: e.to_string(),
            }
        }
        Err(_) => return RunOutcome::TimedOut,
    };
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return RunOutcome::NoResponse {
            exit: output.status.code(),
            stderr: "response too large".into(),
        };
    }
    match parse_http(&output.stdout) {
        Some(response) => RunOutcome::Http(response),
        None => RunOutcome::NoResponse {
            exit: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
    }
}

// ── rate limits ──────────────────────────────────────────────────────────

/// What remains of a quota is read from every answer; under a tenth of it a
/// background read waits for the reset, so the user's own reads and writes
/// are never the ones refused.
const RESERVE_RATIO: f64 = 0.1;
/// A refusal that names no reset pauses for this long, doubling per repeat.
const FALLBACK_COOLDOWN_MS: i64 = 30_000;
const MAX_FALLBACK_COOLDOWN_MS: i64 = 15 * 60_000;

#[derive(Debug, Clone, Copy)]
struct Quota {
    limit: f64,
    remaining: f64,
    reset_at_ms: i64,
}

#[derive(Debug, Default)]
struct Limits {
    quotas: HashMap<&'static str, Quota>,
    /// Paused until (epoch ms), and how many refusals in a row led here.
    paused: HashMap<&'static str, (i64, u32)>,
}

static LIMITS: LazyLock<Mutex<Limits>> = LazyLock::new(|| Mutex::new(Limits::default()));

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Refuse up front while the quota is paused, or (for a background read)
/// while it is down to its reserve.
fn admit(resource: Resource, allow_reserve: bool, now: i64) -> Result<(), PrError> {
    if resource == Resource::Unmetered {
        return Ok(());
    }
    let limits = LIMITS.lock();
    if let Some(&(until, _)) = limits.paused.get(resource.key()) {
        if until > now {
            return Err(PrError::RateLimited {
                retry_at: Some(until),
            });
        }
    }
    if let Some(quota) = limits.quotas.get(resource.key()) {
        if quota.reset_at_ms > now {
            let floor = if allow_reserve {
                1.0
            } else {
                quota.limit * RESERVE_RATIO
            };
            if quota.remaining < floor {
                return Err(PrError::RateLimited {
                    retry_at: Some(quota.reset_at_ms),
                });
            }
        }
    }
    Ok(())
}

/// Note what an answer says about its quota. A later answer from another
/// region can report more left in the same window; an older window never
/// overwrites a newer one.
fn observe(headers: &HashMap<String, String>) {
    let Some(resource) = headers.get("x-ratelimit-resource").map(String::as_str) else {
        return;
    };
    let key = match resource {
        "core" => "core",
        "graphql" => "graphql",
        _ => return,
    };
    let num = |name: &str| headers.get(name).and_then(|v| v.trim().parse::<f64>().ok());
    let (Some(limit), Some(remaining), Some(reset)) = (
        num("x-ratelimit-limit"),
        num("x-ratelimit-remaining"),
        num("x-ratelimit-reset"),
    ) else {
        return;
    };
    if limit <= 0.0 || remaining < 0.0 {
        return;
    }
    let reset_at_ms = (reset * 1000.0) as i64;
    let mut limits = LIMITS.lock();
    if let Some(previous) = limits.quotas.get(key) {
        if reset_at_ms < previous.reset_at_ms {
            return;
        }
    }
    limits.quotas.insert(
        key,
        Quota {
            limit,
            remaining,
            reset_at_ms,
        },
    );
}

fn record_rate_limit(resource: Resource, retry_at: Option<i64>, now: i64) -> i64 {
    let key = match resource {
        Resource::Unmetered => "core",
        other => other.key(),
    };
    let mut limits = LIMITS.lock();
    let attempt = limits.paused.get(key).map(|&(_, n)| n + 1).unwrap_or(1);
    let until = retry_at.unwrap_or_else(|| {
        now + (FALLBACK_COOLDOWN_MS * 2_i64.pow(attempt.saturating_sub(1).min(10)))
            .min(MAX_FALLBACK_COOLDOWN_MS)
    });
    limits.paused.insert(key, (until, attempt));
    until
}

/// Until when GitHub itself paused a quota (epoch ms), if it has: a refusal
/// it sent, as opposed to a read held back at the reserve.
pub(crate) fn quota_paused_until(now: i64) -> Option<i64> {
    LIMITS
        .lock()
        .paused
        .values()
        .map(|&(until, _)| until)
        .filter(|until| *until > now)
        .max()
}

fn record_success(resource: Resource) {
    if resource == Resource::Unmetered {
        return;
    }
    LIMITS.lock().paused.remove(resource.key());
}

/// Test seam: forget every quota and pause.
#[cfg(test)]
pub(crate) fn reset_limits_for_tests() {
    *LIMITS.lock() = Limits::default();
}

/// Test seam: the quota state is process-wide, so the tests that set it run
/// one at a time, in this module and in the driver's.
#[cfg(test)]
pub(crate) static LIMITS_SERIAL: Mutex<()> = Mutex::new(());

/// Test seam: a quota with `remaining` of `limit` left until an hour from now.
#[cfg(test)]
pub(crate) fn set_quota_for_tests(resource: Resource, limit: f64, remaining: f64) {
    LIMITS.lock().quotas.insert(
        resource.key(),
        Quota {
            limit,
            remaining,
            reset_at_ms: now_ms() + 3_600_000,
        },
    );
}

/// When GitHub asked to be retried: `retry-after` (seconds or an HTTP date),
/// else the primary limit's reset.
pub(crate) fn retry_at_from(headers: &HashMap<String, String>, now: i64) -> Option<i64> {
    if let Some(value) = headers.get("retry-after") {
        let value = value.trim();
        if let Ok(seconds) = value.parse::<i64>() {
            return Some(now + seconds * 1000);
        }
        if let Ok(at) = chrono::DateTime::parse_from_rfc2822(value) {
            let at = at.timestamp_millis();
            if at > now {
                return Some(at);
            }
        }
    }
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.trim().parse::<i64>().ok())?
        * 1000;
    (reset > now).then_some(reset)
}

/// Whether GitHub refused a request for its rate limit. A GraphQL answer can
/// say so with HTTP 200: a `RATE_LIMITED` error, or an untyped "rate limit
/// exceeded" error the headers confirm.
pub(crate) fn is_rate_limited(
    status: u16,
    headers: &HashMap<String, String>,
    graphql_errors: Option<&[Value]>,
    body: &str,
) -> bool {
    let exhausted = headers.get("x-ratelimit-remaining").map(String::as_str) == Some("0");
    status == 429
        || graphql_errors.is_some_and(|errors| {
            exhausted
                || errors.iter().any(|e| {
                    e.get("type").and_then(Value::as_str) == Some("RATE_LIMITED")
                        || e.get("message")
                            .and_then(Value::as_str)
                            .is_some_and(|m| m.to_ascii_lowercase().contains("rate limit"))
                })
        })
        || (status == 403
            && (exhausted
                || headers.contains_key("retry-after")
                || body.to_ascii_lowercase().contains("rate limit")))
}

/// The messages in a REST failure body: `{ message, errors: [..] }`.
pub(crate) fn rest_error_messages(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(m) = value.get("message").and_then(Value::as_str) {
        out.push(m.to_string());
    }
    for e in value
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(s) = e.as_str() {
            out.push(s.to_string());
        } else if let Some(m) = e.get("message").and_then(Value::as_str) {
            out.push(m.to_string());
        } else if let (Some(f), Some(c)) = (
            e.get("field").and_then(Value::as_str),
            e.get("code").and_then(Value::as_str),
        ) {
            out.push(format!("{f} {c}"));
        }
    }
    out
}

/// What a `gh` run that printed no HTTP answer means, from its exit and
/// stderr. Only the classification leaves this function, never the text of a
/// command line.
pub(crate) fn classify_no_response(exit: Option<i32>, stderr: &str) -> PrError {
    let lower = stderr.to_ascii_lowercase();
    if exit == Some(GH_EXIT_AUTH_REQUIRED)
        || lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("authentication required")
    {
        return PrError::NotAuthenticated;
    }
    if lower.contains("rate limit") {
        return PrError::RateLimited { retry_at: None };
    }
    if lower.contains("none of the git remotes")
        || lower.contains("not a git repository")
        || lower.contains("no git remotes")
        || lower.contains("could not determine")
        || lower.contains("not a github")
    {
        return PrError::Unsupported {
            message: "This checkout's remote is not a GitHub repository.".into(),
        };
    }
    if lower.contains("too large") {
        return PrError::Failed {
            message: "GitHub's answer was too large to read.".into(),
        };
    }
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("gh could not reach GitHub");
    PrError::Network {
        message: first.trim_start_matches("gh: ").to_string(),
    }
}

/// Decide what one REST answer means. A 304 is an answer only when the
/// request revalidated a cached one.
pub(crate) fn classify_rest(
    response: &HttpResponse,
    accept_not_modified: bool,
    now: i64,
) -> Result<(), PrError> {
    let body = response.body_text();
    if is_rate_limited(response.status, &response.headers, None, &body) {
        return Err(PrError::RateLimited {
            retry_at: retry_at_from(&response.headers, now),
        });
    }
    match response.status {
        200..=299 => Ok(()),
        304 if accept_not_modified => Ok(()),
        401 => Err(PrError::NotAuthenticated),
        404 => Err(PrError::NotFound),
        500..=599 => Err(PrError::Network {
            message: format!("GitHub returned HTTP {}.", response.status),
        }),
        status => {
            let messages = rest_error_messages(&body);
            Err(PrError::Failed {
                message: if messages.is_empty() {
                    format!("GitHub returned HTTP {status}.")
                } else {
                    format!("GitHub returned an error: {}", messages.join("; "))
                },
            })
        }
    }
}

/// Decide what one GraphQL answer means, returning its `data`.
pub(crate) fn classify_graphql(response: &HttpResponse, now: i64) -> Result<Value, PrError> {
    classify_graphql_with(response, now, false)
}

/// As [`classify_graphql`], and with `keep_partial` an answer whose only
/// errors are `NOT_FOUND` and which still carries `data` is that data: an
/// aliased read of several pull requests answers `null` under a missing
/// one's alias and keeps the rest, so one deleted pull request does not
/// cost the whole document.
fn classify_graphql_with(
    response: &HttpResponse,
    now: i64,
    keep_partial: bool,
) -> Result<Value, PrError> {
    let body = response.body_text();
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let errors: Option<Vec<Value>> = parsed
        .as_ref()
        .and_then(|v| v.get("errors"))
        .and_then(Value::as_array)
        .filter(|e| !e.is_empty())
        .cloned();
    if is_rate_limited(response.status, &response.headers, errors.as_deref(), &body) {
        return Err(PrError::RateLimited {
            retry_at: retry_at_from(&response.headers, now),
        });
    }
    match response.status {
        200..=299 => {}
        401 => return Err(PrError::NotAuthenticated),
        404 => return Err(PrError::NotFound),
        500..=599 => {
            return Err(PrError::Network {
                message: format!("GitHub returned HTTP {}.", response.status),
            })
        }
        status => {
            return Err(PrError::Failed {
                message: format!("GitHub returned HTTP {status}."),
            })
        }
    }
    if let Some(errors) = errors {
        if errors
            .iter()
            .all(|e| e.get("type").and_then(Value::as_str) == Some("NOT_FOUND"))
        {
            let data = parsed
                .and_then(|mut v| v.get_mut("data").map(Value::take))
                .filter(|d| keep_partial && d.is_object());
            return data.ok_or(PrError::NotFound);
        }
        return Err(PrError::GraphqlErrors { errors });
    }
    parsed
        .and_then(|mut v| v.get_mut("data").map(Value::take))
        .filter(|d| !d.is_null())
        .ok_or_else(|| PrError::Failed {
            message: "GitHub's answer could not be read.".into(),
        })
}

// ── conditional reads ────────────────────────────────────────────────────

/// The last ETag and body of each REST read, so an unchanged answer comes
/// back as a 304, which GitHub does not charge. Keyed by the signed-in login
/// and the checkout as well as the path, so one account's body is never
/// revalidated for another. A 304 refreshes the entry, so one that is still
/// polled outlives its time to live.
const ETAG_CAPACITY: usize = 512;
const ETAG_TTL_MS: i64 = 60 * 60_000;
/// A body past this is not kept: the cache is for polled reads, not diffs of
/// a thousand files.
const ETAG_MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Debug, Default)]
struct Etags {
    entries: HashMap<String, (String, Vec<u8>, i64)>,
    order: VecDeque<String>,
}

static ETAGS: LazyLock<Mutex<Etags>> = LazyLock::new(|| Mutex::new(Etags::default()));

fn etag_get(key: &str, now: i64) -> Option<(String, Vec<u8>)> {
    let etags = ETAGS.lock();
    let (etag, body, at) = etags.entries.get(key)?;
    (now - at <= ETAG_TTL_MS).then(|| (etag.clone(), body.clone()))
}

fn etag_put(key: String, etag: String, body: Vec<u8>, now: i64) {
    if body.len() > ETAG_MAX_BODY {
        return;
    }
    let mut etags = ETAGS.lock();
    if etags
        .entries
        .insert(key.clone(), (etag, body, now))
        .is_none()
    {
        etags.order.push_back(key);
    } else {
        etags.order.retain(|k| k != &key);
        etags.order.push_back(key);
    }
    while etags.order.len() > ETAG_CAPACITY {
        if let Some(oldest) = etags.order.pop_front() {
            etags.entries.remove(&oldest);
        }
    }
}

fn etag_touch(key: &str, now: i64) {
    if let Some(entry) = ETAGS.lock().entries.get_mut(key) {
        entry.2 = now;
    }
}

fn etag_forget(key: &str) {
    let mut etags = ETAGS.lock();
    etags.entries.remove(key);
    etags.order.retain(|k| k != key);
}

// ── the client ───────────────────────────────────────────────────────────

/// `gh` bound to one checkout.
#[derive(Debug, Clone)]
pub(crate) struct Gh {
    program: OsString,
    cwd: String,
}

impl Gh {
    pub fn new(cwd: &str) -> Self {
        Self {
            program: OsString::from("gh"),
            cwd: cwd.to_string(),
        }
    }

    /// Test seam: a `gh` at another path (one that does not exist reads as
    /// [`PrError::NotInstalled`], with no process and no network).
    #[cfg(test)]
    pub fn with_program(cwd: &str, program: &str) -> Self {
        Self {
            program: OsString::from(program),
            cwd: cwd.to_string(),
        }
    }

    /// One `gh` run through the permit pool, classified into an HTTP answer
    /// or the reason there is none. The quota gate ([`admit`]) is the
    /// caller's, ahead of [`Self::settle`]: a read held back at the reserve
    /// is not GitHub refusing it, and must not pause the quota for the user's
    /// own reads.
    async fn send(&self, call: GhCall, resource: Resource) -> Result<HttpResponse, PrError> {
        let _permit = permits_for(resource)
            .acquire()
            .await
            .map_err(|_| PrError::Failed {
                message: "Atlas is shutting down.".into(),
            })?;
        match run(&self.program, &self.cwd, &call).await {
            RunOutcome::Http(response) => {
                observe(&response.headers);
                Ok(response)
            }
            RunOutcome::Missing => Err(PrError::NotInstalled),
            RunOutcome::TimedOut => Err(PrError::Network {
                message: "GitHub did not answer in time.".into(),
            }),
            RunOutcome::NoResponse { exit, stderr } => Err(classify_no_response(exit, &stderr)),
        }
    }

    fn settle<T>(&self, resource: Resource, result: Result<T, PrError>) -> Result<T, PrError> {
        match &result {
            Ok(_) => record_success(resource),
            Err(PrError::RateLimited { retry_at }) => {
                let until = record_rate_limit(resource, *retry_at, now_ms());
                return Err(PrError::RateLimited {
                    retry_at: Some(until),
                });
            }
            Err(_) => {}
        }
        result
    }

    /// A GraphQL document with its variables, sent as the request body on
    /// stdin so no value passes through a command line.
    pub async fn graphql(
        &self,
        query: &str,
        variables: Value,
        allow_reserve: bool,
        timeout: Duration,
    ) -> Result<Value, PrError> {
        self.graphql_with(query, variables, allow_reserve, timeout, false)
            .await
    }

    /// A GraphQL read whose `NOT_FOUND`-only answer keeps the data it has
    /// ([`classify_graphql_with`]).
    pub async fn graphql_partial(
        &self,
        query: &str,
        variables: Value,
        allow_reserve: bool,
        timeout: Duration,
    ) -> Result<Value, PrError> {
        self.graphql_with(query, variables, allow_reserve, timeout, true)
            .await
    }

    async fn graphql_with(
        &self,
        query: &str,
        variables: Value,
        allow_reserve: bool,
        timeout: Duration,
        keep_partial: bool,
    ) -> Result<Value, PrError> {
        admit(Resource::Graphql, allow_reserve, now_ms())?;
        let body =
            serde_json::to_vec(&serde_json::json!({ "query": query, "variables": variables }))
                .map_err(|e| PrError::Failed {
                    message: e.to_string(),
                })?;
        let call = GhCall {
            args: vec![
                "api".into(),
                "-i".into(),
                "graphql".into(),
                "--input".into(),
                "-".into(),
            ],
            stdin: Some(body),
            timeout,
        };
        let result = self
            .send(call, Resource::Graphql)
            .await
            .and_then(|r| classify_graphql_with(&r, now_ms(), keep_partial));
        self.settle(Resource::Graphql, result)
    }

    /// The one request that asks `gh` to fill in `{owner}` and `{repo}` from
    /// the checkout's remote. `gh` substitutes a placeholder only when it is
    /// a field's whole value, and only in `-F` fields, never in a body on
    /// stdin — so this request alone passes its variables as flags.
    pub async fn graphql_with_repo_placeholders(
        &self,
        query: &str,
        allow_reserve: bool,
    ) -> Result<Value, PrError> {
        admit(Resource::Graphql, allow_reserve, now_ms())?;
        let call = GhCall {
            args: vec![
                "api".into(),
                "-i".into(),
                "graphql".into(),
                "-F".into(),
                "owner={owner}".into(),
                "-F".into(),
                "name={repo}".into(),
                "-f".into(),
                format!("query={query}"),
            ],
            stdin: None,
            timeout: READ_TIMEOUT,
        };
        let result = self
            .send(call, Resource::Graphql)
            .await
            .and_then(|r| classify_graphql(&r, now_ms()));
        self.settle(Resource::Graphql, result)
    }

    /// A REST GET. With `revalidate`, the last answer's ETag goes along and a
    /// 304 returns the cached body; `scope` keys that cache (the signed-in
    /// login).
    pub async fn rest_get(
        &self,
        path: &str,
        accept: Option<&str>,
        revalidate: Option<&str>,
        allow_reserve: bool,
        timeout: Duration,
    ) -> Result<Vec<u8>, PrError> {
        admit(Resource::Core, allow_reserve, now_ms())?;
        let key = revalidate
            .map(|scope| format!("{scope}\0{}\0{}\0{}", self.cwd, accept.unwrap_or(""), path));
        let now = now_ms();
        let previous = key.as_deref().and_then(|k| etag_get(k, now));
        let mut args: Vec<String> =
            vec!["api".into(), "-i".into(), "--method".into(), "GET".into()];
        if let Some(accept) = accept {
            args.push("-H".into());
            args.push(format!("Accept: {accept}"));
        }
        if let Some((etag, _)) = &previous {
            args.push("-H".into());
            args.push(format!("If-None-Match: {etag}"));
        }
        args.push(path.to_string());
        let call = GhCall {
            args,
            stdin: None,
            timeout,
        };
        let result = match self.send(call, Resource::Core).await {
            Ok(response) => {
                let now = now_ms();
                classify_rest(&response, previous.is_some(), now).map(|()| {
                    if response.status == 304 {
                        if let (Some(k), Some((_, body))) = (&key, &previous) {
                            etag_touch(k, now);
                            return body.clone();
                        }
                    }
                    if let Some(k) = &key {
                        match response.header("etag") {
                            Some(etag) => {
                                etag_put(k.clone(), etag.to_string(), response.body.clone(), now)
                            }
                            None => etag_forget(k),
                        }
                    }
                    response.body
                })
            }
            Err(e) => Err(e),
        };
        self.settle(Resource::Core, result)
    }

    /// A REST GET of plain text that may carry terminal escape codes (a
    /// workflow job's log). `gh` refuses to print those unless told it may;
    /// an older `gh` that does not know the flag is asked again without it
    /// (it prints them anyway). Never revalidated: a log is read once, on
    /// request.
    pub async fn rest_get_text(&self, path: &str, timeout: Duration) -> Result<Vec<u8>, PrError> {
        admit(Resource::Core, true, now_ms())?;
        let mut result = Err(PrError::NotInstalled);
        for allow_escapes in [true, false] {
            let mut args: Vec<String> =
                vec!["api".into(), "-i".into(), "--method".into(), "GET".into()];
            if allow_escapes {
                args.push("--allow-escape-sequences".into());
            }
            args.push(path.to_string());
            let call = GhCall {
                args,
                stdin: None,
                timeout,
            };
            let outcome =
                {
                    let _permit = permits_for(Resource::Core).acquire().await.map_err(|_| {
                        PrError::Failed {
                            message: "Atlas is shutting down.".into(),
                        }
                    })?;
                    run(&self.program, &self.cwd, &call).await
                };
            result = match outcome {
                RunOutcome::NoResponse { stderr, .. }
                    if allow_escapes && stderr.contains("unknown flag") =>
                {
                    continue
                }
                RunOutcome::Http(response) => {
                    observe(&response.headers);
                    classify_rest(&response, false, now_ms()).map(|()| response.body)
                }
                RunOutcome::Missing => Err(PrError::NotInstalled),
                RunOutcome::TimedOut => Err(PrError::Network {
                    message: "GitHub did not answer in time.".into(),
                }),
                RunOutcome::NoResponse { exit, stderr } => Err(classify_no_response(exit, &stderr)),
            };
            break;
        }
        self.settle(Resource::Core, result)
    }

    /// A REST write. `body` is sent as JSON on stdin.
    pub async fn rest_send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Vec<u8>, PrError> {
        admit(Resource::Core, true, now_ms())?;
        let mut args: Vec<String> =
            vec!["api".into(), "-i".into(), "--method".into(), method.into()];
        let stdin = match body {
            Some(value) => {
                args.push("--input".into());
                args.push("-".into());
                Some(serde_json::to_vec(value).map_err(|e| PrError::Failed {
                    message: e.to_string(),
                })?)
            }
            None => None,
        };
        args.push(path.to_string());
        let call = GhCall {
            args,
            stdin,
            timeout: WRITE_TIMEOUT,
        };
        let result = self
            .send(call, Resource::Core)
            .await
            .and_then(|r| classify_rest(&r, false, now_ms()).map(|()| r.body));
        self.settle(Resource::Core, result)
    }

    /// A GET of an absolute URL, with no API quota behind it (the image
    /// proxy). The caller has already checked the URL against its allowlist.
    pub async fn fetch_url(&self, url: &str, timeout: Duration) -> Result<HttpResponse, PrError> {
        let call = GhCall {
            args: vec![
                "api".into(),
                "-i".into(),
                "--method".into(),
                "GET".into(),
                url.into(),
            ],
            stdin: None,
            timeout,
        };
        let response = self.send(call, Resource::Unmetered).await?;
        classify_rest(&response, false, now_ms())?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn an_answer_is_read_as_status_headers_and_body() {
        let raw = b"HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: \"abc\"\r\nX-Ratelimit-Remaining: 4979\r\n\r\n{\"ok\":true}";
        let response = parse_http(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.header("etag"), Some("\"abc\""));
        assert_eq!(response.header("x-ratelimit-remaining"), Some("4979"));
        assert_eq!(response.body, b"{\"ok\":true}");
    }

    #[test]
    fn a_304_with_no_body_is_an_answer() {
        let response = parse_http(b"HTTP/2.0 304 Not Modified\r\nEtag: \"abc\"\r\n\r\n").unwrap();
        assert_eq!(response.status, 304);
        assert!(response.body.is_empty());
    }

    #[test]
    fn a_followed_redirect_leaves_the_final_answer() {
        let raw = b"HTTP/1.1 302 Found\r\nLocation: x\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: image/png\r\n\r\n\x89PNG";
        let response = parse_http(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.header("content-type"), Some("image/png"));
        assert_eq!(response.body, b"\x89PNG");
    }

    #[test]
    fn output_that_is_not_http_is_no_answer() {
        assert_eq!(parse_http(b""), None);
        assert_eq!(parse_http(b"{\"data\":{}}"), None);
    }

    #[test]
    fn rate_limits_are_recognised_the_ways_github_says_them() {
        let none = headers(&[]);
        assert!(is_rate_limited(429, &none, None, ""));
        assert!(is_rate_limited(
            403,
            &headers(&[("x-ratelimit-remaining", "0")]),
            None,
            ""
        ));
        assert!(is_rate_limited(
            403,
            &headers(&[("retry-after", "60")]),
            None,
            ""
        ));
        assert!(is_rate_limited(
            403,
            &none,
            None,
            r#"{"message":"You have exceeded a secondary rate limit"}"#
        ));
        let typed = vec![serde_json::json!({"type":"RATE_LIMITED","message":"x"})];
        assert!(is_rate_limited(200, &none, Some(&typed), ""));
        let untyped = vec![serde_json::json!({"message":"API rate limit already exceeded"})];
        assert!(is_rate_limited(200, &none, Some(&untyped), ""));
        // A plain refusal is not a rate limit.
        assert!(!is_rate_limited(
            403,
            &none,
            None,
            r#"{"message":"Resource not accessible"}"#
        ));
        assert!(!is_rate_limited(200, &none, None, ""));
    }

    #[test]
    fn the_retry_time_comes_from_retry_after_then_the_reset() {
        let now = 1_000_000;
        assert_eq!(
            retry_at_from(&headers(&[("retry-after", "30")]), now),
            Some(now + 30_000)
        );
        assert_eq!(
            retry_at_from(&headers(&[("x-ratelimit-reset", "2000")]), now),
            Some(2_000_000)
        );
        assert_eq!(
            retry_at_from(&headers(&[("x-ratelimit-reset", "10")]), now),
            None
        );
    }

    fn http(status: u16, hs: &[(&str, &str)], body: &str) -> HttpResponse {
        HttpResponse {
            status,
            headers: headers(hs),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn rest_statuses_are_classified() {
        assert_eq!(classify_rest(&http(200, &[], "{}"), false, 0), Ok(()));
        assert_eq!(classify_rest(&http(304, &[], ""), true, 0), Ok(()));
        assert!(matches!(
            classify_rest(&http(304, &[], ""), false, 0),
            Err(PrError::Failed { .. })
        ));
        assert_eq!(
            classify_rest(&http(401, &[], ""), false, 0),
            Err(PrError::NotAuthenticated)
        );
        assert_eq!(
            classify_rest(&http(404, &[], ""), false, 0),
            Err(PrError::NotFound)
        );
        assert!(matches!(
            classify_rest(&http(502, &[], ""), false, 0),
            Err(PrError::Network { .. })
        ));
        assert_eq!(
            classify_rest(
                &http(
                    422,
                    &[],
                    r#"{"message":"Validation Failed","errors":[{"field":"head","code":"invalid"}]}"#
                ),
                false,
                0
            ),
            Err(PrError::Failed {
                message: "GitHub returned an error: Validation Failed; head invalid".into()
            })
        );
        assert_eq!(
            classify_rest(
                &http(
                    403,
                    &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "5")],
                    ""
                ),
                false,
                1000
            ),
            Err(PrError::RateLimited {
                retry_at: Some(5000)
            })
        );
    }

    #[test]
    fn graphql_answers_are_classified() {
        assert_eq!(
            classify_graphql(&http(200, &[], r#"{"data":{"viewer":{"login":"a"}}}"#), 0),
            Ok(serde_json::json!({"viewer":{"login":"a"}}))
        );
        assert_eq!(
            classify_graphql(
                &http(
                    200,
                    &[],
                    r#"{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","message":"Could not resolve"}]}"#
                ),
                0
            ),
            Err(PrError::NotFound)
        );
        assert!(matches!(
            classify_graphql(
                &http(
                    200,
                    &[],
                    r#"{"errors":[{"type":"FORBIDDEN","message":"no"}]}"#
                ),
                0
            ),
            Err(PrError::GraphqlErrors { .. })
        ));
        assert_eq!(
            classify_graphql(
                &http(
                    200,
                    &[("x-ratelimit-reset", "9")],
                    r#"{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}"#
                ),
                0
            ),
            Err(PrError::RateLimited {
                retry_at: Some(9000)
            })
        );
    }

    #[test]
    fn a_partial_answer_keeps_what_was_found() {
        let body = r#"{"data":{"repository":{"p0":{"number":1},"p1":null}},"errors":[{"type":"NOT_FOUND","path":["repository","p1"],"message":"Could not resolve"}]}"#;
        assert_eq!(
            classify_graphql_with(&http(200, &[], body), 0, true),
            Ok(serde_json::json!({"repository":{"p0":{"number":1},"p1":null}}))
        );
        // The strict reading still calls it missing.
        assert_eq!(
            classify_graphql(&http(200, &[], body), 0),
            Err(PrError::NotFound)
        );
        // With no data at all, missing is missing either way.
        assert_eq!(
            classify_graphql_with(
                &http(
                    200,
                    &[],
                    r#"{"errors":[{"type":"NOT_FOUND","message":"x"}]}"#
                ),
                0,
                true
            ),
            Err(PrError::NotFound)
        );
        // Any other error still fails the read.
        assert!(matches!(
            classify_graphql_with(
                &http(
                    200,
                    &[],
                    r#"{"data":{},"errors":[{"type":"NOT_FOUND"},{"type":"FORBIDDEN"}]}"#
                ),
                0,
                true
            ),
            Err(PrError::GraphqlErrors { .. })
        ));
    }

    #[test]
    fn images_wait_in_a_pool_of_their_own() {
        assert!(std::ptr::eq(
            permits_for(Resource::Unmetered),
            &IMAGE_PERMITS
        ));
        assert!(std::ptr::eq(permits_for(Resource::Graphql), &PR_PERMITS));
        assert!(std::ptr::eq(permits_for(Resource::Core), &PR_PERMITS));
    }

    #[test]
    fn runs_without_an_answer_are_classified_by_exit_and_stderr() {
        assert_eq!(classify_no_response(Some(4), ""), PrError::NotAuthenticated);
        assert_eq!(
            classify_no_response(
                Some(1),
                "To get started with GitHub CLI, please run:  gh auth login"
            ),
            PrError::NotAuthenticated
        );
        assert!(matches!(
            classify_no_response(Some(1), "none of the git remotes configured for this repository point to a known GitHub host"),
            PrError::Unsupported { .. }
        ));
        assert_eq!(
            classify_no_response(
                Some(1),
                "error connecting to api.github.com\ncheck your internet connection"
            ),
            PrError::Network {
                message: "error connecting to api.github.com".into()
            }
        );
    }

    #[test]
    fn a_paused_quota_refuses_until_its_time_and_the_reserve_holds_background_reads() {
        let _serial = LIMITS_SERIAL.lock();
        reset_limits_for_tests();
        let until = record_rate_limit(Resource::Graphql, Some(50_000), 1_000);
        assert_eq!(until, 50_000);
        assert_eq!(
            admit(Resource::Graphql, true, 2_000),
            Err(PrError::RateLimited {
                retry_at: Some(50_000)
            })
        );
        // Another quota is untouched, and the pause lifts at its time.
        assert_eq!(admit(Resource::Core, false, 2_000), Ok(()));
        assert_eq!(admit(Resource::Graphql, true, 50_001), Ok(()));

        reset_limits_for_tests();
        let reset = (now_ms() / 1000 + 3600).to_string();
        observe(&headers(&[
            ("x-ratelimit-resource", "core"),
            ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "100"),
            ("x-ratelimit-reset", &reset),
        ]));
        assert!(matches!(
            admit(Resource::Core, false, now_ms()),
            Err(PrError::RateLimited { .. })
        ));
        assert_eq!(admit(Resource::Core, true, now_ms()), Ok(()));
        reset_limits_for_tests();
    }

    #[test]
    fn a_refusal_with_no_reset_cools_down_longer_each_time() {
        let _serial = LIMITS_SERIAL.lock();
        reset_limits_for_tests();
        let first = record_rate_limit(Resource::Core, None, 0);
        let second = record_rate_limit(Resource::Core, None, 0);
        assert_eq!(first, 30_000);
        assert_eq!(second, 60_000);
        reset_limits_for_tests();
    }

    #[test]
    fn the_etag_cache_is_bounded_and_refreshes_on_touch() {
        let key = |i: usize| format!("test-etag-{i}");
        for i in 0..(ETAG_CAPACITY + 5) {
            etag_put(key(i), format!("\"{i}\""), vec![1], 0);
        }
        assert!(etag_get(&key(0), 0).is_none());
        assert_eq!(
            etag_get(&key(ETAG_CAPACITY + 4), 0).unwrap().0,
            format!("\"{}\"", ETAG_CAPACITY + 4)
        );
        assert!(etag_get(&key(ETAG_CAPACITY + 4), ETAG_TTL_MS + 1).is_none());
        etag_touch(&key(ETAG_CAPACITY + 4), ETAG_TTL_MS);
        assert!(etag_get(&key(ETAG_CAPACITY + 4), ETAG_TTL_MS + 1).is_some());
    }

    #[cfg(unix)]
    mod runner {
        use super::super::*;
        use std::path::PathBuf;

        /// A fake `gh` run through `/bin/sh`, so a freshly written script
        /// cannot hit ETXTBSY when another test thread forks mid-write.
        fn fake_gh(body: &str) -> (tempfile::TempDir, PathBuf) {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("gh");
            std::fs::write(&path, format!("{body}\n")).unwrap();
            (dir, path)
        }

        fn call(script: &std::path::Path, stdin: Option<&str>, timeout: Duration) -> GhCall {
            GhCall {
                args: vec![script.to_string_lossy().into_owned()],
                stdin: stdin.map(|s| s.as_bytes().to_vec()),
                timeout,
            }
        }

        fn cwd() -> String {
            std::env::temp_dir().to_string_lossy().into_owned()
        }

        #[tokio::test]
        async fn an_http_answer_is_parsed_whatever_the_exit_code() {
            let (_d, gh) = fake_gh(
                r#"printf 'HTTP/2.0 304 Not Modified\r\nEtag: "x"\r\n\r\n'; echo 'gh: HTTP 304' >&2; exit 1"#,
            );
            let outcome = run(
                OsStr::new("/bin/sh"),
                &cwd(),
                &call(&gh, None, READ_TIMEOUT),
            )
            .await;
            let RunOutcome::Http(response) = outcome else {
                panic!("expected an answer");
            };
            assert_eq!(response.status, 304);
        }

        #[tokio::test]
        async fn stdin_reaches_the_process() {
            let (_d, gh) = fake_gh(r#"printf 'HTTP/2.0 200 OK\r\n\r\n'; cat"#);
            let outcome = run(
                OsStr::new("/bin/sh"),
                &cwd(),
                &call(&gh, Some(r#"{"query":"q"}"#), READ_TIMEOUT),
            )
            .await;
            let RunOutcome::Http(response) = outcome else {
                panic!("expected an answer");
            };
            assert_eq!(response.body, br#"{"query":"q"}"#);
        }

        #[tokio::test]
        async fn no_answer_keeps_exit_and_stderr() {
            let (_d, gh) = fake_gh("echo 'error connecting to api.github.com' >&2; exit 1");
            assert_eq!(
                run(
                    OsStr::new("/bin/sh"),
                    &cwd(),
                    &call(&gh, None, READ_TIMEOUT)
                )
                .await,
                RunOutcome::NoResponse {
                    exit: Some(1),
                    stderr: "error connecting to api.github.com\n".into()
                }
            );
        }

        #[tokio::test]
        async fn a_missing_binary_is_missing() {
            let dir = tempfile::tempdir().unwrap();
            let missing = dir.path().join("gh");
            let call = GhCall {
                args: vec![],
                stdin: None,
                timeout: READ_TIMEOUT,
            };
            assert_eq!(
                run(missing.as_os_str(), &cwd(), &call).await,
                RunOutcome::Missing
            );
        }

        #[tokio::test]
        async fn a_run_past_its_timeout_is_killed() {
            let (_d, gh) = fake_gh("exec sleep 30");
            let started = std::time::Instant::now();
            assert_eq!(
                run(
                    OsStr::new("/bin/sh"),
                    &cwd(),
                    &call(&gh, None, Duration::from_millis(200))
                )
                .await,
                RunOutcome::TimedOut
            );
            assert!(started.elapsed() < Duration::from_secs(10));
        }
    }
}
