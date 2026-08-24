//! The session model — ported from `zed-ref/crates/acp_thread/src/acp_thread.rs`.
//!
//! `AcpThread` is one agent session: an ordered list of entries (user messages,
//! assistant messages, tool calls, elicitations, plans, compactions) plus the
//! bookkeeping that keeps them correct while updates stream in out of order.
//!
//! What is ported here is the *mechanism*, not Zed's rendering:
//! - chunk merging by protocol `messageId`, including the rule that a
//!   server echoing back a user chunk must not split the optimistic prompt;
//! - the tool-call upsert path, where a `WaitingForConfirmation` status survives
//!   later field updates until the user actually answers;
//! - the permission model (`WaitingForConfirmation` + oneshot, resolved with
//!   `Cancelled` / `InterruptedByFollowUp` / `Selected`);
//! - cancel semantics, including that a follow-up send cancels the previous turn
//!   with `InterruptedByFollowUp` rather than `Cancelled`.

use std::fmt::{self, Display, Formatter};
use std::mem;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::schema::MaybeUndefined;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::connection::{AgentConnection, ClientUserMessageId, PermissionOptions};
use crate::elicitation::{ElicitationEntryId, ElicitationStore};
use crate::terminal::{AcpTerminal, TerminalProviderEvent, TerminalRegistry};
use crate::EventSink;

/// One piece of renderable content.
///
/// Zed holds `Entity<Markdown>` here and re-renders it reactively. Markdown
/// entities are explicitly out of the port (the frontend already renders
/// markdown), so text is carried as a plain `String` and the *concatenation*
/// rules — which is the part that has to be right — are ported verbatim.
#[derive(Debug, Clone, PartialEq)]
pub enum ContentBlock {
    Empty,
    Text(String),
    EmbeddedResource {
        resource: acp::EmbeddedResource,
        text: String,
    },
    ResourceLink {
        resource_link: acp::ResourceLink,
    },
    Image {
        image: acp::ImageContent,
    },
}

impl ContentBlock {
    pub fn new(block: acp::ContentBlock) -> Self {
        let mut this = Self::Empty;
        this.append(block);
        this
    }

    pub fn new_combined(blocks: impl IntoIterator<Item = acp::ContentBlock>) -> Self {
        let mut this = Self::Empty;
        for block in blocks {
            this.append(block);
        }
        this
    }

    /// Tool-call content keeps embedded resources structural rather than
    /// flattening them to text (`ContentBlock::new_tool_call_content`).
    pub fn new_tool_call_content(block: acp::ContentBlock) -> Self {
        match block {
            acp::ContentBlock::Resource(resource) => {
                let text = Self::embedded_resource_string_contents(&resource);
                Self::EmbeddedResource { resource, text }
            }
            block => Self::new(block),
        }
    }

    pub fn append(&mut self, block: acp::ContentBlock) {
        match (&mut *self, &block) {
            (ContentBlock::Empty, acp::ContentBlock::ResourceLink(resource_link)) => {
                *self = ContentBlock::ResourceLink {
                    resource_link: resource_link.clone(),
                };
            }
            (ContentBlock::Empty, acp::ContentBlock::Image(image)) => {
                *self = ContentBlock::Image {
                    image: image.clone(),
                };
            }
            (ContentBlock::Empty, _) => {
                *self = ContentBlock::Text(Self::block_string_contents(&block));
            }
            (ContentBlock::Text(text), _) => {
                text.push_str(&Self::block_string_contents(&block));
            }
            (ContentBlock::ResourceLink { resource_link }, _) => {
                let existing = Self::resource_link_string(&resource_link.uri);
                let combined = format!("{}\n{}", existing, Self::block_string_contents(&block));
                *self = ContentBlock::Text(combined);
            }
            (ContentBlock::EmbeddedResource { resource, .. }, _) => {
                let existing = Self::embedded_resource_string_contents(resource);
                let combined = format!("{}\n{}", existing, Self::block_string_contents(&block));
                *self = ContentBlock::Text(combined);
            }
            (ContentBlock::Image { .. }, _) => {
                let combined = format!("`Image`\n{}", Self::block_string_contents(&block));
                *self = ContentBlock::Text(combined);
            }
        }
    }

    fn block_string_contents(block: &acp::ContentBlock) -> String {
        match block {
            acp::ContentBlock::Text(text) => text.text.clone(),
            acp::ContentBlock::ResourceLink(link) => Self::resource_link_string(&link.uri),
            acp::ContentBlock::Image(_) => "`Image`".into(),
            acp::ContentBlock::Resource(resource) => {
                Self::embedded_resource_string_contents(resource)
            }
            _ => String::new(),
        }
    }

    /// Zed renders this through `MentionUri`, which lives in `mention.rs` —
    /// explicitly not ported (Atlas has its own mention system). The bare URI is
    /// what is left of that once the mention layer is removed.
    fn resource_link_string(uri: &str) -> String {
        uri.to_string()
    }

    fn embedded_resource_string_contents(resource: &acp::EmbeddedResource) -> String {
        match &resource.resource {
            acp::EmbeddedResourceResource::TextResourceContents(text) => text.text.clone(),
            _ => String::new(),
        }
    }

    pub fn to_text(&self) -> &str {
        match self {
            ContentBlock::Empty => "",
            ContentBlock::Text(text) => text,
            ContentBlock::EmbeddedResource { text, .. } => text,
            ContentBlock::ResourceLink { resource_link } => &resource_link.uri,
            ContentBlock::Image { .. } => "`Image`",
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, ContentBlock::Empty)
    }
}

#[derive(Debug)]
pub struct UserMessage {
    pub protocol_id: Option<acp::MessageId>,
    pub client_id: Option<ClientUserMessageId>,
    pub is_optimistic: bool,
    pub content: ContentBlock,
    pub chunks: Vec<acp::ContentBlock>,
    pub indented: bool,
}

#[derive(Debug, PartialEq)]
pub struct AssistantMessage {
    pub chunks: Vec<AssistantMessageChunk>,
    pub indented: bool,
    pub is_subagent_output: bool,
}

#[derive(Debug, PartialEq)]
pub enum AssistantMessageChunk {
    Message {
        id: Option<acp::MessageId>,
        block: ContentBlock,
    },
    Thought {
        id: Option<acp::MessageId>,
        block: ContentBlock,
    },
}

impl AssistantMessageChunk {
    pub fn block(&self) -> &ContentBlock {
        match self {
            Self::Message { block, .. } | Self::Thought { block, .. } => block,
        }
    }

    pub fn is_thought(&self) -> bool {
        matches!(self, Self::Thought { .. })
    }
}

/// Two chunks belong to the same message unless the protocol says otherwise.
///
/// An agent that sends no `messageId` at all gets everything merged (the
/// pre-`messageId` behaviour); one that sends ids gets a split exactly when the
/// id changes.
pub(crate) fn can_merge_message_chunks(
    existing: Option<&acp::MessageId>,
    incoming: Option<&acp::MessageId>,
) -> bool {
    match (existing, incoming) {
        (Some(existing), Some(incoming)) => existing == incoming,
        _ => true,
    }
}

#[derive(Debug)]
pub enum AgentThreadEntry {
    UserMessage(UserMessage),
    AssistantMessage(AssistantMessage),
    ToolCall(ToolCall),
    Elicitation(ElicitationEntryId),
    CompletedPlan(Vec<PlanEntry>),
    ContextCompaction(ContextCompaction),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextCompactionId(pub Arc<str>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextCompactionStatus {
    InProgress,
    Completed,
    Canceled,
}

#[derive(Debug)]
pub struct ContextCompaction {
    pub id: ContextCompactionId,
    pub status: ContextCompactionStatus,
}

/// A proposed or applied edit. Zed backs this with a multibuffer diff, which is
/// out of the port; the payload the agent actually sends is these three fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub path: PathBuf,
    pub old_text: Option<String>,
    pub new_text: String,
}

impl Diff {
    pub fn from_acp(diff: acp::Diff) -> Self {
        Self {
            path: diff.path,
            old_text: diff.old_text,
            new_text: diff.new_text,
        }
    }

    pub fn needs_update(&self, old_text: &str, new_text: &str) -> bool {
        self.old_text.as_deref().unwrap_or("") != old_text || self.new_text != new_text
    }
}

/// The size spread is a consequence of the port: Zed's variants are all GPUI
/// entity handles (one pointer each), while these hold the payload inline
/// because there is no entity store. Boxing would diverge from the ported shape
/// for a `Vec` that holds a handful of items per tool call.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum ToolCallContent {
    ContentBlock(ContentBlock),
    Diff(Diff),
    Terminal(acp::TerminalId),
}

impl ToolCallContent {
    pub fn from_acp(content: acp::ToolCallContent) -> Result<Option<Self>> {
        match content {
            acp::ToolCallContent::Content(acp::Content { content, .. }) => Ok(Some(
                Self::ContentBlock(ContentBlock::new_tool_call_content(content)),
            )),
            acp::ToolCallContent::Diff(diff) => Ok(Some(Self::Diff(Diff::from_acp(diff)))),
            acp::ToolCallContent::Terminal(acp::Terminal { terminal_id, .. }) => {
                // The id is stored whether or not the registry knows it yet. A
                // reference can legally precede the terminal — `terminal_info`
                // meta on the same notification, a raced `terminal/create` —
                // and rendering already resolves through the registry, showing
                // nothing until the terminal exists. Failing the whole update
                // here is what dropped tool calls (and the permission requests
                // whose tool_call carried them) for every agent that embeds
                // its own terminals (#29).
                Ok(Some(Self::Terminal(terminal_id)))
            }
            _ => Ok(None),
        }
    }

    pub fn update_from_acp(&mut self, new: acp::ToolCallContent) -> Result<bool> {
        let needs_update = match (&self, &new) {
            (Self::Diff(old_diff), acp::ToolCallContent::Diff(new_diff)) => old_diff.needs_update(
                new_diff.old_text.as_deref().unwrap_or(""),
                &new_diff.new_text,
            ),
            _ => true,
        };

        if let Some(update) = Self::from_acp(new)? {
            if needs_update {
                *self = update;
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

/// `UpdateFields` carries the SDK's own `ToolCallUpdate`, which sets the size;
/// see the note on [`ToolCallContent`].
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum ToolCallUpdate {
    UpdateFields(acp::ToolCallUpdate),
    UpdateDiff(ToolCallUpdateDiff),
    UpdateTerminal(ToolCallUpdateTerminal),
}

impl ToolCallUpdate {
    pub fn id(&self) -> &acp::ToolCallId {
        match self {
            Self::UpdateFields(update) => &update.tool_call_id,
            Self::UpdateDiff(diff) => &diff.id,
            Self::UpdateTerminal(terminal) => &terminal.id,
        }
    }
}

impl From<acp::ToolCallUpdate> for ToolCallUpdate {
    fn from(update: acp::ToolCallUpdate) -> Self {
        Self::UpdateFields(update)
    }
}

#[derive(Debug)]
pub struct ToolCallUpdateDiff {
    pub id: acp::ToolCallId,
    pub diff: Diff,
}

impl From<ToolCallUpdateDiff> for ToolCallUpdate {
    fn from(diff: ToolCallUpdateDiff) -> Self {
        Self::UpdateDiff(diff)
    }
}

#[derive(Debug)]
pub struct ToolCallUpdateTerminal {
    pub id: acp::ToolCallId,
    pub terminal: acp::TerminalId,
}

impl From<ToolCallUpdateTerminal> for ToolCallUpdate {
    fn from(terminal: ToolCallUpdateTerminal) -> Self {
        Self::UpdateTerminal(terminal)
    }
}

#[derive(Debug, Clone)]
pub enum SelectedPermissionParams {
    Terminal { patterns: Vec<String> },
}

#[derive(Debug, Clone)]
pub struct SelectedPermissionOutcome {
    pub option_id: acp::PermissionOptionId,
    pub option_kind: acp::PermissionOptionKind,
    pub params: Option<SelectedPermissionParams>,
}

impl SelectedPermissionOutcome {
    pub fn new(option_id: acp::PermissionOptionId, option_kind: acp::PermissionOptionKind) -> Self {
        Self {
            option_id,
            option_kind,
            params: None,
        }
    }

    pub fn params(mut self, params: Option<SelectedPermissionParams>) -> Self {
        self.params = params;
        self
    }
}

impl From<SelectedPermissionOutcome> for acp::SelectedPermissionOutcome {
    fn from(value: SelectedPermissionOutcome) -> Self {
        Self::new(value.option_id)
    }
}

#[derive(Clone, Debug)]
pub enum RequestPermissionOutcome {
    Cancelled,
    InterruptedByFollowUp,
    Selected(SelectedPermissionOutcome),
}

impl From<RequestPermissionOutcome> for acp::RequestPermissionOutcome {
    fn from(value: RequestPermissionOutcome) -> Self {
        match value {
            RequestPermissionOutcome::Cancelled
            | RequestPermissionOutcome::InterruptedByFollowUp => Self::Cancelled,
            RequestPermissionOutcome::Selected(outcome) => Self::Selected(outcome.into()),
        }
    }
}

/// What a `WaitingForConfirmation` prompt represents semantically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationKind {
    /// The user is granting or denying permission for the tool call to proceed.
    /// The selected `PermissionOptionKind` decides whether the tool call moves
    /// to `InProgress` (allow) or `Rejected` (reject).
    PermissionGrant,
    /// The user is choosing between actions for the tool to take next (for
    /// example, "Save" vs "Discard"). The tool call always moves to
    /// `InProgress`; the caller interprets the chosen `option_id`.
    ActionChoice,
}

#[derive(Debug)]
pub enum ToolCallStatus {
    /// Hasn't started running yet, but we start showing it to the user.
    Pending,
    /// Waiting for confirmation from the user.
    WaitingForConfirmation {
        current_status: acp::ToolCallStatus,
        options: PermissionOptions,
        respond_tx: oneshot::Sender<RequestPermissionOutcome>,
        kind: AuthorizationKind,
    },
    InProgress,
    Completed,
    Failed,
    /// The user rejected the tool call.
    Rejected,
    /// The user canceled generation so the tool call was canceled.
    Canceled,
}

impl From<acp::ToolCallStatus> for ToolCallStatus {
    fn from(status: acp::ToolCallStatus) -> Self {
        match status {
            acp::ToolCallStatus::Pending => Self::Pending,
            acp::ToolCallStatus::InProgress => Self::InProgress,
            acp::ToolCallStatus::Completed => Self::Completed,
            acp::ToolCallStatus::Failed => Self::Failed,
            _ => Self::Pending,
        }
    }
}

impl ToolCallStatus {
    pub fn as_acp_status(&self) -> Option<acp::ToolCallStatus> {
        match self {
            ToolCallStatus::Pending => Some(acp::ToolCallStatus::Pending),
            ToolCallStatus::WaitingForConfirmation { current_status, .. } => Some(*current_status),
            ToolCallStatus::InProgress => Some(acp::ToolCallStatus::InProgress),
            ToolCallStatus::Completed => Some(acp::ToolCallStatus::Completed),
            ToolCallStatus::Failed => Some(acp::ToolCallStatus::Failed),
            ToolCallStatus::Rejected | ToolCallStatus::Canceled => None,
        }
    }

    fn status_after_permission_grant(status: acp::ToolCallStatus) -> ToolCallStatus {
        match ToolCallStatus::from(status) {
            ToolCallStatus::Pending => ToolCallStatus::InProgress,
            status => status,
        }
    }
}

impl Display for ToolCallStatus {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}",
            match self {
                ToolCallStatus::Pending => "Pending",
                ToolCallStatus::WaitingForConfirmation { .. } => "Waiting for confirmation",
                ToolCallStatus::InProgress => "In Progress",
                ToolCallStatus::Completed => "Completed",
                ToolCallStatus::Failed => "Failed",
                ToolCallStatus::Rejected => "Rejected",
                ToolCallStatus::Canceled => "Canceled",
            }
        )
    }
}

#[derive(Debug)]
pub struct ToolCall {
    pub id: acp::ToolCallId,
    pub label: String,
    pub kind: acp::ToolKind,
    pub content: Vec<ToolCallContent>,
    pub status: ToolCallStatus,
    pub locations: Vec<acp::ToolCallLocation>,
    pub raw_input: Option<serde_json::Value>,
    pub raw_output: Option<serde_json::Value>,
    pub tool_name: Option<Arc<str>>,
}

impl ToolCall {
    pub fn from_acp(tool_call: acp::ToolCall, status: ToolCallStatus) -> Result<Self> {
        let label = Self::label_for(&tool_call.kind, tool_call.title);
        let mut content = Vec::with_capacity(tool_call.content.len());
        for item in tool_call.content {
            if let Some(item) = ToolCallContent::from_acp(item)? {
                content.push(item);
            }
        }

        Ok(Self {
            id: tool_call.tool_call_id,
            label,
            kind: tool_call.kind,
            content,
            status,
            locations: tool_call.locations,
            raw_input: tool_call.raw_input,
            raw_output: tool_call.raw_output,
            tool_name: tool_name_from_meta(&tool_call.meta),
        })
    }

    /// Zed additionally markdown-escapes an `Edit` title, because it renders the
    /// label as markdown. Nothing renders markdown in this crate, so only the
    /// multi-line truncation — which is real behaviour, not presentation —
    /// is ported.
    fn label_for(kind: &acp::ToolKind, title: String) -> String {
        if *kind == acp::ToolKind::Execute || *kind == acp::ToolKind::Edit {
            title
        } else if let Some((first_line, _)) = title.split_once('\n') {
            first_line.to_owned() + "…"
        } else {
            title
        }
    }

    pub fn update_fields(
        &mut self,
        fields: acp::ToolCallUpdateFields,
        meta: Option<acp::Meta>,
    ) -> Result<()> {
        let acp::ToolCallUpdateFields {
            kind,
            status,
            title,
            content,
            locations,
            raw_input,
            raw_output,
            ..
        } = fields;

        if let Some(kind) = kind {
            self.kind = kind;
        }

        if let Some(status) = status {
            self.update_acp_status(status);
        }

        if let Some(tool_name) = tool_name_from_meta(&meta) {
            self.tool_name = Some(tool_name);
        }

        if let Some(title) = title {
            self.label = Self::label_for(&self.kind, title);
        }

        if let Some(content) = content {
            let mut new_content_len = content.len();
            let mut content = content.into_iter();

            // Reuse existing content where we can, so a streaming update does
            // not churn the whole list.
            for (old, new) in self.content.iter_mut().zip(content.by_ref()) {
                if !old.update_from_acp(new)? {
                    new_content_len -= 1;
                }
            }
            for new in content {
                if let Some(new) = ToolCallContent::from_acp(new)? {
                    self.content.push(new);
                } else {
                    new_content_len -= 1;
                }
            }
            self.content.truncate(new_content_len);
        }

        if let Some(locations) = locations {
            self.locations = locations;
        }

        if let Some(raw_input) = raw_input {
            self.raw_input = Some(raw_input);
        }

        if let Some(raw_output) = raw_output {
            self.raw_output = Some(raw_output);
        }

        Ok(())
    }

    pub(crate) fn update_status(&mut self, status: ToolCallStatus) {
        match status {
            ToolCallStatus::Pending => self.update_acp_status(acp::ToolCallStatus::Pending),
            ToolCallStatus::InProgress => self.update_acp_status(acp::ToolCallStatus::InProgress),
            ToolCallStatus::Completed => self.update_acp_status(acp::ToolCallStatus::Completed),
            ToolCallStatus::Failed => self.update_acp_status(acp::ToolCallStatus::Failed),
            status @ (ToolCallStatus::WaitingForConfirmation { .. }
            | ToolCallStatus::Rejected
            | ToolCallStatus::Canceled) => self.status = status,
        }
    }

    /// The rule that keeps an open permission prompt open.
    ///
    /// While the user is being asked, the agent keeps sending ordinary status
    /// updates for the same tool call. Applying them directly would replace
    /// `WaitingForConfirmation` — dropping the `respond_tx` and leaving the
    /// agent waiting forever on a permission response that can no longer be
    /// sent. Pending/in-progress updates are therefore folded into the
    /// remembered `current_status` instead, and only a genuinely terminal status
    /// replaces the prompt.
    fn update_acp_status(&mut self, status: acp::ToolCallStatus) {
        if let ToolCallStatus::WaitingForConfirmation { current_status, .. } = &mut self.status {
            if matches!(
                status,
                acp::ToolCallStatus::Pending | acp::ToolCallStatus::InProgress
            ) {
                *current_status = status;
                return;
            }
        }
        self.status = status.into();
    }

    pub fn diffs(&self) -> impl Iterator<Item = &Diff> {
        self.content.iter().filter_map(|content| match content {
            ToolCallContent::Diff(diff) => Some(diff),
            _ => None,
        })
    }

    pub fn terminals(&self) -> impl Iterator<Item = &acp::TerminalId> {
        self.content.iter().filter_map(|content| match content {
            ToolCallContent::Terminal(id) => Some(id),
            _ => None,
        })
    }
}

pub const TOOL_NAME_META_KEY: &str = "tool_name";

pub fn tool_name_from_meta(meta: &Option<acp::Meta>) -> Option<Arc<str>> {
    meta.as_ref()
        .and_then(|m| m.get(TOOL_NAME_META_KEY))
        .and_then(|v| v.as_str())
        .map(Arc::from)
}

#[derive(Debug, Default)]
pub struct Plan {
    pub entries: Vec<PlanEntry>,
}

#[derive(Debug)]
pub struct PlanStats<'a> {
    pub in_progress_entry: Option<&'a PlanEntry>,
    pub pending: u32,
    pub completed: u32,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn stats(&self) -> PlanStats<'_> {
        let mut stats = PlanStats {
            in_progress_entry: None,
            pending: 0,
            completed: 0,
        };

        for entry in &self.entries {
            match &entry.status {
                acp::PlanEntryStatus::Pending => stats.pending += 1,
                acp::PlanEntryStatus::InProgress => {
                    stats.in_progress_entry = stats.in_progress_entry.or(Some(entry));
                    stats.pending += 1;
                }
                acp::PlanEntryStatus::Completed => stats.completed += 1,
                _ => {}
            }
        }

        stats
    }
}

#[derive(Debug)]
pub struct PlanEntry {
    pub content: String,
    pub priority: acp::PlanEntryPriority,
    pub status: acp::PlanEntryStatus,
}

impl PlanEntry {
    pub fn from_acp(entry: acp::PlanEntry) -> Self {
        Self {
            content: entry.content,
            priority: entry.priority,
            status: entry.status,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub max_tokens: u64,
    pub used_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionCost {
    pub amount: f64,
    pub currency: Arc<str>,
}

pub const TOKEN_USAGE_WARNING_THRESHOLD: f32 = 0.8;

impl TokenUsage {
    pub fn ratio(&self) -> TokenUsageRatio {
        // When the maximum is unknown because there is no selected model, avoid
        // showing the token limit warning.
        if self.max_tokens == 0 {
            TokenUsageRatio::Normal
        } else if self.used_tokens >= self.max_tokens {
            TokenUsageRatio::Exceeded
        } else if self.used_tokens as f32 / self.max_tokens as f32 >= TOKEN_USAGE_WARNING_THRESHOLD
        {
            TokenUsageRatio::Warning
        } else {
            TokenUsageRatio::Normal
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum TokenUsageRatio {
    Normal,
    Warning,
    Exceeded,
}

#[derive(Debug, Clone)]
pub struct RetryStatus {
    pub last_error: Arc<str>,
    pub attempt: usize,
    pub max_attempts: usize,
    pub started_at: Instant,
    pub duration: Duration,
    pub meta: Option<acp::Meta>,
}

/// Why a connection stopped serving a thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadError {
    Unsupported { message: Arc<str> },
    Exited { status: Option<i32>, stderr: Arc<str> },
    Other(Arc<str>),
}

impl Display for LoadError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::Unsupported { message } => write!(f, "{message}"),
            LoadError::Exited { status, stderr } => match status {
                Some(status) => write!(f, "Agent exited with status {status}: {stderr}"),
                None => write!(f, "Agent exited: {stderr}"),
            },
            LoadError::Other(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for LoadError {}

#[derive(Debug, Clone)]
pub enum AcpThreadEvent {
    StatusChanged,
    PromptUpdated,
    NewEntry,
    TitleUpdated,
    TokenUsageUpdated,
    EntryUpdated(usize),
    EntriesRemoved(Range<usize>),
    /// Carries the options so the projection is a function of the EVENT, not
    /// of live status re-read at drain time — the drain lags the thread, and a
    /// call the agent finished in the meantime must still be announced (and
    /// then resolved) rather than silently swallowed (#30).
    ToolAuthorizationRequested {
        id: acp::ToolCallId,
        options: PermissionOptions,
    },
    ToolAuthorizationReceived(acp::ToolCallId),
    ElicitationRequested(ElicitationEntryId),
    ElicitationResponded(ElicitationEntryId),
    Retry(RetryStatus),
    Stopped(acp::StopReason),
    Error,
    LoadError(LoadError),
    PromptCapabilitiesUpdated,
    Refusal,
    AvailableCommandsUpdated(Vec<acp::AvailableCommand>),
    ModeUpdated(acp::SessionModeId),
    ConfigOptionsUpdated(Vec<acp::SessionConfigOption>),
    WorkingDirectoriesUpdated,
}

/// The turn currently in flight, if any. Zed also holds the send task here; the
/// task lives with the caller in this port, so only the identity remains.
#[derive(Debug)]
struct RunningTurn {
    #[allow(dead_code)]
    id: u32,
}

pub struct AcpThread {
    session_id: acp::SessionId,
    work_dirs: Vec<PathBuf>,
    parent_session_id: Option<acp::SessionId>,
    title: Option<Arc<str>>,
    entries: Vec<AgentThreadEntry>,
    elicitations: ElicitationStore,
    plan: Plan,
    turn_id: u32,
    running_turn: Option<RunningTurn>,
    connection: Arc<dyn AgentConnection>,
    token_usage: Option<TokenUsage>,
    cost: Option<SessionCost>,
    prompt_capabilities: acp::PromptCapabilities,
    available_commands: Vec<acp::AvailableCommand>,
    terminals: TerminalRegistry,
    had_error: bool,
    events: EventSink<AcpThreadEvent>,
}

impl AcpThread {
    pub fn new(
        session_id: acp::SessionId,
        connection: Arc<dyn AgentConnection>,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
        events: EventSink<AcpThreadEvent>,
    ) -> Self {
        Self {
            session_id,
            work_dirs,
            parent_session_id: None,
            title,
            entries: Vec::new(),
            elicitations: ElicitationStore::default(),
            plan: Plan::default(),
            turn_id: 0,
            running_turn: None,
            connection,
            token_usage: None,
            cost: None,
            prompt_capabilities: acp::PromptCapabilities::default(),
            available_commands: Vec::new(),
            terminals: TerminalRegistry::new(),
            had_error: false,
            events,
        }
    }

    pub fn session_id(&self) -> &acp::SessionId {
        &self.session_id
    }

    pub fn parent_session_id(&self) -> Option<&acp::SessionId> {
        self.parent_session_id.as_ref()
    }

    pub fn set_parent_session_id(&mut self, id: Option<acp::SessionId>) {
        self.parent_session_id = id;
    }

    pub fn work_dirs(&self) -> &[PathBuf] {
        &self.work_dirs
    }

    pub fn set_work_dirs(&mut self, work_dirs: Vec<PathBuf>) {
        self.work_dirs = work_dirs;
        self.emit(AcpThreadEvent::WorkingDirectoriesUpdated);
    }

    pub fn title(&self) -> Option<&Arc<str>> {
        self.title.as_ref()
    }

    /// What to call this thread when the agent has not titled it.
    ///
    /// The first line of the first thing the user said, bounded. Not a
    /// substitute for a real title — the agent's own is better and replaces
    /// this the moment it arrives — but a history row reading "New Thread"
    /// forever, because the agent never got around to naming it, is a row the
    /// user cannot pick out of a list.
    pub fn fallback_title(&self) -> Option<Arc<str>> {
        let first = self.entries.iter().find_map(|entry| match entry {
            AgentThreadEntry::UserMessage(message) => Some(message.content.to_text()),
            _ => None,
        })?;
        let line = first.trim().lines().next()?.trim();
        if line.is_empty() {
            return None;
        }
        Some(Arc::from(line.chars().take(80).collect::<String>().as_str()))
    }

    /// A thread is a draft until its first message is sent.
    ///
    /// Zed's `is_draft_thread` (`acp_thread.rs:2346-2348`). Note what it is
    /// *not*: an ACP session may already exist for a draft — Atlas opens one
    /// when the tab mounts — but that session is re-created on reload, so its
    /// id is worth nothing to history until a message has gone through it.
    pub fn is_draft(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[AgentThreadEntry] {
        &self.entries
    }

    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    pub fn connection(&self) -> &Arc<dyn AgentConnection> {
        &self.connection
    }

    pub fn token_usage(&self) -> Option<&TokenUsage> {
        self.token_usage.as_ref()
    }

    pub fn cost(&self) -> Option<&SessionCost> {
        self.cost.as_ref()
    }

    pub fn available_commands(&self) -> &[acp::AvailableCommand] {
        &self.available_commands
    }

    pub fn prompt_capabilities(&self) -> &acp::PromptCapabilities {
        &self.prompt_capabilities
    }

    pub fn set_prompt_capabilities(&mut self, capabilities: acp::PromptCapabilities) {
        self.prompt_capabilities = capabilities;
        self.emit(AcpThreadEvent::PromptCapabilitiesUpdated);
    }

    pub fn elicitations(&self) -> &ElicitationStore {
        &self.elicitations
    }

    pub fn terminals(&self) -> &TerminalRegistry {
        &self.terminals
    }

    pub fn terminals_mut(&mut self) -> &mut TerminalRegistry {
        &mut self.terminals
    }

    pub fn had_error(&self) -> bool {
        self.had_error
    }

    pub fn is_generating(&self) -> bool {
        self.running_turn.is_some()
    }

    fn emit(&self, event: AcpThreadEvent) {
        let _ = self.events.send(event);
    }

    // ---- session/update -------------------------------------------------

    /// Ported from `AcpThread::handle_session_update` (`acp_thread.rs:2549-2652`).
    pub fn handle_session_update(&mut self, update: acp::SessionUpdate) -> Result<(), acp::Error> {
        match update {
            acp::SessionUpdate::UserMessageChunk(acp::ContentChunk {
                content,
                message_id,
                ..
            }) => {
                // The full user prompt is added optimistically before `prompt` is
                // called. Some ACP servers echo user chunks back over updates;
                // skip an echoed chunk only when it matches the local optimistic
                // message, or the prompt renders twice.
                let already_in_user_message = self
                    .entries
                    .last_mut()
                    .and_then(|entry| match entry {
                        AgentThreadEntry::UserMessage(message) => Some(message),
                        _ => None,
                    })
                    .is_some_and(|message| {
                        let already_in_user_message = message.is_optimistic
                            && message.chunks.contains(&content)
                            && can_merge_message_chunks(
                                message.protocol_id.as_ref(),
                                message_id.as_ref(),
                            );
                        if already_in_user_message && message.protocol_id.is_none() {
                            message.protocol_id = message_id.clone();
                        }
                        already_in_user_message
                    });
                if !already_in_user_message {
                    self.push_user_content_block_from_agent(message_id, content);
                }
            }
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk {
                content,
                message_id,
                ..
            }) => {
                self.push_assistant_content_block_with_message_id(message_id, content, false, false)
            }
            acp::SessionUpdate::AgentThoughtChunk(acp::ContentChunk {
                content,
                message_id,
                ..
            }) => {
                self.push_assistant_content_block_with_message_id(message_id, content, true, false)
            }
            acp::SessionUpdate::ToolCall(tool_call) => {
                self.upsert_tool_call(tool_call)?;
            }
            acp::SessionUpdate::ToolCallUpdate(tool_call_update) => {
                self.update_tool_call(tool_call_update)
                    .map_err(|e| acp::Error::internal_error().data(e.to_string()))?;
            }
            acp::SessionUpdate::Plan(plan) => self.update_plan(plan),
            acp::SessionUpdate::SessionInfoUpdate(info_update) => {
                // Zed additionally re-emits `TitleUpdated` when an unchanged
                // title clears a *provisional* one it was showing while the
                // agent named the session. Provisional titles are a Zed UI
                // affordance that is not ported, so that branch has no meaning
                // here.
                if let MaybeUndefined::Value(title) = info_update.title {
                    let title: Arc<str> = title.into();
                    if self.title.as_ref() != Some(&title) {
                        self.title = Some(title);
                        self.emit(AcpThreadEvent::TitleUpdated);
                    }
                }
            }
            acp::SessionUpdate::AvailableCommandsUpdate(acp::AvailableCommandsUpdate {
                available_commands,
                ..
            }) => {
                self.available_commands = available_commands.clone();
                self.emit(AcpThreadEvent::AvailableCommandsUpdated(available_commands));
            }
            acp::SessionUpdate::CurrentModeUpdate(acp::CurrentModeUpdate {
                current_mode_id,
                ..
            }) => self.emit(AcpThreadEvent::ModeUpdated(current_mode_id)),
            acp::SessionUpdate::ConfigOptionUpdate(acp::ConfigOptionUpdate {
                config_options,
                ..
            }) => self.emit(AcpThreadEvent::ConfigOptionsUpdated(config_options)),
            acp::SessionUpdate::UsageUpdate(update) => {
                let usage = self.token_usage.get_or_insert_with(Default::default);
                usage.max_tokens = update.size;
                usage.used_tokens = update.used;
                if let Some(cost) = update.cost {
                    self.cost = Some(SessionCost {
                        amount: cost.amount,
                        currency: cost.currency.into(),
                    });
                }
                self.emit(AcpThreadEvent::TokenUsageUpdated);
            }
            _ => {}
        }
        Ok(())
    }

    // ---- entries --------------------------------------------------------

    fn push_entry(&mut self, entry: AgentThreadEntry) {
        self.entries.push(entry);
        self.emit(AcpThreadEvent::NewEntry);
    }

    pub fn push_user_content_block(
        &mut self,
        client_id: Option<ClientUserMessageId>,
        chunk: acp::ContentBlock,
    ) {
        let is_optimistic = client_id.is_some();
        self.push_user_content_block_with_protocol_id(client_id, is_optimistic, None, chunk, false)
    }

    fn push_user_content_block_from_agent(
        &mut self,
        id: Option<acp::MessageId>,
        chunk: acp::ContentBlock,
    ) {
        self.push_user_content_block_with_protocol_id(None, false, id, chunk, false)
    }

    fn push_user_content_block_with_protocol_id(
        &mut self,
        incoming_client_id: Option<ClientUserMessageId>,
        is_optimistic: bool,
        protocol_id: Option<acp::MessageId>,
        chunk: acp::ContentBlock,
        indented: bool,
    ) {
        let entries_len = self.entries.len();

        if let Some(AgentThreadEntry::UserMessage(UserMessage {
            protocol_id: existing_protocol_id,
            client_id: existing_client_id,
            content,
            chunks,
            is_optimistic: existing_is_optimistic,
            indented: existing_indented,
        })) = self.entries.last_mut()
        {
            // The last clause is the one that is easy to lose: a protocol chunk
            // arriving for an optimistic message that has no protocol id yet is
            // a *different* message being announced, not a continuation of the
            // prompt the user just typed.
            let mergeable = *existing_indented == indented
                && can_merge_message_chunks(existing_protocol_id.as_ref(), protocol_id.as_ref())
                && !(*existing_is_optimistic
                    && !is_optimistic
                    && existing_protocol_id.is_none()
                    && protocol_id.is_some());

            if mergeable {
                if let Some(incoming_client_id) = incoming_client_id {
                    *existing_client_id = Some(incoming_client_id);
                }
                *existing_is_optimistic |= is_optimistic;
                if existing_protocol_id.is_none() {
                    *existing_protocol_id = protocol_id;
                }
                content.append(chunk.clone());
                chunks.push(chunk);
                self.emit(AcpThreadEvent::EntryUpdated(entries_len - 1));
                return;
            }
        }

        let content = ContentBlock::new(chunk.clone());
        self.push_entry(AgentThreadEntry::UserMessage(UserMessage {
            protocol_id,
            client_id: incoming_client_id,
            is_optimistic,
            content,
            chunks: vec![chunk],
            indented,
        }));
    }

    pub fn push_assistant_content_block(&mut self, chunk: acp::ContentBlock, is_thought: bool) {
        self.push_assistant_content_block_with_message_id(None, chunk, is_thought, false)
    }

    fn push_assistant_content_block_with_message_id(
        &mut self,
        message_id: Option<acp::MessageId>,
        chunk: acp::ContentBlock,
        is_thought: bool,
        indented: bool,
    ) {
        let entries_len = self.entries.len();

        if let Some(AgentThreadEntry::AssistantMessage(AssistantMessage {
            chunks,
            indented: existing_indented,
            ..
        })) = self.entries.last_mut()
        {
            if *existing_indented == indented {
                let idx = entries_len - 1;
                match (chunks.last_mut(), is_thought) {
                    (
                        Some(AssistantMessageChunk::Message {
                            id: existing_id,
                            block,
                        }),
                        false,
                    )
                    | (
                        Some(AssistantMessageChunk::Thought {
                            id: existing_id,
                            block,
                        }),
                        true,
                    ) if can_merge_message_chunks(existing_id.as_ref(), message_id.as_ref()) => {
                        if existing_id.is_none() {
                            *existing_id = message_id;
                        }
                        block.append(chunk);
                    }
                    _ => {
                        let block = ContentBlock::new(chunk);
                        chunks.push(if is_thought {
                            AssistantMessageChunk::Thought {
                                id: message_id,
                                block,
                            }
                        } else {
                            AssistantMessageChunk::Message {
                                id: message_id,
                                block,
                            }
                        });
                    }
                }
                self.emit(AcpThreadEvent::EntryUpdated(idx));
                return;
            }
        }

        let block = ContentBlock::new(chunk);
        let chunk = if is_thought {
            AssistantMessageChunk::Thought {
                id: message_id,
                block,
            }
        } else {
            AssistantMessageChunk::Message {
                id: message_id,
                block,
            }
        };
        self.push_entry(AgentThreadEntry::AssistantMessage(AssistantMessage {
            chunks: vec![chunk],
            indented,
            is_subagent_output: false,
        }));
    }

    // ---- tool calls -----------------------------------------------------

    pub fn index_for_tool_call(&self, id: &acp::ToolCallId) -> Option<usize> {
        // The tool call we are looking for is typically the last one, or very
        // close to the end, so scanning backwards beats a map here.
        self.entries
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, entry)| match entry {
                AgentThreadEntry::ToolCall(tool_call) if &tool_call.id == id => Some(index),
                _ => None,
            })
    }

    pub fn tool_call(&self, id: &acp::ToolCallId) -> Option<(usize, &ToolCall)> {
        self.index_for_tool_call(id).map(|ix| {
            let AgentThreadEntry::ToolCall(call) = &self.entries[ix] else {
                unreachable!()
            };
            (ix, call)
        })
    }

    fn tool_call_mut(&mut self, id: &acp::ToolCallId) -> Option<(usize, &mut ToolCall)> {
        let ix = self.index_for_tool_call(id)?;
        let AgentThreadEntry::ToolCall(call) = &mut self.entries[ix] else {
            unreachable!()
        };
        Some((ix, call))
    }

    /// Updates a tool call if the id matches an existing entry, otherwise
    /// inserts a new one.
    pub fn upsert_tool_call(&mut self, tool_call: acp::ToolCall) -> Result<(), acp::Error> {
        let status = tool_call.status.into();
        self.upsert_tool_call_inner(tool_call.into(), status)
    }

    /// Ported from `upsert_tool_call_inner` (`acp_thread.rs:3200-3256`).
    pub fn upsert_tool_call_inner(
        &mut self,
        update: acp::ToolCallUpdate,
        status: ToolCallStatus,
    ) -> Result<(), acp::Error> {
        let id = update.tool_call_id.clone();

        if let Some(ix) = self.index_for_tool_call(&id) {
            let result = {
                let AgentThreadEntry::ToolCall(call) = &mut self.entries[ix] else {
                    unreachable!()
                };
                let result = call.update_fields(update.fields, update.meta);
                if result.is_ok() {
                    call.update_status(status);
                }
                result
            };
            result.map_err(|e| acp::Error::internal_error().data(e.to_string()))?;

            self.emit(AcpThreadEvent::EntryUpdated(ix));
        } else {
            let tool_call: acp::ToolCall = update
                .try_into()
                .map_err(|_| acp::Error::invalid_params().data("tool call update is not a full tool call"))?;
            let call = ToolCall::from_acp(tool_call, status)
                .map_err(|e| acp::Error::internal_error().data(e.to_string()))?;
            self.push_entry(AgentThreadEntry::ToolCall(call));
        }

        Ok(())
    }

    /// Ported from `update_tool_call` (`acp_thread.rs:3115-3185`).
    ///
    /// An update for an id that was never announced becomes a *failed* entry
    /// rather than being dropped: the agent believes it ran a tool, and silently
    /// discarding that leaves the transcript claiming it never happened.
    pub fn update_tool_call(&mut self, update: impl Into<ToolCallUpdate>) -> Result<()> {
        let update = update.into();

        let ix = match self.index_for_tool_call(update.id()) {
            Some(ix) => ix,
            None => {
                let failed_tool_call = ToolCall {
                    id: update.id().clone(),
                    label: "Tool call not found".into(),
                    kind: acp::ToolKind::Fetch,
                    content: vec![ToolCallContent::ContentBlock(ContentBlock::Text(
                        "Tool call not found".into(),
                    ))],
                    status: ToolCallStatus::Failed,
                    locations: Vec::new(),
                    raw_input: None,
                    raw_output: None,
                    tool_name: None,
                };
                self.push_entry(AgentThreadEntry::ToolCall(failed_tool_call));
                return Ok(());
            }
        };

        let result = {
            let AgentThreadEntry::ToolCall(call) = &mut self.entries[ix] else {
                unreachable!()
            };
            match update {
                ToolCallUpdate::UpdateFields(update) => {
                    call.update_fields(update.fields, update.meta)
                }
                ToolCallUpdate::UpdateDiff(update) => {
                    call.content.clear();
                    call.content.push(ToolCallContent::Diff(update.diff));
                    Ok(())
                }
                ToolCallUpdate::UpdateTerminal(update) => {
                    call.content.clear();
                    call.content.push(ToolCallContent::Terminal(update.terminal));
                    Ok(())
                }
            }
        };
        result?;

        self.emit(AcpThreadEvent::EntryUpdated(ix));
        Ok(())
    }

    // ---- permission -----------------------------------------------------

    /// Ported from `request_tool_call_authorization` (`acp_thread.rs:3383-3418`).
    ///
    /// Returns the waiter the caller answers `session/request_permission` with.
    /// A dropped sender resolves to `Cancelled`, so the agent is never left
    /// waiting on a prompt that went away with its thread.
    pub fn request_tool_call_authorization(
        &mut self,
        tool_call: acp::ToolCallUpdate,
        options: PermissionOptions,
        kind: AuthorizationKind,
    ) -> Result<impl std::future::Future<Output = RequestPermissionOutcome> + Send, acp::Error>
    {
        let (tx, rx) = oneshot::channel();

        let announced_options = options.clone();
        let current_status = self
            .tool_call(&tool_call.tool_call_id)
            .and_then(|(_, tool_call)| tool_call.status.as_acp_status())
            .or(tool_call.fields.status)
            .unwrap_or(acp::ToolCallStatus::Pending);
        let status = ToolCallStatus::WaitingForConfirmation {
            current_status,
            options,
            respond_tx: tx,
            kind,
        };

        let tool_call_id = tool_call.tool_call_id.clone();
        // A permission request may reference a call nothing announced, with a
        // BARE update — the id is the only required field on an update, and
        // some adapters ask without a prior `tool_call` notification. Refusing
        // it over a missing display string strands the agent on an error and
        // the user never sees a prompt, so synthesize the title the schema
        // made optional. Only here: an ordinary update for an unknown id still
        // becomes a failed entry (see `update_tool_call`), because there the
        // agent believes the tool RAN — nobody is waiting on an answer.
        let mut tool_call = tool_call;
        if self.index_for_tool_call(&tool_call_id).is_none() && tool_call.fields.title.is_none() {
            tool_call.fields.title = Some("Tool call".to_string());
        }
        self.upsert_tool_call_inner(tool_call, status)?;
        self.emit(AcpThreadEvent::ToolAuthorizationRequested {
            id: tool_call_id.clone(),
            options: announced_options,
        });

        let events = self.events.clone();
        Ok(async move {
            let outcome = rx.await.unwrap_or(RequestPermissionOutcome::Cancelled);
            let _ = events.send(AcpThreadEvent::ToolAuthorizationReceived(tool_call_id));
            outcome
        })
    }

    pub fn cancel_tool_call_authorization(&mut self, id: &acp::ToolCallId) {
        let Some((ix, call)) = self.tool_call_mut(id) else {
            return;
        };
        if !matches!(call.status, ToolCallStatus::WaitingForConfirmation { .. }) {
            // Still announce the resolution. The prompt this cancels can have
            // been ANNOUNCED and then overtaken — the agent finishes the call
            // (dropping the responder) and cancels its request, and when the
            // cancellation wins the race the waiter future is dropped before
            // it could emit. Without this, that pill stays open forever. An
            // unmatched Received is a no-op in the projector, so emitting for
            // a prompt that was never announced costs nothing.
            self.emit(AcpThreadEvent::ToolAuthorizationReceived(id.clone()));
            return;
        }

        call.status = ToolCallStatus::Canceled;
        self.emit(AcpThreadEvent::EntryUpdated(ix));
        self.emit(AcpThreadEvent::ToolAuthorizationReceived(id.clone()));
    }

    /// Ported from `authorize_tool_call` (`acp_thread.rs:3433-3489`).
    pub fn authorize_tool_call(
        &mut self,
        id: acp::ToolCallId,
        outcome: SelectedPermissionOutcome,
    ) {
        let Some((ix, call)) = self.tool_call_mut(&id) else {
            return;
        };

        let new_status = match &call.status {
            // An action choice is not a grant: whatever the user picked, the
            // tool proceeds and the caller interprets the option id.
            ToolCallStatus::WaitingForConfirmation {
                kind: AuthorizationKind::ActionChoice,
                ..
            } => ToolCallStatus::InProgress,
            ToolCallStatus::WaitingForConfirmation { current_status, .. } => {
                match outcome.option_kind {
                    acp::PermissionOptionKind::RejectOnce
                    | acp::PermissionOptionKind::RejectAlways => ToolCallStatus::Rejected,
                    _ => ToolCallStatus::status_after_permission_grant(*current_status),
                }
            }
            _ => match outcome.option_kind {
                acp::PermissionOptionKind::RejectOnce
                | acp::PermissionOptionKind::RejectAlways => ToolCallStatus::Rejected,
                _ => ToolCallStatus::InProgress,
            },
        };

        let curr_status = mem::replace(&mut call.status, new_status);

        if let ToolCallStatus::WaitingForConfirmation { respond_tx, .. } = curr_status {
            respond_tx
                .send(RequestPermissionOutcome::Selected(outcome))
                .ok();
        }

        self.emit(AcpThreadEvent::EntryUpdated(ix));
    }

    // ---- elicitations ---------------------------------------------------

    pub fn request_elicitation(
        &mut self,
        request: acp::CreateElicitationRequest,
    ) -> Result<
        (
            ElicitationEntryId,
            impl std::future::Future<Output = acp::CreateElicitationResponse> + Send,
        ),
        acp::Error,
    > {
        ElicitationStore::validate_request(&request)?;

        let (id, response_rx) = self.elicitations.insert_pending_elicitation(request);
        self.push_entry(AgentThreadEntry::Elicitation(id.clone()));
        self.emit(AcpThreadEvent::ElicitationRequested(id.clone()));

        let future = ElicitationStore::response_future(
            id.clone(),
            response_rx,
            Some(self.events.clone()),
            AcpThreadEvent::ElicitationResponded,
        );

        Ok((id, future))
    }

    pub fn respond_to_elicitation(
        &mut self,
        id: &ElicitationEntryId,
        response: acp::CreateElicitationResponse,
    ) {
        let Some(ix) = self.elicitation_entry_ix(id) else {
            return;
        };
        if !self.elicitations.respond_to_elicitation_by_id(id, response) {
            return;
        }
        self.emit(AcpThreadEvent::EntryUpdated(ix));
    }

    pub fn complete_url_elicitation(&mut self, elicitation_id: &acp::ElicitationId) {
        let Some(entry_id) = self
            .elicitations
            .entry_id_for_url_elicitation(elicitation_id)
        else {
            return;
        };
        let Some(ix) = self.elicitation_entry_ix(&entry_id) else {
            return;
        };
        if !self.elicitations.complete_url_elicitation_by_id(&entry_id) {
            return;
        }
        self.emit(AcpThreadEvent::EntryUpdated(ix));
    }

    pub fn cancel_elicitation(&mut self, id: &ElicitationEntryId) {
        let Some(ix) = self.elicitation_entry_ix(id) else {
            return;
        };
        if !self.elicitations.cancel_elicitation_by_id(id, true) {
            return;
        }
        self.emit(AcpThreadEvent::EntryUpdated(ix));
    }

    fn elicitation_entry_ix(&self, id: &ElicitationEntryId) -> Option<usize> {
        self.entries
            .iter()
            .enumerate()
            .rev()
            .find_map(|(ix, entry)| match entry {
                AgentThreadEntry::Elicitation(entry_id) if entry_id == id => Some(ix),
                _ => None,
            })
    }

    fn cancel_outstanding_elicitations(&mut self) {
        let mut updated = Vec::new();
        for ix in 0..self.entries.len() {
            let Some(AgentThreadEntry::Elicitation(elicitation_id)) = self.entries.get(ix) else {
                continue;
            };
            let elicitation_id = elicitation_id.clone();
            if self
                .elicitations
                .cancel_elicitation_by_id(&elicitation_id, true)
            {
                updated.push(ix);
            }
        }
        for ix in updated {
            self.emit(AcpThreadEvent::EntryUpdated(ix));
        }
    }

    // ---- plan / usage ---------------------------------------------------

    pub fn update_plan(&mut self, request: acp::Plan) {
        self.plan = Plan {
            entries: request.entries.into_iter().map(PlanEntry::from_acp).collect(),
        };
        self.emit(AcpThreadEvent::PromptUpdated);
    }

    pub fn update_token_usage(&mut self, usage: Option<TokenUsage>) {
        self.token_usage = usage;
        self.emit(AcpThreadEvent::TokenUsageUpdated);
    }

    /// Set the session's running cost.
    ///
    /// A `session/update` carries cost alongside context size, so an ACP agent
    /// sets both at once through [`Self::handle_session_update`]. An in-process
    /// agent reports cost without a context-window figure, and this is how it
    /// says so without inventing one.
    pub fn update_cost(&mut self, cost: Option<SessionCost>) {
        self.cost = cost;
        self.emit(AcpThreadEvent::TokenUsageUpdated);
    }

    /// Open a context-compaction entry, or move an open one to a new status.
    ///
    /// Zed's native agent drives these entries the same way — compaction is
    /// something an agent *does*, not something the protocol reports, so it has
    /// no `session/update` variant and reaches the timeline through here.
    pub fn upsert_context_compaction(
        &mut self,
        id: ContextCompactionId,
        status: ContextCompactionStatus,
    ) {
        let existing = self.entries.iter().position(|entry| {
            matches!(entry, AgentThreadEntry::ContextCompaction(c) if c.id == id)
        });
        match existing {
            Some(ix) => {
                if let AgentThreadEntry::ContextCompaction(compaction) = &mut self.entries[ix] {
                    compaction.status = status;
                }
                self.emit(AcpThreadEvent::EntryUpdated(ix));
            }
            None => {
                self.push_entry(AgentThreadEntry::ContextCompaction(ContextCompaction {
                    id,
                    status,
                }));
            }
        }
    }

    /// Report that a transient failure is being retried.
    ///
    /// Same reasoning as compaction: the retry is the agent's own, so it has no
    /// protocol representation and is announced directly.
    pub fn report_retry(&mut self, status: RetryStatus) {
        self.emit(AcpThreadEvent::Retry(status));
    }

    // ---- turns / cancel -------------------------------------------------

    /// Opens a new turn, cancelling any turn still running.
    ///
    /// The previous turn is cancelled with `InterruptedByFollowUp` rather than
    /// `Cancelled` — the distinction reaches any tool call still waiting on a
    /// permission answer, which is a different thing from the user pressing
    /// stop. Ported from `run_turn` (`acp_thread.rs:3740-3752`).
    pub fn begin_turn(&mut self) -> u32 {
        self.had_error = false;
        self.cancel_inner(RequestPermissionOutcome::InterruptedByFollowUp);
        self.turn_id += 1;
        self.running_turn = Some(RunningTurn { id: self.turn_id });
        self.emit(AcpThreadEvent::StatusChanged);
        self.turn_id
    }

    /// Closes the running turn. `stop_reason` is emitted so the UI leaves the
    /// generating state for the same reasons Zed does.
    pub fn end_turn(&mut self, stop_reason: acp::StopReason) {
        self.running_turn = None;
        self.emit(AcpThreadEvent::Stopped(stop_reason));
        self.emit(AcpThreadEvent::StatusChanged);
    }

    pub fn set_error(&mut self) {
        self.had_error = true;
        self.running_turn = None;
        self.emit(AcpThreadEvent::Error);
        self.emit(AcpThreadEvent::StatusChanged);
    }

    pub fn emit_load_error(&mut self, error: LoadError) {
        self.had_error = true;
        self.running_turn = None;
        self.emit(AcpThreadEvent::LoadError(error));
        self.emit(AcpThreadEvent::StatusChanged);
    }

    /// Ported from `AcpThread::cancel` (`acp_thread.rs:3901-3922`).
    pub fn cancel(&mut self) {
        self.cancel_inner(RequestPermissionOutcome::Cancelled)
    }

    fn cancel_inner(&mut self, permission_outcome: RequestPermissionOutcome) {
        self.cancel_outstanding_elicitations();

        if self.running_turn.take().is_none() {
            return;
        }
        self.mark_pending_entries_as_canceled(permission_outcome);
        self.connection.cancel(&self.session_id);
        self.emit(AcpThreadEvent::StatusChanged);
    }

    /// Every tool call that had not reached a terminal state becomes `Canceled`,
    /// and anything blocking on a permission answer is resolved — otherwise the
    /// agent side of that oneshot waits forever on a turn that is already gone.
    fn mark_pending_entries_as_canceled(&mut self, permission_outcome: RequestPermissionOutcome) {
        let mut updated = Vec::new();
        for (ix, entry) in self.entries.iter_mut().enumerate() {
            match entry {
                AgentThreadEntry::ToolCall(call) => {
                    let cancel = matches!(
                        call.status,
                        ToolCallStatus::Pending
                            | ToolCallStatus::WaitingForConfirmation { .. }
                            | ToolCallStatus::InProgress
                    );
                    if cancel {
                        let previous_status =
                            mem::replace(&mut call.status, ToolCallStatus::Canceled);
                        if let ToolCallStatus::WaitingForConfirmation { respond_tx, .. } =
                            previous_status
                        {
                            // The receiver being gone is normal: the request may
                            // already have been abandoned.
                            let _ = respond_tx.send(permission_outcome.clone());
                        }
                        updated.push(ix);
                    }
                }
                AgentThreadEntry::ContextCompaction(compaction)
                    if compaction.status == ContextCompactionStatus::InProgress =>
                {
                    compaction.status = ContextCompactionStatus::Canceled;
                    updated.push(ix);
                }
                _ => {}
            }
        }
        for ix in updated {
            self.emit(AcpThreadEvent::EntryUpdated(ix));
        }
    }

    // ---- terminals ------------------------------------------------------

    pub fn on_terminal_provider_event(&mut self, event: TerminalProviderEvent) {
        let terminal_id = event.terminal_id().clone();
        self.terminals.handle_event(event);
        // The terminal's state is what a referencing tool call renders, so a
        // change to it is a change to that entry. Zed does not need this step:
        // its terminal is an entity a view holds directly, so `cx.notify()` on
        // the terminal re-renders the tool call for free. Atlas's terminals
        // reach the UI only THROUGH the tool call's projection, so the link has
        // to be made explicitly or the output never moves.
        self.note_terminal_output(&terminal_id);
    }

    /// Announce that a terminal's output or exit status changed.
    ///
    /// Emits `EntryUpdated` for every tool call whose content references the
    /// terminal, which is what makes the projection re-read it. Called both by
    /// [`Self::on_terminal_provider_event`] and by the pump that follows a
    /// running command's output.
    ///
    /// Silent when nothing references the terminal — the agent is allowed to
    /// create one and never mention it in a tool call.
    pub fn note_terminal_output(&mut self, id: &acp::TerminalId) {
        let updated: Vec<usize> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| match entry {
                AgentThreadEntry::ToolCall(call) => call
                    .content
                    .iter()
                    .any(|block| matches!(block, ToolCallContent::Terminal(other) if other == id)),
                _ => false,
            })
            .map(|(ix, _)| ix)
            .collect();
        for ix in updated {
            self.emit(AcpThreadEvent::EntryUpdated(ix));
        }
    }

    pub fn terminal(&self, id: &acp::TerminalId) -> Option<&AcpTerminal> {
        self.terminals.get(id)
    }

    /// A terminal's output as text, for the projection that flattens a tool
    /// call's content. `None` when the id names no terminal this thread holds.
    ///
    /// Truncation is stated in the text because the text is all the reader
    /// gets: a buffer that dropped its front otherwise reads as a command that
    /// started mid-sentence. The exit status is deliberately NOT in here — the
    /// agent reports how its own tool call ended through `tool_call_update`,
    /// and the tool call's status is where the UI shows it. Zed's
    /// `Terminal::to_markdown` (`terminal.rs:604-609`) is content-only for the
    /// same reason.
    pub fn terminal_output(&self, id: &acp::TerminalId) -> Option<String> {
        self.terminals.get(id).map(|terminal| {
            let response = terminal.current_output();
            if response.truncated {
                format!("[earlier output dropped]\n{}", response.output)
            } else {
                response.output
            }
        })
    }
}
