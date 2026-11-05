//! The pull requests linked to a session.
//!
//! A session can be tied to any number of pull requests: the one it opened,
//! the ones found on its branch, ones the user or the agent pointed at. Each
//! link remembers how it came to be ([`PullRequestLinkSource`]) and the last
//! state the host reported for it ([`PullRequestSnapshot`]), so every surface
//! can draw the pull request — its state, title, checks — without asking the
//! host first. The app's sync sweep refreshes the snapshots.
//!
//! Stored as one JSON column on the row (`pull_requests`), like the attached
//! projects: small, ridden along with the row, and never queried inside.
//!
//! A link the user removes is not deleted but tombstoned
//! ([`PullRequestLinkSource::Dismissed`]): the branch sweep would otherwise
//! find the pull request again a minute later and put it back. Every surface
//! hides tombstones ([`visible`]); linking the pull request again revives it.
//!
//! A link can also be **watched** ([`PullRequestWatch`]): the app's watch
//! reactor reads it every couple of minutes and wakes the session's agent
//! when something it should act on happens (a check fails, the gate passes,
//! someone comments, the branch conflicts). The watch carries what it has
//! already told, so a wake never repeats itself; an ended watch is kept as
//! `ended_watch`, so watching again does not repeat it either.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// How a pull request came to be linked to a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestLinkSource {
    /// The user linked it ("Link a PR…").
    Manual,
    /// Opened from the session ("Create PR").
    Created,
    /// Found on the session's branch by the sync sweep.
    Detected,
    /// The agent linked it (`link_pull_request` on the code tool server).
    Agent,
    /// Unlinked by the user. Kept so the branch sweep does not re-add it;
    /// hidden everywhere.
    Dismissed,
}

impl PullRequestLinkSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Created => "created",
            Self::Detected => "detected",
            Self::Agent => "agent",
            Self::Dismissed => "dismissed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "created" => Some(Self::Created),
            "detected" => Some(Self::Detected),
            "agent" => Some(Self::Agent),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }

    /// Someone chose this link: the user, the agent, or the session that
    /// opened it. A detected link is only an observation, and gives way to
    /// any of these.
    pub fn is_deliberate(self) -> bool {
        matches!(self, Self::Manual | Self::Created | Self::Agent)
    }
}

/// The last state the host reported for a linked pull request. Every field
/// but the state and title is optional, so an older snapshot still reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestSnapshot {
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub title: String,
    #[serde(default)]
    pub head_branch: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub is_draft: bool,
    /// When the host last saw it change (RFC 3339), as it reported it.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// When it merged (RFC 3339), as the host reported it. `None` while it
    /// is not merged, and on a snapshot stored before this was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
    /// `passing`, `failing` or `pending`; `None` when it has no checks.
    #[serde(default)]
    pub checks_state: Option<String>,
    /// `approved`, `changes-requested` or `review-required`.
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub comment_count: Option<u32>,
    /// When Atlas read it.
    pub synced_at: DateTime<Utc>,
}

impl PullRequestSnapshot {
    /// Whether `other` says anything this one does not. `synced_at` is not
    /// news: a read that found nothing new changes nothing.
    pub fn same_as(&self, other: &Self) -> bool {
        self.state == other.state
            && self.title == other.title
            && self.head_branch == other.head_branch
            && self.base_branch == other.base_branch
            && self.is_draft == other.is_draft
            && self.updated_at == other.updated_at
            && self.merged_at == other.merged_at
            && self.checks_state == other.checks_state
            && self.review_decision == other.review_decision
            && self.comment_count == other.comment_count
    }

    /// When the pull request was done, as far as this snapshot knows: the
    /// merge time for a merged one, and otherwise (closed, or merged on a
    /// snapshot stored before the merge time was kept) the host's last
    /// update time. `None` while it is open.
    pub fn done_at(&self) -> Option<&str> {
        if self.state == "open" {
            return None;
        }
        self.merged_at
            .as_deref()
            .filter(|_| self.state == "merged")
            .or(self.updated_at.as_deref())
    }
}

/// What a watch has already told the agent about a pull request, so the next
/// read wakes it only for what is new. The watch reactor's `evaluate` reads
/// one and answers the next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestWatch {
    /// When the watch began. Its identity: a reactor pass applies its result
    /// only while the same watch is still on ([`WatchSync`]), so a stop or a
    /// re-watch that lands during the host read wins.
    pub started_at: DateTime<Utc>,
    /// The head commit the checks below were read on. A push resets them.
    #[serde(default)]
    pub head_sha: Option<String>,
    /// Checks already reported failed on this head.
    #[serde(default)]
    pub failed_checks: Vec<String>,
    /// Whether "checks passed" has been reported on this head.
    #[serde(default)]
    pub passed: bool,
    /// The gate's check names when it was reported passed, so a required
    /// check that appears already passed is reported too.
    #[serde(default)]
    pub passed_checks: Vec<String>,
    /// Remarks up to this time have been told (RFC 3339, as the host spelled
    /// it).
    pub remarks_through: String,
    /// The remarks told at exactly `remarks_through`: host times are per
    /// second, so a late one at the same second is told apart by id.
    #[serde(default)]
    pub remark_ids: Vec<String>,
    /// Whether a conflict with the base has been reported.
    #[serde(default)]
    pub conflicting: bool,
    /// Wakes in a row that brought only comments; anything else resets it.
    #[serde(default)]
    pub wakes: u32,
}

impl PullRequestWatch {
    /// A fresh watch at `now`. Check and conflict news an `ended` watch
    /// already told is not told again; remarks start from now.
    pub fn starting(now: DateTime<Utc>, ended: Option<&PullRequestWatch>) -> Self {
        Self {
            started_at: now,
            head_sha: ended.and_then(|e| e.head_sha.clone()),
            failed_checks: ended.map(|e| e.failed_checks.clone()).unwrap_or_default(),
            passed: ended.is_some_and(|e| e.passed),
            passed_checks: ended.map(|e| e.passed_checks.clone()).unwrap_or_default(),
            remarks_through: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            remark_ids: Vec::new(),
            conflicting: ended.is_some_and(|e| e.conflicting),
            wakes: 0,
        }
    }
}

/// What a reactor pass decided for one watch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchSync {
    /// The watch goes on, having told this much.
    Continue(PullRequestWatch),
    /// The watch ends. `told` is what it had told by then, when the pass
    /// knows more than the watch it read.
    End { told: Option<PullRequestWatch> },
}

/// One pull request linked to a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestLink {
    /// `owner/name`, as the host spells it. With `number`, the link's
    /// identity within the session (compared without case).
    pub repository: String,
    pub number: u32,
    /// The pull request's page on the host.
    pub url: String,
    pub source: PullRequestLinkSource,
    pub linked_at: DateTime<Utc>,
    /// `None` until the host has been read.
    #[serde(default)]
    pub snapshot: Option<PullRequestSnapshot>,
    /// On while Atlas watches the pull request for this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<PullRequestWatch>,
    /// The last watch, once it ended: what it had told, so watching again
    /// does not repeat it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_watch: Option<PullRequestWatch>,
}

impl PullRequestLink {
    pub fn new(
        repository: impl Into<String>,
        number: u32,
        url: impl Into<String>,
        source: PullRequestLinkSource,
    ) -> Self {
        Self {
            repository: repository.into(),
            number,
            url: url.into(),
            source,
            linked_at: Utc::now(),
            snapshot: None,
            watch: None,
            ended_watch: None,
        }
    }

    /// Whether Atlas is watching it for the session.
    pub fn is_watched(&self) -> bool {
        self.watch.is_some() && self.is_visible()
    }

    /// End the watch, keeping what it told as `ended_watch`.
    fn end_watch(&mut self) -> bool {
        let Some(watch) = self.watch.take() else {
            return false;
        };
        self.ended_watch = Some(watch);
        true
    }

    pub fn with_snapshot(mut self, snapshot: Option<PullRequestSnapshot>) -> Self {
        self.snapshot = snapshot;
        self
    }

    /// Whether this link is `repository#number`.
    pub fn is(&self, repository: &str, number: u32) -> bool {
        self.number == number && self.repository.eq_ignore_ascii_case(repository)
    }

    pub fn is_visible(&self) -> bool {
        self.source != PullRequestLinkSource::Dismissed
    }
}

/// The links every surface shows: all but the tombstones.
pub fn visible(links: &[PullRequestLink]) -> impl Iterator<Item = &PullRequestLink> {
    links.iter().filter(|l| l.is_visible())
}

/// The entry for `repository#number`, tombstone or not.
pub(crate) fn position(links: &[PullRequestLink], repository: &str, number: u32) -> Option<usize> {
    links.iter().position(|l| l.is(repository, number))
}

/// Add `link`, or revive or strengthen the one already there. Answers whether
/// anything changed.
///
/// - absent: appended;
/// - a tombstone: revived when `link` is deliberate (the user, or the agent,
///   asked for it back), never by detection;
/// - detected, and `link` is deliberate: takes `link`'s source, so unlinking
///   it later is the user undoing their own choice;
/// - otherwise: left as it is. Linking twice is not an error.
///
/// A snapshot `link` carries fills one the entry lacks.
pub(crate) fn link(links: &mut Vec<PullRequestLink>, link: PullRequestLink) -> bool {
    let Some(ix) = position(links, &link.repository, link.number) else {
        links.push(link);
        return true;
    };
    let existing = &mut links[ix];
    let revive = existing.source == PullRequestLinkSource::Dismissed && link.source.is_deliberate();
    let strengthen =
        existing.source == PullRequestLinkSource::Detected && link.source.is_deliberate();
    if !revive && !strengthen {
        return false;
    }
    existing.source = link.source;
    if revive {
        existing.linked_at = link.linked_at;
    }
    if existing.snapshot.is_none() {
        existing.snapshot = link.snapshot;
    }
    true
}

/// Tombstone `repository#number`. Answers whether a visible link was there.
/// Unlinking ends its watch.
pub(crate) fn unlink(links: &mut [PullRequestLink], repository: &str, number: u32) -> bool {
    let Some(ix) = position(links, repository, number) else {
        return false;
    };
    let existing = &mut links[ix];
    if !existing.is_visible() {
        return false;
    }
    existing.source = PullRequestLinkSource::Dismissed;
    existing.end_watch();
    true
}

/// Start or stop watching `repository#number`. Answers whether anything
/// changed: watching one already watched, or stopping one not watched, is
/// not a change. Only a visible link can be watched.
pub(crate) fn set_watch(
    links: &mut [PullRequestLink],
    repository: &str,
    number: u32,
    watching: bool,
    now: DateTime<Utc>,
) -> bool {
    let Some(ix) = position(links, repository, number) else {
        return false;
    };
    let existing = &mut links[ix];
    if !existing.is_visible() {
        return false;
    }
    if !watching {
        return existing.end_watch();
    }
    if existing.watch.is_some() {
        return false;
    }
    existing.watch = Some(PullRequestWatch::starting(
        now,
        existing.ended_watch.as_ref(),
    ));
    true
}

/// Apply a reactor pass's result to `repository#number`, but only while the
/// watch that pass read (`started_at`) is still the one on. Answers whether
/// it applied: `false` when the watch was stopped, restarted or unlinked
/// meanwhile, which the reactor reads as "say nothing".
pub(crate) fn sync_watch(
    links: &mut [PullRequestLink],
    repository: &str,
    number: u32,
    started_at: DateTime<Utc>,
    result: WatchSync,
) -> bool {
    let Some(ix) = position(links, repository, number) else {
        return false;
    };
    let existing = &mut links[ix];
    if !existing.is_visible() || existing.watch.as_ref().map(|w| w.started_at) != Some(started_at) {
        return false;
    }
    match result {
        WatchSync::Continue(next) => existing.watch = Some(next),
        WatchSync::End { told } => {
            existing.end_watch();
            if let Some(told) = told {
                existing.ended_watch = Some(told);
            }
        }
    }
    true
}

/// End every watch in `links`. Answers whether any was on.
pub(crate) fn end_watches(links: &mut [PullRequestLink]) -> bool {
    let mut any = false;
    for link in links.iter_mut() {
        any |= link.end_watch();
    }
    any
}

/// Record a fresh read of `repository#number`. Answers whether it said
/// anything new (a tombstone takes the snapshot too, silently: it is not
/// shown, but keeps the branch name the sweep matches on).
pub(crate) fn sync(
    links: &mut [PullRequestLink],
    repository: &str,
    number: u32,
    snapshot: PullRequestSnapshot,
) -> bool {
    let Some(ix) = position(links, repository, number) else {
        return false;
    };
    let existing = &mut links[ix];
    if existing
        .snapshot
        .as_ref()
        .is_some_and(|held| held.same_as(&snapshot))
    {
        return false;
    }
    existing.snapshot = Some(snapshot);
    true
}

/// The column's text: `None` (SQL `NULL`) when empty, so a session with no
/// links reads exactly like a row from before the column.
pub(crate) fn encode(links: &[PullRequestLink]) -> Option<String> {
    if links.is_empty() {
        return None;
    }
    serde_json::to_string(links).ok()
}

/// The list a column holds. Unreadable text decodes to nothing rather than
/// failing the row: a lost link is found again by the sweep, or linked again.
pub(crate) fn decode(text: Option<String>) -> Vec<PullRequestLink> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<PullRequestLink>>(&text) {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!(error = %e, "unreadable pull_requests column; treating it as empty");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(state: &str, title: &str) -> PullRequestSnapshot {
        PullRequestSnapshot {
            state: state.into(),
            title: title.into(),
            head_branch: "feature".into(),
            base_branch: "main".into(),
            is_draft: false,
            updated_at: Some("2026-10-20T10:00:00Z".into()),
            merged_at: None,
            checks_state: Some("passing".into()),
            review_decision: None,
            comment_count: Some(2),
            synced_at: Utc::now(),
        }
    }

    fn pr(number: u32, source: PullRequestLinkSource) -> PullRequestLink {
        PullRequestLink::new(
            "acme/shop",
            number,
            format!("https://github.com/acme/shop/pull/{number}"),
            source,
        )
    }

    #[test]
    fn a_merge_is_dated_by_its_merge_time_and_else_by_the_last_update() {
        let mut merged = snapshot("merged", "Ship it");
        merged.merged_at = Some("2026-10-19T08:00:00Z".into());
        assert_eq!(merged.done_at(), Some("2026-10-19T08:00:00Z"));

        // A snapshot stored before the merge time was kept.
        merged.merged_at = None;
        assert_eq!(merged.done_at(), Some("2026-10-20T10:00:00Z"));

        let closed = snapshot("closed", "Never mind");
        assert_eq!(closed.done_at(), Some("2026-10-20T10:00:00Z"));
        assert_eq!(snapshot("open", "Still going").done_at(), None);
    }

    #[test]
    fn a_snapshot_stored_without_a_merge_time_still_reads() {
        let old = r#"{"state":"merged","title":"Old","updated_at":"2026-10-20T10:00:00Z","synced_at":"2026-10-20T10:01:00Z"}"#;
        let snapshot: PullRequestSnapshot = serde_json::from_str(old).unwrap();
        assert_eq!(snapshot.merged_at, None);
        assert_eq!(snapshot.done_at(), Some("2026-10-20T10:00:00Z"));
        // And one without a merge time writes none.
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("merged_at"));
    }

    #[test]
    fn an_empty_list_is_stored_as_null_and_null_reads_as_empty() {
        assert_eq!(encode(&[]), None);
        assert!(decode(None).is_empty());
        assert!(decode(Some("  ".into())).is_empty());
        assert!(decode(Some("{not json".into())).is_empty());
    }

    #[test]
    fn a_list_round_trips_through_its_column() {
        let list = vec![
            pr(1, PullRequestLinkSource::Created)
                .with_snapshot(Some(snapshot("open", "Add discounts"))),
            pr(2, PullRequestLinkSource::Dismissed),
        ];
        assert_eq!(decode(encode(&list)), list);
    }

    #[test]
    fn identity_ignores_the_repository_s_case() {
        let link = pr(7, PullRequestLinkSource::Manual);
        assert!(link.is("ACME/Shop", 7));
        assert!(!link.is("acme/shop", 8));
    }

    #[test]
    fn linking_appends_revives_and_strengthens_but_never_weakens() {
        let mut links = vec![];
        assert!(link(&mut links, pr(1, PullRequestLinkSource::Detected)));
        // Detected again: nothing new.
        assert!(!link(&mut links, pr(1, PullRequestLinkSource::Detected)));
        // The user links it: it is theirs now.
        assert!(link(&mut links, pr(1, PullRequestLinkSource::Manual)));
        assert_eq!(links[0].source, PullRequestLinkSource::Manual);
        // Detection never takes it back.
        assert!(!link(&mut links, pr(1, PullRequestLinkSource::Detected)));
        assert_eq!(links[0].source, PullRequestLinkSource::Manual);
        assert_eq!(links.len(), 1);
    }

    #[test]
    fn unlinking_tombstones_so_detection_cannot_bring_it_back() {
        let mut links = vec![pr(3, PullRequestLinkSource::Detected)];
        assert!(unlink(&mut links, "acme/shop", 3));
        assert!(!unlink(&mut links, "acme/shop", 3));
        assert_eq!(visible(&links).count(), 0);
        assert!(!link(&mut links, pr(3, PullRequestLinkSource::Detected)));
        assert_eq!(visible(&links).count(), 0);
        // A deliberate link revives it.
        assert!(link(&mut links, pr(3, PullRequestLinkSource::Agent)));
        assert_eq!(links[0].source, PullRequestLinkSource::Agent);
    }

    #[test]
    fn a_read_that_says_nothing_new_changes_nothing() {
        let mut links = vec![pr(4, PullRequestLinkSource::Created)];
        assert!(sync(&mut links, "acme/shop", 4, snapshot("open", "One")));
        let mut again = snapshot("open", "One");
        again.synced_at = Utc::now() + chrono::Duration::minutes(5);
        assert!(!sync(&mut links, "acme/shop", 4, again));
        assert!(sync(&mut links, "acme/shop", 4, snapshot("merged", "One")));
        assert!(!sync(&mut links, "acme/shop", 99, snapshot("open", "Nope")));
    }

    fn at(rfc: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_watch_starts_on_a_visible_link_and_stops_into_ended_watch() {
        let mut links = vec![pr(1, PullRequestLinkSource::Agent)];
        let now = at("2026-10-20T10:00:00Z");
        assert!(set_watch(&mut links, "acme/shop", 1, true, now));
        assert!(links[0].is_watched());
        assert_eq!(
            links[0].watch.as_ref().unwrap().remarks_through,
            "2026-10-20T10:00:00Z"
        );
        // Watching twice is watching once: the same watch stays.
        assert!(!set_watch(
            &mut links,
            "acme/shop",
            1,
            true,
            at("2026-10-20T11:00:00Z")
        ));
        assert_eq!(links[0].watch.as_ref().unwrap().started_at, now);
        assert!(set_watch(&mut links, "acme/shop", 1, false, now));
        assert!(!links[0].is_watched());
        assert_eq!(links[0].ended_watch.as_ref().unwrap().started_at, now);
        assert!(!set_watch(&mut links, "acme/shop", 1, false, now));
        assert!(!set_watch(&mut links, "acme/shop", 2, true, now));
    }

    #[test]
    fn watching_again_does_not_repeat_check_or_conflict_news() {
        let mut links = vec![pr(1, PullRequestLinkSource::Agent)];
        let first = at("2026-10-20T10:00:00Z");
        assert!(set_watch(&mut links, "acme/shop", 1, true, first));
        let mut told = links[0].watch.clone().unwrap();
        told.head_sha = Some("abc".into());
        told.failed_checks = vec!["lint".into()];
        told.conflicting = true;
        told.wakes = 9;
        told.remark_ids = vec!["r1".into()];
        assert!(sync_watch(
            &mut links,
            "acme/shop",
            1,
            first,
            WatchSync::End { told: Some(told) }
        ));
        let again = at("2026-10-20T12:00:00Z");
        assert!(set_watch(&mut links, "acme/shop", 1, true, again));
        let watch = links[0].watch.clone().unwrap();
        assert_eq!(watch.head_sha.as_deref(), Some("abc"));
        assert_eq!(watch.failed_checks, vec!["lint".to_string()]);
        assert!(watch.conflicting);
        assert_eq!(watch.wakes, 0);
        assert!(watch.remark_ids.is_empty());
        assert_eq!(watch.remarks_through, "2026-10-20T12:00:00Z");
    }

    #[test]
    fn a_pass_applies_only_to_the_watch_it_read() {
        let mut links = vec![pr(1, PullRequestLinkSource::Agent)];
        let first = at("2026-10-20T10:00:00Z");
        set_watch(&mut links, "acme/shop", 1, true, first);
        let mut next = links[0].watch.clone().unwrap();
        next.wakes = 1;
        // Stopped and started again while the pass read the host.
        set_watch(&mut links, "acme/shop", 1, false, first);
        set_watch(&mut links, "acme/shop", 1, true, at("2026-10-20T10:01:00Z"));
        assert!(!sync_watch(
            &mut links,
            "acme/shop",
            1,
            first,
            WatchSync::Continue(next.clone())
        ));
        assert_eq!(links[0].watch.as_ref().unwrap().wakes, 0);
        // Unlinked: the watch ends and nothing is left to apply to.
        let current = links[0].watch.as_ref().unwrap().started_at;
        assert!(unlink(&mut links, "acme/shop", 1));
        assert!(!links[0].is_watched());
        assert!(!sync_watch(
            &mut links,
            "acme/shop",
            1,
            current,
            WatchSync::Continue(next)
        ));
    }

    #[test]
    fn a_link_without_a_watch_writes_exactly_as_before() {
        let link = pr(1, PullRequestLinkSource::Manual);
        let text = serde_json::to_string(&link).unwrap();
        assert!(!text.contains("watch"), "{text}");
        let mut watched = vec![link];
        set_watch(&mut watched, "acme/shop", 1, true, Utc::now());
        assert_eq!(decode(encode(&watched)), watched);
    }

    #[test]
    fn ending_every_watch_says_whether_one_was_on() {
        let mut links = vec![
            pr(1, PullRequestLinkSource::Agent),
            pr(2, PullRequestLinkSource::Manual),
        ];
        assert!(!end_watches(&mut links));
        set_watch(&mut links, "acme/shop", 2, true, Utc::now());
        assert!(end_watches(&mut links));
        assert!(links.iter().all(|l| !l.is_watched()));
    }

    #[test]
    fn the_wire_names_are_snake_case() {
        assert_eq!(
            serde_json::to_string(&PullRequestLinkSource::Detected).unwrap(),
            "\"detected\""
        );
        for source in [
            PullRequestLinkSource::Manual,
            PullRequestLinkSource::Created,
            PullRequestLinkSource::Detected,
            PullRequestLinkSource::Agent,
            PullRequestLinkSource::Dismissed,
        ] {
            assert_eq!(PullRequestLinkSource::parse(source.as_str()), Some(source));
        }
        assert_eq!(PullRequestLinkSource::parse("stack"), None);
    }
}
