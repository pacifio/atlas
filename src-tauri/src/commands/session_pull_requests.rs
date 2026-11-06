//! The pull requests linked to a session: the commands that link and unlink
//! them, and the sync sweep that keeps what every surface shows about them
//! current.
//!
//! A link lives on the session row (`atlas_thread_metadata::PullRequestLink`)
//! with how it came to be — opened from the session (`created`), found on its
//! branch (`detected`), linked by the user (`manual`) or by the agent
//! (`agent`, through `link_pull_request` on the code tool server) — and the
//! host's last reported state, its snapshot. Every surface draws from the
//! row; nothing asks the host per render.
//!
//! ## The sweep
//!
//! [`session_pull_requests_sync`] is one pass, which the frontend schedules:
//! every minute while the window is visible, when it regains focus, and when
//! a turn ends. A pass does two things for each unsettled session it is given:
//!
//! - **detects**: the pull requests whose head is the session's branch in
//!   the checkout's own repository ([`is_detected_on_branch`]), read once per
//!   checkout and branch and trusted for [`DETECT_TTL_MS`], are linked as
//!   `detected` — open ones, and closed or merged ones that moved after the
//!   session began, so a reused branch name does not drag in last year's
//!   work. GitHub's `head:` qualifier matches the branch name in any
//!   repository, forks included, so a fork's `main` would otherwise link to
//!   every session on `main`; and the repository's default branch is never
//!   detected on at all, since nothing is opened *from* it;
//! - **syncs**: each visible link whose snapshot is due ([`is_due`]) is read
//!   again, all of a checkout's due links in one request.
//!
//! The cadence follows how fast a pull request actually changes: one never
//! read is due at once; an open one each pass, or every
//! [`QUIET_SYNC_INTERVAL_MS`] once nobody has touched it for
//! [`QUIET_AFTER_MS`]; a closed one every [`SLOW_SYNC_INTERVAL_MS`]; a merged
//! one never again. A pass the user asked for (`force`) reads its sessions'
//! links regardless.
//!
//! A link whose pull request is no longer there (deleted, or the repository
//! went private) is backed off ([`MISSING`], [`missing_backoff_ms`]) instead
//! of being asked for every pass.
//!
//! The sweep reads as a background reader ([`SWEEP_POLICY`]): it stops when a
//! quota is down to the tenth `gh` keeps for what the user does, and waits
//! for the reset without telling anyone — the user's own reads still have
//! that room. GitHub's rate limit itself stops the pass and holds every later
//! one until its reset ([`PAUSED_UNTIL`]); the pass rejects with
//! `rateLimited`, which the frontend's gh gate (`pr-errors.ts`) honours too.
//! A missing or signed-out `gh` rejects the same way. Nothing here logs a repository, title, branch
//! or URL.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Weak};

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::{
    visible_pull_requests, PullRequestLink, PullRequestLinkSource, PullRequestSnapshot, ThreadId,
    ThreadMetadata, ThreadMetadataStore,
};
use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

use super::agent_host::AgentHost;
use super::pull_requests::{
    quota_paused_until, GitHub, PrChecksState, PrError, PrListEntry, PrListQuery, PrListState,
    PrReviewDecision, PrState, ReadPolicy,
};

/// How long a branch's pull requests are trusted before the branch is asked
/// again. Longer than the minute between passes, so most passes reuse the
/// last answer: a pull request opened from Atlas is linked as `created` at
/// once, and one opened elsewhere turns up within this.
pub const DETECT_TTL_MS: i64 = 5 * 60_000;
/// How the sweep reads: nobody is waiting on it, so it leaves the quota's
/// reserve to the user.
pub(crate) const SWEEP_POLICY: ReadPolicy = ReadPolicy::Background;
/// A linked pull request that did not come back is asked again after this,
/// doubling per miss up to [`MISSING_BACKOFF_MAX_MS`].
const MISSING_BACKOFF_MS: i64 = 15 * 60_000;
const MISSING_BACKOFF_MAX_MS: i64 = 24 * 60 * 60_000;
/// An open pull request nobody has updated for this long is read on the
/// quiet cadence instead of every pass.
pub const QUIET_AFTER_MS: i64 = 30 * 60_000;
pub const QUIET_SYNC_INTERVAL_MS: i64 = 5 * 60_000;
/// A closed pull request can still be reopened; it is read this often.
pub const SLOW_SYNC_INTERVAL_MS: i64 = 15 * 60_000;
/// A rate limit that named no reset holds the sweep this long.
const RATE_LIMIT_FALLBACK_MS: i64 = 60_000;
/// Sessions one pass looks at, newest first. The sidebar sends what it shows.
const MAX_SESSIONS_PER_PASS: usize = 200;
/// A branch's pull requests asked for when detecting.
const DETECT_LIMIT: u32 = 20;

/// When each linked pull request (`checkout\0repository#number`) was last
/// read. In memory: a restart reads everything once, which is what a cold
/// cache costs anyway.
static LAST_SYNCED: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// When a branch's pull requests were read, and what they were.
type DetectedRows = (i64, Vec<PrListEntry>);
/// A branch's pull requests (`checkout\0branch`), and when they were read.
static DETECTED: LazyLock<Mutex<HashMap<String, DetectedRows>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Linked pull requests (`checkout\0repository#number`) that did not come
/// back: how many passes in a row, and when to ask again.
static MISSING: LazyLock<Mutex<HashMap<String, (u32, i64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Until when GitHub said to stop asking (epoch ms), and whether that is only
/// the sweep holding back at the quota's reserve rather than GitHub refusing.
static PAUSED_UNTIL: LazyLock<Mutex<(i64, bool)>> = LazyLock::new(|| Mutex::new((0, false)));
/// One pass at a time: a focus and a timer landing together run one pass.
/// A flag rather than an async mutex: the pass is never waited for, only
/// skipped, and no lock guard is held across the pass's awaits.
static SWEEPING: AtomicBool = AtomicBool::new(false);

/// The running pass's claim on [`SWEEPING`], released when the pass ends,
/// however it ends.
struct SweepPass;

impl SweepPass {
    fn claim() -> Option<Self> {
        SWEEPING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| SweepPass)
    }
}

impl Drop for SweepPass {
    fn drop(&mut self) {
        SWEEPING.store(false, Ordering::Release);
    }
}

// ── wire ────────────────────────────────────────────────────────────────

/// One linked pull request, as every surface reads it (`ThreadRow.pullRequests`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestLinkWire {
    /// `owner/name`.
    pub repository: String,
    pub number: u32,
    pub url: String,
    /// `manual`, `created`, `detected` or `agent`.
    pub source: String,
    /// RFC 3339.
    pub linked_at: String,
    /// `None` until the host has been read.
    pub snapshot: Option<PullRequestSnapshotWire>,
    /// Atlas is watching it for the session (`pull_request_watch`).
    pub watching: bool,
}

/// The host's last reported state for a linked pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSnapshotWire {
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub title: String,
    pub head_branch: String,
    pub base_branch: String,
    pub is_draft: bool,
    pub updated_at: Option<String>,
    /// When it merged; `None` while it is not merged, or when the snapshot
    /// predates the merge time being kept.
    pub merged_at: Option<String>,
    /// `passing`, `failing` or `pending`.
    pub checks_state: Option<String>,
    /// `approved`, `changes-requested` or `review-required`.
    pub review_decision: Option<String>,
    pub comment_count: Option<u32>,
    /// RFC 3339: when Atlas read it.
    pub synced_at: String,
}

impl From<&PullRequestLink> for PullRequestLinkWire {
    fn from(link: &PullRequestLink) -> Self {
        Self {
            repository: link.repository.clone(),
            number: link.number,
            url: link.url.clone(),
            source: link.source.as_str().to_string(),
            linked_at: link.linked_at.to_rfc3339(),
            snapshot: link.snapshot.as_ref().map(|s| PullRequestSnapshotWire {
                state: s.state.clone(),
                title: s.title.clone(),
                head_branch: s.head_branch.clone(),
                base_branch: s.base_branch.clone(),
                is_draft: s.is_draft,
                updated_at: s.updated_at.clone(),
                merged_at: s.merged_at.clone(),
                checks_state: s.checks_state.clone(),
                review_decision: s.review_decision.clone(),
                comment_count: s.comment_count,
                synced_at: s.synced_at.to_rfc3339(),
            }),
            watching: link.is_watched(),
        }
    }
}

/// The links a row shows: tombstones are the store's business only.
pub fn links_wire(links: &[PullRequestLink]) -> Vec<PullRequestLinkWire> {
    visible_pull_requests(links)
        .map(PullRequestLinkWire::from)
        .collect()
}

/// What a link or unlink did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPullRequestsChange {
    /// The session's links after the change.
    pub pull_requests: Vec<PullRequestLinkWire>,
    /// `false` when it was already so.
    pub changed: bool,
}

/// What one sweep pass did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPullRequestsSync {
    /// Pull requests read from the host this pass.
    pub read: usize,
    /// Links added by detection.
    pub detected: usize,
    /// Sessions whose links changed.
    pub changed: usize,
    /// Another pass was already running; this one did nothing.
    pub skipped: bool,
}

// ── commands ────────────────────────────────────────────────────────────

/// Link pull request `number` of the checkout at `repoPath` to the session
/// `threadId`. `source` is `manual` (the default) or `agent`. The pull
/// request is read first, so a number the repository does not have rejects
/// with `notFound` and a fresh link arrives with its snapshot. Linking one
/// already linked changes nothing.
#[tauri::command]
pub async fn session_pull_requests_link(
    thread_id: String,
    repo_path: String,
    number: u64,
    source: Option<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionPullRequestsChange, PrError> {
    let thread_id = parse_thread_id(&thread_id)?;
    let source = match source.as_deref() {
        None => PullRequestLinkSource::Manual,
        Some(raw) => PullRequestLinkSource::parse(raw)
            .filter(|s| s.is_deliberate())
            .ok_or_else(|| PrError::invalid(format!("not a link source: {raw}")))?,
    };
    link_by_number(host.inner(), thread_id, &repo_path, number, source).await
}

/// Unlink `repository#number` from the session. The branch sweep does not
/// bring it back; linking it again does.
#[tauri::command(async)]
pub fn session_pull_requests_unlink(
    thread_id: String,
    repository: String,
    number: u32,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionPullRequestsChange, PrError> {
    let thread_id = parse_thread_id(&thread_id)?;
    let store = store_of(host.inner())?;
    let changed = store.unlink_pull_request(thread_id, &repository, number);
    Ok(SessionPullRequestsChange {
        pull_requests: links_wire(&store.pull_requests(thread_id)),
        changed,
    })
}

/// Start or stop watching `repository#number` for the session — the user's
/// eye toggle. While watched, Atlas wakes the session's agent when a check
/// fails, the checks pass, someone comments or the branch conflicts
/// (`pull_request_watch`). The link must exist; a settled session, a merged
/// pull request, or "Let agents watch pull requests" switched off refuses a
/// watch with `invalid`.
#[tauri::command(async)]
pub fn session_pull_requests_watch(
    thread_id: String,
    repository: String,
    number: u32,
    watching: bool,
    host: State<'_, Arc<AgentHost>>,
    app: tauri::AppHandle,
) -> Result<SessionPullRequestsChange, PrError> {
    let thread_id = parse_thread_id(&thread_id)?;
    let store = store_of(host.inner())?;
    if watching {
        let wakes_on = crate::state::atlas_config::read(&app).pull_request_watch_wakes;
        check_watchable(store, thread_id, &repository, number, wakes_on)?;
    }
    let changed = store.set_pull_request_watch(thread_id, &repository, number, watching);
    Ok(SessionPullRequestsChange {
        pull_requests: links_wire(&store.pull_requests(thread_id)),
        changed,
    })
}

/// Why `repository#number` cannot be watched for the session, if it cannot.
fn check_watchable(
    store: &ThreadMetadataStore,
    thread_id: ThreadId,
    repository: &str,
    number: u32,
    wakes_on: bool,
) -> Result<(), PrError> {
    if !wakes_on {
        return Err(PrError::invalid(
            "Watching pull requests is switched off in Settings.",
        ));
    }
    let thread = store
        .thread(thread_id)
        .ok_or_else(|| PrError::invalid("This session has no history row."))?;
    if thread.is_settled() {
        return Err(PrError::invalid(
            "This session is settled. Unsettle it before watching a pull request.",
        ));
    }
    let link = visible_pull_requests(&thread.pull_requests)
        .find(|l| l.is(repository, number))
        .ok_or_else(|| PrError::invalid("That pull request is not linked to this session."))?;
    if let Some(state) = link
        .snapshot
        .as_ref()
        .map(|s| s.state.as_str())
        .filter(|s| *s != "open")
    {
        return Err(PrError::invalid(format!(
            "The pull request is {state}, so there is nothing to watch."
        )));
    }
    Ok(())
}

/// One sweep pass over the sessions `threadIds` (every unsettled session
/// when absent). `force` reads their links whether due or not — what a turn
/// end and an explicit refresh ask for. See the module docs.
#[tauri::command]
pub async fn session_pull_requests_sync(
    thread_ids: Option<Vec<String>>,
    force: Option<bool>,
    host: State<'_, Arc<AgentHost>>,
    app: tauri::AppHandle,
) -> Result<SessionPullRequestsSync, PrError> {
    let wanted: Option<HashSet<ThreadId>> = thread_ids.map(|ids| {
        ids.iter()
            .filter_map(|raw| raw.parse::<ThreadId>().ok())
            .collect()
    });
    let report = sweep(
        host.inner(),
        wanted.as_ref(),
        force.unwrap_or(false),
        now_ms(),
    )
    .await?;
    // A pull request this pass found merged or closed settles its session
    // now rather than at the watch reactor's next pass.
    if report.changed > 0 {
        super::pull_request_watch::settle_finished(
            host.inner(),
            crate::state::atlas_config::read(&app).auto_settle_on_merge,
        )
        .await;
    }
    Ok(report)
}

// ── the host's side ─────────────────────────────────────────────────────

fn parse_thread_id(raw: &str) -> Result<ThreadId, PrError> {
    raw.parse()
        .map_err(|_| PrError::invalid(format!("not a session id: {raw}")))
}

fn store_of(host: &AgentHost) -> Result<&ThreadMetadataStore, PrError> {
    host.history()
        .map(atlas_thread_metadata::ThreadRecorder::store)
        .ok_or_else(|| PrError::failed("Session history is unavailable."))
}

/// The history row the live session `session_id` writes to.
pub fn thread_for_session(host: &AgentHost, session_id: &str) -> Option<ThreadId> {
    host.history()?.thread_for(&acp::SessionId::new(session_id))
}

/// Read `number` in the checkout at `repo_path` and link it to `thread_id`.
pub async fn link_by_number(
    host: &AgentHost,
    thread_id: ThreadId,
    repo_path: &str,
    number: u64,
    source: PullRequestLinkSource,
) -> Result<SessionPullRequestsChange, PrError> {
    if number == 0 || number > u64::from(u32::MAX) {
        return Err(PrError::invalid("That is not a pull request number."));
    }
    let store = store_of(host)?;
    if store.thread(thread_id).is_none() {
        return Err(PrError::invalid("This session has no history row."));
    }
    let github = GitHub::open(repo_path.trim()).await?;
    let repository = github.provider().repository;
    MISSING
        .lock()
        .remove(&sync_key(repo_path, &repository, number as u32));
    let entry = github
        .entries(&[number])
        .await?
        .into_iter()
        .next()
        .ok_or(PrError::NotFound)?;
    let link = PullRequestLink::new(&repository, entry.number as u32, &entry.url, source)
        .with_snapshot(Some(snapshot_of(&entry, Utc::now())));
    let changed = store.link_pull_request(thread_id, link);
    LAST_SYNCED.lock().insert(
        sync_key(repo_path, &repository, entry.number as u32),
        now_ms(),
    );
    Ok(SessionPullRequestsChange {
        pull_requests: links_wire(&store.pull_requests(thread_id)),
        changed,
    })
}

/// Record the pull request `pr_create` just opened from the session
/// `session_id` as a `created` link. Its snapshot is what was just sent, so
/// nothing is read; the next pass fills in the rest.
#[allow(clippy::too_many_arguments)]
pub fn record_created(
    host: &AgentHost,
    session_id: &str,
    url: &str,
    number: u64,
    title: &str,
    head_branch: &str,
    base_branch: Option<&str>,
    is_draft: bool,
) -> bool {
    let (Some(thread_id), Some(repository), Ok(store)) = (
        thread_for_session(host, session_id),
        repository_of_url(url),
        store_of(host),
    ) else {
        return false;
    };
    let now = Utc::now();
    let snapshot = PullRequestSnapshot {
        state: "open".into(),
        title: title.to_string(),
        head_branch: head_branch.to_string(),
        base_branch: base_branch.unwrap_or_default().to_string(),
        is_draft,
        updated_at: Some(now.to_rfc3339()),
        merged_at: None,
        checks_state: None,
        review_decision: None,
        comment_count: Some(0),
        synced_at: now,
    };
    let Ok(number) = u32::try_from(number) else {
        return false;
    };
    store.link_pull_request(
        thread_id,
        PullRequestLink::new(repository, number, url, PullRequestLinkSource::Created)
            .with_snapshot(Some(snapshot)),
    )
}

/// `owner/name` from a pull request's page, `https://<host>/<owner>/<name>/pull/<n>`.
pub fn repository_of_url(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let mut parts = rest.split('/');
    let _host = parts.next()?;
    let owner = parts.next().filter(|p| !p.is_empty())?;
    let name = parts.next().filter(|p| !p.is_empty())?;
    (parts.next() == Some("pull")).then(|| format!("{owner}/{name}"))
}

// ── leftover checkouts ──────────────────────────────────────────────────

/// How long after launch the leftover sweep waits, so it never competes with
/// startup for the disk.
const LEFTOVER_SWEEP_DELAY: std::time::Duration = std::time::Duration::from_secs(90);

/// Once per launch, after [`LEFTOVER_SWEEP_DELAY`]: remove the pull-request
/// Fix worktrees no unsettled session works in and that hold nothing to lose
/// (`checkout::sweep_leftovers`), and the guide runs' folders a quit or crash
/// left behind. Skipped when session history is unavailable, since then
/// every worktree would look unused.
pub fn sweep_leftover_checkouts_later(host: Arc<AgentHost>, app_data: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LEFTOVER_SWEEP_DELAY).await;
        let Some(history) = host.history() else {
            return;
        };
        let live: Vec<std::path::PathBuf> = history
            .store()
            .threads()
            .iter()
            .filter(|t| !t.is_settled())
            .flat_map(|t| t.folder_paths().paths().to_vec())
            .collect();
        super::pull_requests::checkout::sweep_leftovers(
            &app_data,
            &live,
            std::time::SystemTime::now(),
        )
        .await;
        super::pull_requests::guide::remove_stale_run_dirs(&app_data, now_ms());
    });
}

// ── the agent's pull request tools ──────────────────────────────────────

/// What the code tool server's pull request tools ask the host. A trait so
/// the tool server stays testable without a host. Each resolves to the text
/// the agent is told; `Err` is a request that could not be done (no such
/// pull request, `gh` signed out, a settled session).
///
/// `repository` is the one the agent named, `None` for the session's own:
/// the linked pull request with that number, else the checkout's
/// repository.
pub trait PullRequestBroker: Send + Sync {
    /// Link pull request `number` to session `session_id`. A named
    /// repository must be the repository of `cwd`, the session's checkout.
    fn link(
        &self,
        session_id: String,
        cwd: String,
        repository: Option<String>,
        number: u64,
    ) -> BoxFuture<'static, Result<String, String>>;

    /// Unlink it. Unlinking one that is not linked succeeds and says so.
    fn unlink(
        &self,
        session_id: String,
        cwd: String,
        repository: Option<String>,
        number: u64,
    ) -> BoxFuture<'static, Result<String, String>>;

    /// The session's linked pull requests with their last known state, and
    /// how they stack (by base branch, bottom to top).
    fn list(&self, session_id: String) -> BoxFuture<'static, Result<String, String>>;

    /// Start (`watching`) or stop watching it. Starting links it first when
    /// it is not linked; a settled session, a pull request that is not open,
    /// or watching switched off in Settings refuses.
    fn watch(
        &self,
        session_id: String,
        cwd: String,
        repository: Option<String>,
        number: u64,
        watching: bool,
    ) -> BoxFuture<'static, Result<String, String>>;
}

/// Whether "Let agents watch pull requests" is on, read at each call.
pub type WakesGate = Arc<dyn Fn() -> bool + Send + Sync>;

/// The host's broker. Weak, as `HostAccessBroker` is.
pub struct HostPullRequestBroker {
    pub host: Weak<AgentHost>,
    pub wakes_on: WakesGate,
}

impl HostPullRequestBroker {
    fn session(&self, session_id: &str) -> Result<(Arc<AgentHost>, ThreadId), String> {
        let host = self.host.upgrade().ok_or("Atlas is shutting down.")?;
        let thread_id = thread_for_session(&host, session_id)
            .ok_or("This session has no history row yet; send a message first.")?;
        Ok((host, thread_id))
    }
}

/// The `(repository, number)` a tool call means: the named repository, else
/// the session's linked pull request with that number, else the checkout's
/// repository.
async fn resolve_target(
    host: &AgentHost,
    thread_id: ThreadId,
    cwd: &str,
    repository: Option<String>,
    number: u64,
) -> Result<(String, u32), String> {
    let number = u32::try_from(number).map_err(|_| format!("#{number} is not a pull request"))?;
    if let Some(named) = repository {
        return Ok((named, number));
    }
    let linked: Vec<String> = store_of(host)
        .map(|store| {
            visible_pull_requests(&store.pull_requests(thread_id))
                .filter(|l| l.number == number)
                .map(|l| l.repository.clone())
                .collect()
        })
        .unwrap_or_default();
    if let [only] = linked.as_slice() {
        return Ok((only.clone(), number));
    }
    let checkout = GitHub::open(cwd)
        .await
        .map_err(|e| agent_text(&e))?
        .provider()
        .repository;
    Ok((checkout, number))
}

/// Link `number` for the agent: the named repository checked against the
/// checkout first. Answers the change and the pull request's title.
async fn agent_link(
    host: &AgentHost,
    thread_id: ThreadId,
    cwd: &str,
    repository: Option<&str>,
    number: u64,
) -> Result<(SessionPullRequestsChange, String), String> {
    if let Some(named) = repository {
        let checkout = GitHub::open(cwd)
            .await
            .map_err(|e| agent_text(&e))?
            .provider()
            .repository;
        if !checkout.eq_ignore_ascii_case(named) {
            return Err(format!(
                "This session's checkout is {checkout}, not {named}. Only pull requests \
                 of the session's own repository can be linked."
            ));
        }
    }
    let change = link_by_number(host, thread_id, cwd, number, PullRequestLinkSource::Agent)
        .await
        .map_err(|e| agent_text(&e))?;
    let title = change
        .pull_requests
        .iter()
        .find(|l| u64::from(l.number) == number)
        .and_then(|l| l.snapshot.as_ref())
        .map(|s| format!(" ({})", s.title))
        .unwrap_or_default();
    Ok((change, title))
}

/// ` (title)` for a linked pull request, or nothing.
fn title_of(link: &PullRequestLink) -> String {
    link.snapshot
        .as_ref()
        .map(|s| format!(" ({})", s.title))
        .unwrap_or_default()
}

impl PullRequestBroker for HostPullRequestBroker {
    fn link(
        &self,
        session_id: String,
        cwd: String,
        repository: Option<String>,
        number: u64,
    ) -> BoxFuture<'static, Result<String, String>> {
        let session = self.session(&session_id);
        Box::pin(async move {
            let (host, thread_id) = session?;
            let (change, title) =
                agent_link(&host, thread_id, &cwd, repository.as_deref(), number).await?;
            Ok(if change.changed {
                format!(
                    "Linked pull request #{number}{title} to this session. Atlas shows its state \
                     and checks beside the session, keeps them current, and settles the session \
                     when it merges. To be woken when its checks or comments change, call \
                     watch_pull_request."
                )
            } else {
                format!("Pull request #{number}{title} was already linked to this session.")
            })
        })
    }

    fn unlink(
        &self,
        session_id: String,
        cwd: String,
        repository: Option<String>,
        number: u64,
    ) -> BoxFuture<'static, Result<String, String>> {
        let session = self.session(&session_id);
        Box::pin(async move {
            let (host, thread_id) = session?;
            let (repository, number) =
                resolve_target(&host, thread_id, &cwd, repository, number).await?;
            let store = store_of(&host).map_err(|e| agent_text(&e))?;
            Ok(
                if store.unlink_pull_request(thread_id, &repository, number) {
                    format!("Unlinked pull request {repository}#{number} from this session.")
                } else {
                    format!("Pull request {repository}#{number} was not linked to this session.")
                },
            )
        })
    }

    fn list(&self, session_id: String) -> BoxFuture<'static, Result<String, String>> {
        let session = self.session(&session_id);
        Box::pin(async move {
            let (host, thread_id) = session?;
            let store = store_of(&host).map_err(|e| agent_text(&e))?;
            Ok(list_text(&store.pull_requests(thread_id)))
        })
    }

    fn watch(
        &self,
        session_id: String,
        cwd: String,
        repository: Option<String>,
        number: u64,
        watching: bool,
    ) -> BoxFuture<'static, Result<String, String>> {
        let session = self.session(&session_id);
        let wakes_on = (self.wakes_on)();
        Box::pin(async move {
            let (host, thread_id) = session?;
            if !watching {
                let (repository, number) =
                    resolve_target(&host, thread_id, &cwd, repository, number).await?;
                let store = store_of(&host).map_err(|e| agent_text(&e))?;
                return Ok(
                    if store.set_pull_request_watch(thread_id, &repository, number, false) {
                        format!(
                            "Stopped watching pull request {repository}#{number}. It stays \
                             linked to this session."
                        )
                    } else {
                        format!("Atlas was not watching pull request {repository}#{number}.")
                    },
                );
            }
            if !wakes_on {
                return Err("Watching pull requests is switched off in Settings.".into());
            }
            if store_of(&host)
                .ok()
                .and_then(|s| s.thread(thread_id))
                .is_some_and(|t| t.is_settled())
            {
                return Err(
                    "This session is settled. Unsettle it before watching a pull request.".into(),
                );
            }
            let (repository, number) =
                resolve_target(&host, thread_id, &cwd, repository, number).await?;
            let store = store_of(&host).map_err(|e| agent_text(&e))?;
            let linked = visible_pull_requests(&store.pull_requests(thread_id))
                .any(|l| l.is(&repository, number));
            if !linked {
                agent_link(&host, thread_id, &cwd, Some(&repository), u64::from(number)).await?;
            }
            check_watchable(store, thread_id, &repository, number, true)
                .map_err(|e| agent_text(&e))?;
            let changed = store.set_pull_request_watch(thread_id, &repository, number, true);
            let title = store
                .pull_requests(thread_id)
                .iter()
                .find(|l| l.is(&repository, number))
                .map(title_of)
                .unwrap_or_default();
            Ok(if changed {
                format!(
                    "Atlas is now watching pull request {repository}#{number}{title}. It reads it \
                     every two minutes and sends you a message when a check fails, the required \
                     checks pass, someone else comments or reviews, or the branch starts to \
                     conflict. Only comments posted from now on wake you, so handle the existing \
                     ones first, then end your turn."
                )
            } else {
                format!("Atlas was already watching pull request {repository}#{number}{title}.")
            })
        })
    }
}

/// `list_session_pull_requests`'s answer: one line a pull request, then its
/// stacks.
pub(crate) fn list_text(links: &[PullRequestLink]) -> String {
    let visible: Vec<&PullRequestLink> = visible_pull_requests(links).collect();
    if visible.is_empty() {
        return "No pull requests are linked to this session. Call link_pull_request for each \
                one you open or work on."
            .into();
    }
    let mut out = String::new();
    for link in &visible {
        out.push_str(&format!("- {}#{}", link.repository, link.number));
        if let Some(s) = &link.snapshot {
            out.push_str(&format!(" \"{}\": {}", s.title, s.state));
            if s.is_draft {
                out.push_str(" (draft)");
            }
            if let Some(checks) = &s.checks_state {
                out.push_str(&format!(", checks {checks}"));
            }
            if let Some(review) = &s.review_decision {
                out.push_str(&format!(", review {review}"));
            }
            if !s.head_branch.is_empty() {
                out.push_str(&format!(", {} -> {}", s.head_branch, s.base_branch));
            }
        } else {
            out.push_str(": not read yet");
        }
        if link.is_watched() {
            out.push_str(", watched");
        }
        out.push_str(&format!(" {}\n", link.url));
    }
    for chain in stacks(&visible) {
        let numbers: Vec<String> = chain.iter().map(|n| format!("#{n}")).collect();
        out.push_str(&format!(
            "Stack (bottom to top): {}\n",
            numbers.join(" -> ")
        ));
    }
    out.trim_end().to_owned()
}

/// The pull requests that build on one another, bottom to top: one whose
/// base branch is another's head branch, in the same repository, sits on
/// it. Only stacks of two or more.
pub(crate) fn stacks(links: &[&PullRequestLink]) -> Vec<Vec<u32>> {
    let branches = |l: &PullRequestLink| {
        l.snapshot
            .as_ref()
            .map(|s| (s.head_branch.clone(), s.base_branch.clone()))
            .filter(|(head, _)| !head.is_empty())
    };
    let parent_of = |link: &PullRequestLink| -> Option<u32> {
        let (_, base) = branches(link)?;
        links
            .iter()
            .find(|other| {
                other.number != link.number
                    && other.repository.eq_ignore_ascii_case(&link.repository)
                    && branches(other).is_some_and(|(head, _)| head == base)
            })
            .map(|other| other.number)
    };
    let mut chains = Vec::new();
    for root in links.iter().filter(|l| parent_of(l).is_none()) {
        let mut chain = vec![root.number];
        let mut seen: HashSet<u32> = HashSet::from([root.number]);
        let mut current = root.number;
        while let Some(child) = links.iter().find(|l| {
            !seen.contains(&l.number)
                && l.repository.eq_ignore_ascii_case(&root.repository)
                && parent_of(l) == Some(current)
        }) {
            seen.insert(child.number);
            chain.push(child.number);
            current = child.number;
        }
        if chain.len() > 1 {
            chains.push(chain);
        }
    }
    chains
}

/// A pull-request failure, in words for the agent.
fn agent_text(error: &PrError) -> String {
    match error {
        PrError::NotInstalled => "The GitHub CLI (gh) is not installed.".into(),
        PrError::NotAuthenticated => "The GitHub CLI is not signed in (`gh auth login`).".into(),
        PrError::RateLimited { .. } => "GitHub's rate limit was reached; try again later.".into(),
        PrError::NotFound => "No such pull request in this session's repository.".into(),
        PrError::Network { message }
        | PrError::Unsupported { message }
        | PrError::Invalid { message }
        | PrError::Failed { message } => message.clone(),
        PrError::GraphqlErrors { .. } => "GitHub refused the request.".into(),
    }
}

// ── the sweep ───────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn sync_key(checkout: &str, repository: &str, number: u32) -> String {
    format!("{checkout}\0{}#{number}", repository.to_ascii_lowercase())
}

fn state_word(state: PrState) -> &'static str {
    match state {
        PrState::Open => "open",
        PrState::Closed => "closed",
        PrState::Merged => "merged",
    }
}

fn checks_word(state: PrChecksState) -> &'static str {
    match state {
        PrChecksState::Passing => "passing",
        PrChecksState::Failing => "failing",
        PrChecksState::Pending => "pending",
    }
}

fn review_word(decision: PrReviewDecision) -> &'static str {
    match decision {
        PrReviewDecision::Approved => "approved",
        PrReviewDecision::ChangesRequested => "changes-requested",
        PrReviewDecision::ReviewRequired => "review-required",
    }
}

/// A listing row as a link's snapshot.
pub fn snapshot_of(entry: &PrListEntry, synced_at: DateTime<Utc>) -> PullRequestSnapshot {
    PullRequestSnapshot {
        state: state_word(entry.state).to_string(),
        title: entry.title.clone(),
        head_branch: entry.head_branch.clone(),
        base_branch: entry.base_branch.clone(),
        is_draft: entry.is_draft,
        updated_at: Some(entry.updated_at.clone()).filter(|u| !u.is_empty()),
        merged_at: entry.merged_at.clone().filter(|m| !m.is_empty()),
        checks_state: entry.checks_state.map(|c| checks_word(c).to_string()),
        review_decision: entry.review_decision.map(|r| review_word(r).to_string()),
        comment_count: Some(entry.comment_count),
        synced_at,
    }
}

/// Whether a link is due a read, given when it was last read.
pub fn is_due(link: &PullRequestLink, last_synced: Option<i64>, now: i64) -> bool {
    let Some(snapshot) = &link.snapshot else {
        return true;
    };
    let since = last_synced.map_or(i64::MAX, |at| now.saturating_sub(at));
    match snapshot.state.as_str() {
        "merged" => false,
        "open" => {
            let quiet = snapshot
                .updated_at
                .as_deref()
                .and_then(|u| DateTime::parse_from_rfc3339(u).ok())
                .is_some_and(|u| now - u.timestamp_millis() >= QUIET_AFTER_MS);
            !quiet || since >= QUIET_SYNC_INTERVAL_MS
        }
        _ => since >= SLOW_SYNC_INTERVAL_MS,
    }
}

/// Whether a pull request found on a session's branch belongs to it: an open
/// one always; a closed or merged one only when it moved after the session
/// began, so a reused branch name does not link old work.
pub fn belongs_to_session(entry: &PrListEntry, created_at: Option<DateTime<Utc>>) -> bool {
    if entry.state == PrState::Open {
        return true;
    }
    let (Some(created), Ok(updated)) =
        (created_at, DateTime::parse_from_rfc3339(&entry.updated_at))
    else {
        return false;
    };
    updated.with_timezone(&Utc) >= created
}

/// Whether a pull request found by the branch search is the session's: its
/// head is `branch` in the checkout's own `repository`. A fork's branch of the
/// same name is not, and neither is one whose head repository is gone.
pub fn is_detected_on_branch(entry: &PrListEntry, branch: &str, repository: &str) -> bool {
    entry.head_branch == branch
        && !entry.is_cross_repository
        && entry
            .head_repository
            .as_deref()
            .is_some_and(|r| r.eq_ignore_ascii_case(repository))
}

/// Whether a session's branch is looked up at all: never the repository's
/// default branch, which every pull request merges into and none comes from.
pub fn detects_on(branch: &str, default_branch: Option<&str>) -> bool {
    !branch.is_empty() && default_branch != Some(branch)
}

/// How long a link that did not come back `misses` passes in a row waits.
pub fn missing_backoff_ms(misses: u32) -> i64 {
    let doublings = misses.saturating_sub(1).min(16);
    (MISSING_BACKOFF_MS.saturating_mul(1_i64 << doublings)).min(MISSING_BACKOFF_MAX_MS)
}

/// Whether a link that went missing is still waiting out its backoff.
fn is_backed_off(key: &str, now: i64) -> bool {
    MISSING
        .lock()
        .get(key)
        .is_some_and(|&(_, until)| until > now)
}

/// Note a pass's due links that did not come back, and forget the ones that did.
fn note_missing(keys_missing: &[String], keys_found: &[String], now: i64) {
    let mut missing = MISSING.lock();
    for key in keys_found {
        missing.remove(key);
    }
    for key in keys_missing {
        let misses = missing.get(key).map_or(1, |&(n, _)| n.saturating_add(1));
        missing.insert(key.clone(), (misses, now + missing_backoff_ms(misses)));
    }
}

fn hold_for_rate_limit(retry_at: Option<i64>, now: i64) -> PrError {
    let until = retry_at
        .filter(|at| *at > now)
        .unwrap_or(now + RATE_LIMIT_FALLBACK_MS);
    let mut paused = PAUSED_UNTIL.lock();
    *paused = (paused.0.max(until), false);
    PrError::RateLimited {
        retry_at: Some(paused.0),
    }
}

/// The sweep stopped at the quota's reserve, which GitHub did not ask for:
/// later passes wait for the reset quietly, and nothing tells the frontend's
/// gh gate, which would hold the user's own reads back too.
fn hold_for_reserve(retry_at: Option<i64>, now: i64) {
    let until = retry_at
        .filter(|at| *at > now)
        .unwrap_or(now + RATE_LIMIT_FALLBACK_MS);
    let mut paused = PAUSED_UNTIL.lock();
    if paused.0 <= now || paused.1 {
        *paused = (until, true);
    }
}

/// A failure that every checkout would hit stops the pass; one that is
/// this checkout's own (a remote that is not GitHub, an unreachable host)
/// skips it.
fn stops_the_pass(error: &PrError) -> bool {
    matches!(
        error,
        PrError::NotInstalled | PrError::NotAuthenticated | PrError::RateLimited { .. }
    )
}

fn checkout_of(thread: &ThreadMetadata) -> Option<String> {
    thread
        .folder_paths()
        .paths()
        .first()
        .map(|p| p.to_string_lossy().into_owned())
}

async fn sweep(
    host: &AgentHost,
    wanted: Option<&HashSet<ThreadId>>,
    force: bool,
    now: i64,
) -> Result<SessionPullRequestsSync, PrError> {
    let (paused, reserve_only) = *PAUSED_UNTIL.lock();
    if paused > now {
        if reserve_only {
            return Ok(SessionPullRequestsSync {
                skipped: true,
                ..Default::default()
            });
        }
        return Err(PrError::RateLimited {
            retry_at: Some(paused),
        });
    }
    let Some(_pass) = SweepPass::claim() else {
        return Ok(SessionPullRequestsSync {
            skipped: true,
            ..Default::default()
        });
    };
    let store = store_of(host)?;
    let mut threads: Vec<ThreadMetadata> = store
        .threads()
        .into_iter()
        .filter(|t| !t.is_settled() && !t.is_draft())
        .filter(|t| wanted.is_none_or(|w| w.contains(&t.thread_id)))
        .collect();
    threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
    threads.truncate(MAX_SESSIONS_PER_PASS);

    let mut by_checkout: HashMap<String, Vec<ThreadMetadata>> = HashMap::new();
    for thread in threads {
        if let Some(checkout) = checkout_of(&thread) {
            by_checkout.entry(checkout).or_default().push(thread);
        }
    }

    let mut report = SessionPullRequestsSync::default();
    let mut changed: HashSet<ThreadId> = HashSet::new();
    for (checkout, threads) in by_checkout {
        match sweep_checkout(store, &checkout, &threads, force, now, &mut report).await {
            Ok(touched) => changed.extend(touched),
            // Held back at the reserve: GitHub has not refused anything.
            Err(PrError::RateLimited { retry_at }) if quota_paused_until(now).is_none() => {
                hold_for_reserve(retry_at, now);
                break;
            }
            Err(PrError::RateLimited { retry_at }) => {
                return Err(hold_for_rate_limit(retry_at, now));
            }
            Err(e) if stops_the_pass(&e) => return Err(e),
            Err(e) => {
                tracing::debug!(error = ?std::mem::discriminant(&e), "pull request sweep skipped a checkout");
            }
        }
    }
    report.changed = changed.len();
    Ok(report)
}

/// Detect and sync for one checkout's sessions. Answers the sessions whose
/// links changed.
async fn sweep_checkout(
    store: &ThreadMetadataStore,
    checkout: &str,
    threads: &[ThreadMetadata],
    force: bool,
    now: i64,
    report: &mut SessionPullRequestsSync,
) -> Result<HashSet<ThreadId>, PrError> {
    let wants_detection = threads.iter().any(|t| t.branch.is_some());
    let has_links = threads
        .iter()
        .any(|t| visible_pull_requests(&t.pull_requests).next().is_some());
    if !wants_detection && !has_links {
        return Ok(HashSet::new());
    }
    let github = GitHub::open_with(checkout, SWEEP_POLICY).await?;
    let repository = github.provider().repository;
    let default_branch = github.default_branch().map(str::to_string);
    let synced_at = Utc::now();
    let mut touched = HashSet::new();
    // Read this pass, by number: detection's rows count as reads.
    let mut fresh: HashMap<u32, PrListEntry> = HashMap::new();

    // Detect, once per branch.
    let mut branches: Vec<&str> = threads
        .iter()
        .filter_map(|t| t.branch.as_deref())
        .filter(|b| detects_on(b, default_branch.as_deref()))
        .collect();
    branches.sort_unstable();
    branches.dedup();
    for branch in branches {
        let key = format!("{checkout}\0{branch}");
        let held = DETECTED
            .lock()
            .get(&key)
            .filter(|(at, _)| now - at < DETECT_TTL_MS)
            .map(|(_, rows)| rows.clone());
        let rows = match held {
            Some(rows) => rows,
            None => {
                let page = github
                    .list(&PrListQuery {
                        state: Some(PrListState::All),
                        head: Some(branch.to_string()),
                        limit: Some(DETECT_LIMIT),
                        ..PrListQuery::default()
                    })
                    .await?;
                report.read += page.entries.len();
                for entry in &page.entries {
                    fresh.insert(entry.number as u32, entry.clone());
                }
                DETECTED.lock().insert(key, (now, page.entries.clone()));
                page.entries
            }
        };
        for thread in threads
            .iter()
            .filter(|t| t.branch.as_deref() == Some(branch))
        {
            let found: Vec<PullRequestLink> = rows
                .iter()
                .filter(|e| {
                    is_detected_on_branch(e, branch, &repository)
                        && belongs_to_session(e, thread.created_at)
                })
                .map(|e| {
                    PullRequestLink::new(
                        &repository,
                        e.number as u32,
                        &e.url,
                        PullRequestLinkSource::Detected,
                    )
                    .with_snapshot(Some(snapshot_of(e, synced_at)))
                })
                .collect();
            let before = store.pull_requests(thread.thread_id).len();
            if !found.is_empty() && store.link_detected_pull_requests(thread.thread_id, found) {
                report.detected += store.pull_requests(thread.thread_id).len() - before;
                touched.insert(thread.thread_id);
            }
        }
    }

    // Sync what is due: this checkout's repository only — a link into
    // another repository is read from a checkout of it.
    let mut due: Vec<u64> = Vec::new();
    {
        let last = LAST_SYNCED.lock();
        for thread in threads {
            for link in store.pull_requests(thread.thread_id).iter() {
                if !link.is_visible() || !link.repository.eq_ignore_ascii_case(&repository) {
                    continue;
                }
                if fresh.contains_key(&link.number) {
                    continue;
                }
                let key = sync_key(checkout, &repository, link.number);
                // Gone the last time it was asked: not every pass, forced or not.
                if is_backed_off(&key, now) {
                    continue;
                }
                let held = last.get(&key).copied();
                if force || is_due(link, held, now) {
                    due.push(u64::from(link.number));
                }
            }
        }
    }
    due.sort_unstable();
    due.dedup();
    if !due.is_empty() {
        let rows = github.entries(&due).await?;
        report.read += rows.len();
        for entry in rows {
            fresh.insert(entry.number as u32, entry);
        }
        // A number that did not come back (deleted, or no longer visible)
        // is backed off rather than asked every pass — an open link is due
        // every pass, so its cadence alone would not slow it.
        let (found, gone): (Vec<u64>, Vec<u64>) =
            due.iter().partition(|n| fresh.contains_key(&(**n as u32)));
        let key = |n: &u64| sync_key(checkout, &repository, *n as u32);
        note_missing(
            &gone.iter().map(key).collect::<Vec<_>>(),
            &found.iter().map(key).collect::<Vec<_>>(),
            now,
        );
        let mut last = LAST_SYNCED.lock();
        for number in &due {
            last.insert(sync_key(checkout, &repository, *number as u32), now);
        }
    }

    for (number, entry) in &fresh {
        LAST_SYNCED
            .lock()
            .insert(sync_key(checkout, &repository, *number), now);
        if store.sync_pull_request(&repository, *number, &snapshot_of(entry, synced_at)) > 0 {
            touched.extend(
                threads
                    .iter()
                    .filter(|t| t.pull_requests.iter().any(|l| l.is(&repository, *number)))
                    .map(|t| t.thread_id),
            );
        }
    }
    Ok(touched)
}

#[cfg(test)]
mod tests {
    use super::super::pull_requests::PrMergeability;
    use super::*;

    fn entry(state: PrState, updated_at: &str) -> PrListEntry {
        PrListEntry {
            number: 7,
            title: "Add discounts".into(),
            url: "https://github.com/acme/shop/pull/7".into(),
            author: None,
            head_branch: "feature".into(),
            base_branch: "main".into(),
            state,
            is_draft: false,
            mergeability: PrMergeability::Mergeable,
            additions: 1,
            deletions: 1,
            created_at: "2026-10-01T00:00:00Z".into(),
            updated_at: updated_at.into(),
            merged_at: None,
            viewer_review_requested: false,
            labels: vec![],
            review_decision: Some(PrReviewDecision::Approved),
            checks_state: Some(PrChecksState::Failing),
            comment_count: 3,
            head_repository: Some("acme/shop".into()),
            is_cross_repository: false,
        }
    }

    fn stacked(number: u32, head: &str, base: &str) -> PullRequestLink {
        let mut link = PullRequestLink::new(
            "acme/shop",
            number,
            format!("https://github.com/acme/shop/pull/{number}"),
            PullRequestLinkSource::Agent,
        );
        link.snapshot = Some(PullRequestSnapshot {
            state: "open".into(),
            title: format!("Step {number}"),
            head_branch: head.into(),
            base_branch: base.into(),
            is_draft: false,
            updated_at: None,
            merged_at: None,
            checks_state: Some("passing".into()),
            review_decision: None,
            comment_count: None,
            synced_at: Utc::now(),
        });
        link
    }

    #[test]
    fn pull_requests_built_on_one_another_list_as_a_stack_bottom_to_top() {
        // Linked out of order: #3 sits on #1, #2 on #3; #9 stands alone.
        let links = [
            stacked(2, "c", "b"),
            stacked(9, "other", "main"),
            stacked(1, "a", "main"),
            stacked(3, "b", "a"),
        ];
        let refs: Vec<&PullRequestLink> = links.iter().collect();
        assert_eq!(stacks(&refs), vec![vec![1, 3, 2]]);
        let text = list_text(&links);
        assert!(text.contains("acme/shop#9 \"Step 9\": open, checks passing, other -> main"));
        assert!(
            text.ends_with("Stack (bottom to top): #1 -> #3 -> #2"),
            "{text}"
        );
    }

    #[test]
    fn an_empty_list_tells_the_agent_to_link() {
        assert!(list_text(&[]).contains("link_pull_request"));
    }

    #[test]
    fn only_the_checkout_s_own_branch_is_detected_never_a_fork_s() {
        let own = entry(PrState::Open, "2026-10-20T00:00:00Z");
        assert!(is_detected_on_branch(&own, "feature", "acme/shop"));
        assert!(is_detected_on_branch(&own, "feature", "ACME/Shop"));
        // Another branch name.
        assert!(!is_detected_on_branch(&own, "main", "acme/shop"));
        // A fork's branch of the same name: what `head:` also matches.
        let fork = PrListEntry {
            head_repository: Some("stranger/shop".into()),
            is_cross_repository: true,
            ..own.clone()
        };
        assert!(!is_detected_on_branch(&fork, "feature", "acme/shop"));
        // A deleted fork names no head repository.
        let gone = PrListEntry {
            head_repository: None,
            is_cross_repository: true,
            ..own.clone()
        };
        assert!(!is_detected_on_branch(&gone, "feature", "acme/shop"));
        // Cross-repository however the name reads.
        let odd = PrListEntry {
            is_cross_repository: true,
            ..own
        };
        assert!(!is_detected_on_branch(&odd, "feature", "acme/shop"));
    }

    #[test]
    fn the_default_branch_is_never_detected_on() {
        assert!(!detects_on("main", Some("main")));
        assert!(detects_on("feature", Some("main")));
        assert!(detects_on("main", Some("trunk")));
        assert!(detects_on("feature", None));
        assert!(!detects_on("", None));
    }

    #[test]
    fn detection_is_trusted_longer_than_a_pass() {
        // The frontend runs a pass every minute.
        const { assert!(DETECT_TTL_MS > 60_000) };
    }

    #[test]
    fn the_sweep_reads_in_the_background_and_leaves_the_reserve() {
        assert_eq!(SWEEP_POLICY, ReadPolicy::Background);
        assert!(!SWEEP_POLICY.allows_reserve());
    }

    #[test]
    fn one_pass_runs_at_a_time_and_the_claim_ends_with_it() {
        let first = SweepPass::claim().expect("no pass is running");
        assert!(SweepPass::claim().is_none());
        drop(first);
        assert!(SweepPass::claim().is_some());
    }

    #[test]
    fn a_missing_pull_request_backs_off_longer_each_miss() {
        assert_eq!(missing_backoff_ms(1), 15 * MIN);
        assert_eq!(missing_backoff_ms(2), 30 * MIN);
        assert_eq!(missing_backoff_ms(3), 60 * MIN);
        assert_eq!(missing_backoff_ms(40), 24 * 60 * MIN);

        let key = "test-checkout\0acme/shop#404".to_string();
        let back = "test-checkout\0acme/shop#405".to_string();
        note_missing(std::slice::from_ref(&key), &[], 0);
        assert!(is_backed_off(&key, 0));
        assert!(is_backed_off(&key, 15 * MIN - 1));
        assert!(!is_backed_off(&key, 15 * MIN));
        note_missing(std::slice::from_ref(&key), &[], 15 * MIN);
        assert!(is_backed_off(&key, 15 * MIN + 29 * MIN));
        // One that comes back is forgotten.
        note_missing(std::slice::from_ref(&back), &[], 0);
        note_missing(&[], &[key.clone(), back.clone()], 1);
        assert!(!is_backed_off(&key, 2));
        assert!(!is_backed_off(&back, 2));
    }

    fn link_with(state: Option<(&str, &str)>) -> PullRequestLink {
        let link = PullRequestLink::new(
            "acme/shop",
            7,
            "https://github.com/acme/shop/pull/7",
            PullRequestLinkSource::Manual,
        );
        link.with_snapshot(state.map(|(state, updated)| {
            let mut s = snapshot_of(&entry(PrState::Open, updated), Utc::now());
            s.state = state.into();
            s
        }))
    }

    const MIN: i64 = 60_000;

    fn at(rfc: &str) -> i64 {
        DateTime::parse_from_rfc3339(rfc)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn a_link_never_read_is_due_at_once() {
        assert!(is_due(
            &link_with(None),
            Some(at("2026-10-20T10:00:00Z")),
            0
        ));
    }

    #[test]
    fn an_open_pull_request_is_read_each_pass_until_it_goes_quiet() {
        let now = at("2026-10-20T10:10:00Z");
        let busy = link_with(Some(("open", "2026-10-20T10:00:00Z")));
        assert!(is_due(&busy, Some(now - MIN), now));
        let quiet = link_with(Some(("open", "2026-10-20T08:00:00Z")));
        assert!(!is_due(&quiet, Some(now - MIN), now));
        assert!(is_due(&quiet, Some(now - 5 * MIN), now));
        assert!(is_due(&quiet, None, now));
    }

    #[test]
    fn a_closed_one_is_read_slowly_and_a_merged_one_never() {
        let now = at("2026-10-20T10:00:00Z");
        let closed = link_with(Some(("closed", "2026-10-20T09:59:00Z")));
        assert!(!is_due(&closed, Some(now - 14 * MIN), now));
        assert!(is_due(&closed, Some(now - 15 * MIN), now));
        let merged = link_with(Some(("merged", "2026-10-20T09:59:00Z")));
        assert!(!is_due(&merged, None, now));
    }

    #[test]
    fn a_branch_claims_open_work_and_only_recent_closed_work() {
        let began = DateTime::parse_from_rfc3339("2026-10-10T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(belongs_to_session(
            &entry(PrState::Open, "2025-01-01T00:00:00Z"),
            Some(began)
        ));
        assert!(belongs_to_session(
            &entry(PrState::Merged, "2026-10-11T00:00:00Z"),
            Some(began)
        ));
        assert!(!belongs_to_session(
            &entry(PrState::Closed, "2025-01-01T00:00:00Z"),
            Some(began)
        ));
        assert!(!belongs_to_session(
            &entry(PrState::Merged, "2026-10-11T00:00:00Z"),
            None
        ));
    }

    #[test]
    fn a_listing_row_becomes_a_snapshot_in_the_wire_s_words() {
        let s = snapshot_of(&entry(PrState::Merged, "2026-10-11T00:00:00Z"), Utc::now());
        assert_eq!(s.state, "merged");
        assert_eq!(s.checks_state.as_deref(), Some("failing"));
        assert_eq!(s.review_decision.as_deref(), Some("approved"));
        assert_eq!(s.comment_count, Some(3));
        assert_eq!(s.merged_at, None);

        let merged = PrListEntry {
            merged_at: Some("2026-10-10T08:00:00Z".into()),
            ..entry(PrState::Merged, "2026-10-11T00:00:00Z")
        };
        let s = snapshot_of(&merged, Utc::now());
        assert_eq!(s.merged_at.as_deref(), Some("2026-10-10T08:00:00Z"));
        assert_eq!(s.done_at(), Some("2026-10-10T08:00:00Z"));
    }

    #[test]
    fn the_repository_is_read_off_a_pull_request_url() {
        assert_eq!(
            repository_of_url("https://github.com/acme/shop/pull/12").as_deref(),
            Some("acme/shop")
        );
        assert_eq!(
            repository_of_url("https://ghe.example.com/team/app/pull/3").as_deref(),
            Some("team/app")
        );
        assert_eq!(repository_of_url("https://github.com/acme/shop"), None);
        assert_eq!(repository_of_url("not a url"), None);
    }

    #[test]
    fn the_wire_hides_tombstones() {
        let mut gone = link_with(None);
        gone.source = PullRequestLinkSource::Dismissed;
        let wire = links_wire(&[link_with(None), gone]);
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0].source, "manual");
    }
}
