//! The recorded shapes.
//!
//! These mirror the eventual server tables deliberately, so syncing is a copy
//! rather than a translation. Note `agent_session` rather than `session`: the
//! server's `session` table belongs to Better Auth and must not be reused.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Where a Session came from.
///
/// This is half of the identity constraint, and it exists because Atlas's
/// ACP-hosted agents *also* write their own transcripts to disk. Without the
/// discriminator, the importer would capture every in-app Session a second time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// An ACP-hosted agent running inside Atlas (Claude Code, Codex).
    Acp,
    /// The native agent.
    Cersei,
    /// Read back from an agent's own on-disk transcript, live or historical.
    ExternalJsonl,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Acp => "acp",
            Self::Cersei => "cersei",
            Self::ExternalJsonl => "external_jsonl",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "acp" => Some(Self::Acp),
            "cersei" => Some(Self::Cersei),
            "external_jsonl" => Some(Self::ExternalJsonl),
            _ => None,
        }
    }

    /// Was this Session observed live, with write-time file hashes?
    ///
    /// The link rule needs `existed_before` captured at write time, which an
    /// imported transcript cannot supply — so this is what decides whether a
    /// Session is eligible for Checkpoints at all.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Acp | Self::Cersei)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

/// What kind of content a Message carries.
///
/// A column rather than something derived at read time, because the session
/// detail sidebar counts Prompts, Responses and Intermediate steps directly off
/// `role` and `mode` — and doing that by scanning bodies would not scale past a
/// long Session, let alone a board-level filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Text,
    Tool,
    Thinking,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Tool => "tool",
            Self::Thinking => "thinking",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "text" => Some(Self::Text),
            "tool" => Some(Self::Tool),
            "thinking" => Some(Self::Thinking),
            _ => None,
        }
    }
}

/// Where a row is on its way to the Organisation.
///
/// The outbox is this column, not a separate queue — which is what makes Local
/// mode "the same database with draining disabled" rather than a second code
/// path to keep correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Local Workspace, or not yet eligible. Parks here forever in Local mode.
    Local,
    /// Queued for the drain.
    Pending,
    /// The server acknowledged it durably.
    Sent,
    /// Repeatedly rejected. Skipped rather than retried at the head of the
    /// queue, so one poison row never stalls everything behind it.
    Failed,
}

impl SyncState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "local" => Some(Self::Local),
            "pending" => Some(Self::Pending),
            "sent" => Some(Self::Sent),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// How a Workspace treats what it captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    /// Never drains. A complete mode, not a buffer.
    Local,
    /// Drains to the Organisation.
    Cloud,
}

impl WorkspaceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Cloud => "cloud",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "local" => Some(Self::Local),
            "cloud" => Some(Self::Cloud),
            _ => None,
        }
    }

    /// The state a freshly-written row starts in under this mode.
    pub fn initial_sync_state(self) -> SyncState {
        match self {
            Self::Local => SyncState::Local,
            Self::Cloud => SyncState::Pending,
        }
    }
}

/// A turn's lifecycle, so an agent that died mid-turn is distinguishable from
/// one that finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    /// Started, no end seen yet. Either in flight or abandoned — which of the
    /// two is only knowable once the process restarts.
    Open,
    Completed,
    /// Was open when the store was last closed. Reconciled on next open.
    Aborted,
}

impl TurnState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "open" => Some(Self::Open),
            "completed" => Some(Self::Completed),
            "aborted" => Some(Self::Aborted),
            _ => None,
        }
    }
}

/// Token accounting for a Session.
///
/// Agent-dependent by nature: only the native agent reports a real input/output
/// split. ACP agents surface a context-window gauge instead, which is a
/// different measurement and is kept in different fields so it can never be
/// rendered as a usage split. The accurate ACP figures are backfilled from the
/// agent's own transcript.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenTotals {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Context-window occupancy, for agents that only report that. Never
    /// presented as an input/output split.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_size: Option<u64>,
}

impl TokenTotals {
    /// Does this carry a genuine input/output split, as opposed to only a
    /// context gauge?
    pub fn has_usage_split(&self) -> bool {
        self.input_tokens > 0 || self.output_tokens > 0
    }
}

/// A recorded Session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub source: Source,
    /// The agent's own id for this conversation — the half of the identity
    /// constraint that makes a re-import a no-op.
    pub native_session_id: String,
    /// First line of the first user prompt, bounded and **redacted**. The most
    /// visible string in the product: it renders on the shared Organisation
    /// board, and prompts routinely contain pasted keys.
    pub title: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    /// The branch the repository was on when the Session started.
    ///
    /// Recorded at prompt time rather than derived from Checkpoints: most
    /// Sessions never produce a commit, and those had no branch at all.
    pub branch: Option<String>,
    pub cwd: Option<String>,
    pub token_totals: TokenTotals,
    /// Reserved for a later opt-in enrichment pass. Stays null.
    pub summary: Option<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// When this Session last did work — its newest message stamp or turn end.
    ///
    /// Deliberately not `updated_at`, which is a row-mutation clock: deriving a
    /// title, recording usage or re-importing a transcript all bump that and
    /// none of them is work happening now. Null only for a Session with no
    /// message and no closed turn.
    pub last_activity_at: Option<DateTime<Utc>>,
    /// Something went wrong recording this Session and a human should know.
    pub needs_attention: bool,
    pub attention_reason: Option<String>,
    /// Cumulative redaction tally, as `{category: count}`. Drives the
    /// "N secrets redacted" figure on the bulk-disclosure confirmations.
    pub redaction_counts: serde_json::Value,
    pub sync_state: SyncState,
}

/// One finalized turn's worth of content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    /// Monotonic across the whole store, so the drain has a total order and
    /// per-session reads are still correctly ordered.
    pub seq: i64,
    pub turn_seq: i64,
    pub role: Role,
    pub mode: Mode,
    /// First 2 KB, always inline — what a list renders without touching a blob.
    pub preview: String,
    /// The body, when it was small enough to keep on the row.
    pub body: Option<String>,
    /// Blob key, when the body was spilled instead.
    pub body_ref: Option<String>,
    pub body_bytes: i64,
    pub content_hash: String,
    pub created_at: DateTime<Utc>,
    pub sync_state: SyncState,
}

impl Message {
    /// Was this body spilled to a blob rather than kept on the row?
    pub fn is_spilled(&self) -> bool {
        self.body_ref.is_some()
    }
}

/// How a tool call ended.
///
/// Recording this costs nothing — ACP supplies it — and it makes "what did the
/// agent try that didn't work" answerable, which is often the most useful
/// question about a Session and a facet Entire's UI cannot offer at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

impl ToolStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(Self::Pending),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// One tool invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub turn_seq: i64,
    /// Canonical, derived — see [`crate::tools::canonical_name`]. This is what
    /// the sidebar groups by.
    pub tool_name: crate::tools::ToolName,
    /// What the agent called it, for display.
    pub title: Option<String>,
    /// ACP's category.
    pub kind: Option<String>,
    pub status: ToolStatus,
    /// Pre-extracted paths, as the agent reported them.
    pub locations: serde_json::Value,
    pub arguments: Option<String>,
    pub arguments_ref: Option<String>,
    pub result: Option<String>,
    pub result_ref: Option<String>,
    /// The result was not text and was stored verbatim rather than scrubbed.
    pub result_binary: bool,
    pub created_at: DateTime<Utc>,
    pub sync_state: SyncState,
}

/// A file the agent wrote, as it stood immediately after the write.
///
/// Both discriminating fields are captured at write time and are unrecoverable
/// afterwards. By the time a commit lands the file exists either way, and the
/// agent's version has been overwritten — so the asymmetric link rule can only
/// work if these were recorded when they were still true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTouch {
    pub id: String,
    pub tool_call_id: String,
    pub session_id: String,
    pub turn_seq: i64,
    pub seq: i64,
    /// NFC-normalised and workspace-relative.
    pub path: String,
    /// Hash of what the agent produced. `None` for a deletion.
    pub sha256_after: Option<String>,
    /// Whether the file existed before the agent wrote it. The link rule is
    /// asymmetric on exactly this: an existing file links on path alone, a new
    /// one only on a content match.
    pub existed_before: bool,
    pub deleted: bool,
    /// Written outside the Workspace root, so it can never match a commit.
    pub out_of_repo: bool,
    pub created_at: DateTime<Utc>,
    /// Bounded fingerprint of what the agent wrote (see `crate::sketch`).
    /// `None` for rows written before schema v9, which fall back to the exact
    /// `sha256_after` comparison.
    pub sketch_after: Option<String>,
}

/// How a Workspace is bound, and whether it is capturing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub workspace_id: String,
    pub root: String,
    pub mode: WorkspaceMode,
    /// The Workspace's handle within its Organisation. `None` until Cloud.
    pub slug: Option<String>,
    pub org_id: Option<String>,
    /// Root commit. Advisory — it pre-selects and warns, it never gates.
    pub root_commit_sha: Option<String>,
    /// The fingerprint came from a shallow clone's graft boundary, so it is not
    /// the true root and must not be treated as authoritative.
    pub fingerprint_is_shallow: bool,
    /// Normalised origin URL. `None` when there is no remote — which binds fine.
    pub git_url: Option<String>,
    /// Capture stops when this is false; nothing already recorded is deleted.
    pub enabled: bool,
    /// Has the user explicitly approved the bulk transcript import? Always set
    /// for Local (nothing leaves the machine); for Cloud it is set only by the
    /// disclosure confirmation, and the background scan must refuse until then.
    pub import_approved: bool,
    /// `ok`, or `not_authorized` once the server said this identity may not
    /// push. Terminal until re-registration — remembered so the drain does not
    /// retry a revoked membership every thirty seconds forever.
    pub drain_state: DrainGate,
    /// The server-assigned Workspace id from registration. The wire identity of
    /// every synced artifact; `None` until the Workspace is registered.
    pub remote_workspace_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl Binding {
    /// Is this Workspace recording right now?
    pub fn is_capturing(&self) -> bool {
        self.enabled
    }

    /// May the background scan import transcripts for this Workspace?
    ///
    /// Local always may — nothing leaves the machine. Cloud requires the
    /// explicit bulk-disclosure confirmation first.
    pub fn may_import(&self) -> bool {
        match self.mode {
            WorkspaceMode::Local => true,
            WorkspaceMode::Cloud => self.import_approved,
        }
    }
}

/// Whether the drain is allowed to run at all for this Workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainGate {
    Ok,
    /// The server rejected this identity. Terminal until re-registration; the
    /// capture-health signal renders it as "no longer authorized".
    NotAuthorized,
}

impl DrainGate {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NotAuthorized => "not_authorized",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ok" => Some(Self::Ok),
            "not_authorized" => Some(Self::NotAuthorized),
            _ => None,
        }
    }
}

/// What Atlas could work out about a directory before anything is bound.
///
/// Drives the enable popover: it shows what was detected rather than asking the
/// developer to type it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDetection {
    pub root: String,
    pub is_git_repository: bool,
    /// True for a repository with no commits yet — `git init` and nothing else.
    pub has_commits: bool,
    pub root_commit_sha: Option<String>,
    pub is_shallow: bool,
    pub git_url: Option<String>,
    /// A default Slug proposal, from the directory name.
    pub suggested_slug: String,
}

/// Whether a Checkpoint's commit is still in the history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// The commit is reachable, or was re-matched after a rewrite.
    Linked,
    /// The commit is gone and nothing carrying the same change could be found.
    ///
    /// A first-class state, not an error and not a deletion. Losing the link is
    /// a real event — a squash collapses several patches into one that matches
    /// none of them — and the record should say so rather than attach to the
    /// wrong commit. The Session link is retained, so this is recoverable if the
    /// commit becomes reachable again.
    Orphaned,
}

impl LinkState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Linked => "linked",
            Self::Orphaned => "orphaned",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "linked" => Some(Self::Linked),
            "orphaned" => Some(Self::Orphaned),
            _ => None,
        }
    }
}

/// The slice of one Session whose work landed in one git commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub session_id: String,
    pub commit_sha: String,
    pub patch_id: Option<String>,
    pub link_state: LinkState,
    /// Empty on a detached HEAD.
    pub branch: Option<String>,
    /// Verbatim from the commit; display-only, and a different fact from the
    /// Atlas account whose agent ran.
    pub git_author_name: Option<String>,
    pub git_author_email: Option<String>,
    pub files_touched: Vec<String>,
    pub insertions: i64,
    pub deletions: i64,
    /// Stays null — this feature captures Attribution's inputs and does not
    /// compute the metric.
    pub attribution: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub sync_state: SyncState,
}

/// The patch an edit-shaped call applied. Attribution's input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentEdit {
    pub id: String,
    pub tool_call_id: String,
    pub session_id: String,
    pub turn_seq: i64,
    pub path: String,
    pub patch: Option<String>,
    pub patch_ref: Option<String>,
    pub created_at: DateTime<Utc>,
}
