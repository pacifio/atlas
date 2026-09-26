//! The recorded work: `org_sessions` and `org_session`.

use atlas_artifacts::{RemoteEntry, RemoteSession};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use rmcp::model::CallToolResult;
use serde_json::{json, Value};

use super::super::cloud::{BoardQuery, CloudError, PayloadRef, TimelineQuery};
use super::super::OrgScope;
use super::{checked_id, resolve_member, tool_error, tool_json, NamedSession, OrgTools};
use crate::commands::memory_server::Grant;
/// How far back `org_sessions` looks when it is given neither `since` nor
/// `until`: "what happened lately" without walking the whole board.
pub(in crate::commands::org_server) const SESSIONS_DEFAULT_WINDOW_DAYS: i64 = 14;

/// The most recorded sessions one `org_sessions` call reads off the board.
/// The server narrows only by Workspace and keyword, so every other fold
/// reads rows it may throw away; this bounds that walk (five of the server's
/// largest pages), and the answer says when it was reached.
pub(in crate::commands::org_server) const SESSIONS_SCAN_CAP: usize = 500;

/// How many matches `org_sessions` lists when the model asks for no number.
pub(in crate::commands::org_server) const SESSIONS_DEFAULT_LIMIT: usize = 20;

/// The most matches one `org_sessions` answer lists.
pub(in crate::commands::org_server) const SESSIONS_MAX_LIMIT: usize = 100;

/// How many entries one `org_session` page holds when the model asks for no
/// number: enough to follow a turn or two, few enough to leave room to read.
pub(in crate::commands::org_server) const TIMELINE_DEFAULT_LIMIT: u32 = 50;

/// The parts of an entry the server keeps full text for.
const PAYLOAD_PARTS: [&str; 3] = ["body", "arguments", "result"];

/// What `org_sessions` was asked.
pub(super) struct SessionFilters<'a> {
    /// A Workspace id in the grant's organisation; the grant's when absent.
    pub(super) workspace: Option<&'a str>,
    /// A member's id, name or email, or `"me"`.
    pub(super) author: Option<&'a str>,
    pub(super) since: Option<&'a str>,
    pub(super) until: Option<&'a str>,
    pub(super) live: Option<bool>,
    /// The server's keyword search, passed through.
    pub(super) q: Option<&'a str>,
    pub(super) limit: usize,
}

/// A moment the model named: an RFC 3339 datetime, a datetime with no zone
/// (read as UTC), or a bare date — the start of that day as a lower bound,
/// its last millisecond as an upper one, so `until: "2026-09-22"` includes
/// all of the 22nd.
fn parse_moment(text: &str, end_of_day: bool) -> Option<DateTime<Utc>> {
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(at.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(text, format) {
            return Some(at.and_utc());
        }
    }
    let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    let start = day.and_hms_opt(0, 0, 0)?.and_utc();
    Some(if end_of_day { start + Duration::days(1) - Duration::milliseconds(1) } else { start })
}

/// A server timestamp, or `None` when it is missing or unreadable — which a
/// date fold then lets through rather than drops, since the row is real.
fn stamp(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|at| at.with_timezone(&Utc))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A recorded session as `org_sessions` lists it.
fn recorded_session_json(session: &RemoteSession) -> Value {
    json!({
        "id": session.id,
        // Where to open it: a session tool takes it as `workspace` beside the id.
        "workspace_id": session.workspace_id,
        "title": session.title,
        "author": { "user_id": session.author_id, "name": session.author_name },
        "agent": session.agent,
        "model": session.model,
        "started_at": session.started_at,
        "last_activity_at": session.last_activity_at,
        "live": session.live,
        "counts": {
            "messages": session.message_count,
            "tool_calls": session.tool_call_count,
            "checkpoints": session.checkpoint_count,
        },
        "insertions": session.insertions,
        "deletions": session.deletions,
        "files_touched": session.files_touched,
        "total_tokens": session.total_tokens,
    })
}

/// One entry of a recorded session as the model reads it: what it is, when,
/// and only the fields that apply to its kind — the server omits the rest,
/// and so does this, because every empty field is a token the model pays for.
fn entry_json(entry: &RemoteEntry) -> Value {
    let mut out = json!({ "id": entry.id, "kind": entry.kind, "at": entry.at, "turn": entry.turn_seq });
    let mut put = |key: &str, value: Value| {
        out[key] = value;
    };
    let text = |v: &Option<String>| v.as_ref().filter(|s| !s.is_empty()).map(|s| json!(s));
    if let Some(v) = text(&entry.text) {
        put("text", v);
    }
    if entry.truncated {
        // The rest is behind `org_session` with `entry`.
        put("truncated", json!(true));
        put("body_bytes", json!(entry.body_bytes));
    }
    for (key, value) in [
        ("tool_name", &entry.tool_name),
        ("tool_title", &entry.tool_title),
        ("tool_status", &entry.tool_status),
        ("arguments", &entry.arguments),
        ("result", &entry.result),
        ("commit_sha", &entry.commit_sha),
        ("branch", &entry.branch),
        ("link_state", &entry.link_state),
    ] {
        if let Some(v) = text(value) {
            put(key, v);
        }
    }
    if entry.result_binary {
        put("result_binary", json!(true));
    }
    if !entry.paths.is_empty() {
        put("paths", json!(entry.paths));
    }
    if !entry.files.is_empty() {
        put("files", json!(entry.files));
    }
    if entry.insertions != 0 || entry.deletions != 0 {
        put("insertions", json!(entry.insertions));
        put("deletions", json!(entry.deletions));
    }
    out
}

/// What the answer says when the scan stopped at [`SESSIONS_SCAN_CAP`] with
/// more of the window still unread: how to narrow, and where to pick up.
fn scan_cap_note(oldest: Option<&str>, narrow_with: &str) -> String {
    let resume = match oldest {
        Some(at) => format!(" or pass until={at} to continue further back"),
        None => String::new(),
    };
    format!(
        "Stopped after scanning the {SESSIONS_SCAN_CAP} most recently active recorded sessions, before the end of \
         the window, so older matches may be missing. Narrow with {narrow_with}{resume}."
    )
}

/// The window a board fold reads, as the model named it: `since` and
/// `until`, or — when it named neither — the last
/// [`SESSIONS_DEFAULT_WINDOW_DAYS`] days, which the answer then says.
pub(super) struct Window {
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    default: bool,
}

impl Window {
    /// The window `since` and `until` name, or the tool's answer refusing a
    /// moment that is not an ISO date or datetime (before anything is read).
    pub(super) fn of(since: Option<&str>, until: Option<&str>) -> Result<Self, CallToolResult> {
        let read = |name: &str, text: Option<&str>, end_of_day: bool| match text {
            None => Ok(None),
            Some(text) => parse_moment(text, end_of_day)
                .map(Some)
                .ok_or_else(|| tool_error(format!("{name} \"{text}\" is not an ISO date or datetime"))),
        };
        let mut since = read("since", since, false)?;
        let until = read("until", until, true)?;
        let default = since.is_none() && until.is_none();
        if default {
            since = Some(Utc::now() - Duration::days(SESSIONS_DEFAULT_WINDOW_DAYS));
        }
        Ok(Self { since, until, default })
    }

    /// Whether a recorded session overlaps the window at its far end: it
    /// started at or before `until`. The near end (`since`) is the walk's —
    /// the first row last active before it ends the walk.
    fn holds(&self, session: &RemoteSession) -> bool {
        self.until.is_none_or(|until| stamp(&session.started_at).is_none_or(|started| started <= until))
    }

    pub(super) fn json(&self) -> Value {
        json!({ "since": self.since.map(iso), "until": self.until.map(iso), "default": self.default })
    }
}

/// What one walk of a Workspace's board is asked ([`OrgTools::walk_board`]).
pub(super) struct BoardWalk<'a> {
    pub(super) workspace_id: &'a str,
    /// The server's keyword search, passed through.
    pub(super) q: Option<&'a str>,
    pub(super) window: &'a Window,
    /// Stop once this many rows are kept; `None` keeps every row in the
    /// window, up to the scan cap.
    pub(super) limit: Option<usize>,
    /// What the scan-cap note tells the model to narrow with.
    pub(super) narrow_with: &'static str,
}

/// What a walk of the board found.
#[derive(Default)]
pub(super) struct Walked {
    /// The rows kept, most recently active first, as the board orders them.
    pub(super) kept: Vec<RemoteSession>,
    /// How many rows in the window were read.
    pub(super) scanned: usize,
    /// The scan cap stopped the walk with more of the window unread.
    pub(super) truncated: bool,
    /// `limit` rows were kept with more still unread.
    pub(super) limit_reached: bool,
    pub(super) notes: Vec<String>,
}

/// The Workspace a board fold reads: the one the model named, in the grant's
/// organisation, else the grant's own.
pub(super) fn workspace_of<'a>(asked: Option<&'a str>, scope: &'a OrgScope) -> Result<&'a str, CallToolResult> {
    if let Some(asked) = asked {
        return checked_id("a Workspace", asked);
    }
    asked.or(scope.workspace_id.as_deref()).ok_or_else(|| {
        tool_error(
            "this session's project is bound to the organisation but its Workspace id is not recorded yet; \
             ask the user to reopen the project's cloud settings and start a new chat",
        )
    })
}

impl OrgTools {
    /// `org_sessions`: the recorded sessions on the grant's Workspace's
    /// board, newest activity first, folded here by author, window and
    /// liveness — the server has no such filters — and narrowed there by the
    /// keyword search, which is passed through untouched.
    /// The board is read by [`OrgTools::walk_board`], stopping at `limit`
    /// matches.
    ///
    /// A session is in the window when it overlaps it: active at or after
    /// `since`, and started at or before `until`. With neither given, `since`
    /// is [`SESSIONS_DEFAULT_WINDOW_DAYS`] ago, and the answer says so.
    ///
    /// `author: "me"` is the caller, so "my last session" is the first match
    /// with `limit: 1`: the newest by last activity among their own.
    ///
    /// `workspace` reads another Workspace's board in the grant's
    /// organisation — never another organisation's: the board is asked in the
    /// grant's, and the server refuses a Workspace that is not in it.
    pub(super) async fn sessions(&self, scope: &OrgScope, filters: SessionFilters<'_>) -> CallToolResult {
        let workspace_id = match workspace_of(filters.workspace, scope) {
            Ok(id) => id,
            Err(answer) => return answer,
        };
        let window = match Window::of(filters.since, filters.until) {
            Ok(window) => window,
            Err(answer) => return answer,
        };
        let author = match filters.author {
            None => None,
            Some(name) => match self.author_of(scope, name).await {
                Ok(author) => Some(author),
                Err(answer) => return answer,
            },
        };

        let keep = |session: &RemoteSession| {
            author.as_ref().is_none_or(|(id, _)| session.author_id.as_deref() == Some(id.as_str()))
                && filters.live.is_none_or(|live| session.live == live)
        };
        let walk = BoardWalk {
            workspace_id,
            q: filters.q,
            window: &window,
            limit: Some(filters.limit),
            narrow_with: "author, q or a shorter since/until window",
        };
        let mut walked = match self.walk_board(&scope.org_id, walk, keep).await {
            Ok(walked) => walked,
            Err(e) => return tool_error(e.to_string()),
        };
        if walked.limit_reached {
            walked.notes.push(format!(
                "Only the {} most recently active matches are listed; raise limit (up to {SESSIONS_MAX_LIMIT}) or \
                 narrow the search for more.",
                filters.limit
            ));
        }

        let mut answer = json!({
            "workspace": { "id": workspace_id },
            "window": window.json(),
            "sessions": walked.kept.iter().map(recorded_session_json).collect::<Vec<_>>(),
            "scanned": walked.scanned,
            "truncated": walked.truncated,
            "limit_reached": walked.limit_reached,
            "notes": walked.notes,
        });
        if let Some((id, name)) = author {
            answer["author"] = json!({ "user_id": id, "name": name });
        }
        tool_json(answer)
    }

    /// A member a board fold is narrowed to, as `(user id, name)`: the caller
    /// for `"me"`, else the roster's one match — several come back as
    /// candidates to ask about, and the board is not read.
    pub(super) async fn author_of(&self, scope: &OrgScope, name: &str) -> Result<(String, String), CallToolResult> {
        if name.eq_ignore_ascii_case("me") {
            return match self.cloud.caller(&scope.org_id).await {
                Ok(caller) => Ok((caller.user_id, caller.name)),
                Err(e) => Err(tool_error(e.to_string())),
            };
        }
        let roster = self.cloud.members(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
        resolve_member(&roster, name).map(|member| (member.user_id, member.name))
    }

    /// One walk of a Workspace's board — the scan `org_sessions` and
    /// `org_member_activity` share, so both honour the same window and cap.
    ///
    /// Reads board pages until the window is behind it (the board is ordered
    /// by last activity, so the first row older than `since` means every
    /// later one is too), the board ends, `limit` rows are kept, or
    /// [`SESSIONS_SCAN_CAP`] rows have been read — the last reported as
    /// `truncated`, with a sentence saying how to narrow or go further back.
    /// A row is kept when it is in the window ([`Window::holds`]) and `keep`
    /// takes it. The notes carry the server's, then what the walk itself has
    /// to say: that the default window was searched, and that the cap was
    /// reached.
    pub(super) async fn walk_board(
        &self,
        org_id: &str,
        walk: BoardWalk<'_>,
        keep: impl Fn(&RemoteSession) -> bool,
    ) -> Result<Walked, CloudError> {
        let mut walked = Walked::default();
        let mut oldest: Option<String> = None;
        let mut cursor: Option<String> = None;
        'pages: loop {
            let query = BoardQuery { workspace_id: walk.workspace_id, q: walk.q, cursor: cursor.as_deref() };
            let page = self.cloud.board_page(org_id, query).await?;
            for note in page.notes {
                if !walked.notes.contains(&note) {
                    walked.notes.push(note);
                }
            }
            let rows = page.sessions.len();
            for (i, session) in page.sessions.into_iter().enumerate() {
                if walked.scanned == SESSIONS_SCAN_CAP {
                    walked.truncated = i < rows || page.next_cursor.is_some();
                    break 'pages;
                }
                let last_active = stamp(&session.last_activity_at);
                if let (Some(since), Some(at)) = (walk.window.since, last_active) {
                    if at < since {
                        // Every later row is older still: the window is behind us.
                        break 'pages;
                    }
                }
                walked.scanned += 1;
                oldest = Some(session.last_activity_at.clone()).filter(|s| !s.is_empty()).or(oldest);
                if walk.window.holds(&session) && keep(&session) {
                    walked.kept.push(session);
                    if walk.limit == Some(walked.kept.len()) {
                        walked.limit_reached = i + 1 < rows || page.next_cursor.is_some();
                        break 'pages;
                    }
                }
            }
            match page.next_cursor {
                // An empty page that still names a next one would walk forever.
                Some(_) if rows == 0 => break,
                Some(next) if walked.scanned < SESSIONS_SCAN_CAP => cursor = Some(next),
                Some(_) => {
                    walked.truncated = true;
                    break;
                }
                None => break,
            }
        }

        if walk.window.default {
            walked.notes.push(format!(
                "No since or until was given, so only the last {SESSIONS_DEFAULT_WINDOW_DAYS} days were searched; \
                 pass since (an ISO date) to look further back."
            ));
        }
        if walked.truncated {
            walked.notes.push(scan_cap_note(oldest.as_deref(), walk.narrow_with));
        }
        Ok(walked)
    }

    /// `org_session`: one recorded session's summary and one page of its
    /// entries, in the order the server keeps them (turn, rank, time, id),
    /// with the cursor to the next page. Defaults to the current session.
    pub(super) async fn session(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: NamedSession<'_>,
        (cursor, limit): (Option<&str>, Option<u32>),
    ) -> CallToolResult {
        let target = match self.session_target(grant, scope, session).await {
            Ok(target) => target,
            Err(answer) => return answer,
        };
        let query = TimelineQuery {
            org_id: &scope.org_id,
            workspace_id: &target.workspace_id,
            session_id: &target.id,
            cursor,
            limit: Some(limit.unwrap_or(TIMELINE_DEFAULT_LIMIT)),
        };
        let page = match self.cloud.timeline(query).await {
            Ok(page) => page,
            Err(e) => return tool_error(e.to_string()),
        };
        let mut summary = recorded_session_json(&page.summary);
        summary["id"] = json!(target.id);
        if page.summary.title.as_deref().is_none_or(str::is_empty) {
            summary["title"] = json!(target.title);
        }
        summary["current"] = json!(target.current);
        summary["counts"] = json!({
            "prompts": page.counts.prompts,
            "responses": page.counts.responses,
            "thinking": page.counts.thinking,
            "tool_calls": page.counts.tool_calls,
            "checkpoints": page.counts.checkpoints,
        });
        tool_json(json!({
            "session": summary,
            "tools": page.tools.iter().map(|t| json!({ "name": t.tool_name, "count": t.count })).collect::<Vec<_>>(),
            "entries": page.entries.iter().map(entry_json).collect::<Vec<_>>(),
            "next_cursor": page.next_cursor,
            "notes": page.notes,
        }))
    }

    /// `org_session` with `entry`: the full text of one entry — its body, or
    /// a tool call's arguments or result — which a page shows cut short.
    pub(super) async fn session_entry(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: NamedSession<'_>,
        row_id: &str,
        part: &str,
    ) -> CallToolResult {
        let Some(part) = PAYLOAD_PARTS.iter().copied().find(|p| p.eq_ignore_ascii_case(part)) else {
            return tool_error(format!("part \"{part}\" is not one of body, arguments or result"));
        };
        let target = match self.session_target(grant, scope, session).await {
            Ok(target) => target,
            Err(answer) => return answer,
        };
        let at = PayloadRef {
            org_id: &scope.org_id,
            workspace_id: &target.workspace_id,
            session_id: &target.id,
            row_id,
            part,
        };
        let payload = match self.cloud.entry_payload(at).await {
            Ok(payload) => payload,
            Err(e) => return tool_error(e.to_string()),
        };
        tool_json(json!({
            "session": { "id": target.id, "title": target.title, "current": target.current },
            "entry": {
                "id": row_id,
                "part": part,
                "text": payload.text,
                "binary": payload.binary,
                "bytes": payload.bytes,
            },
        }))
    }
}
