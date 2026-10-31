//! The MCP surface of the code tool server: `grep`, `find_files` and the
//! code index's tools, their instructions, and the handler that runs each call on a blocking thread
//! under a deadline. Schemas are flat with short descriptions, because every
//! native turn carries them in its fixed prefix.

use std::borrow::Cow;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_search::format::{find_text, grep_text};
use atlas_search::{
    CancelToken, FindMode, FindRequest, GrepRequest, OutputMode, DEFAULT_BUDGET_BYTES,
};
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
    ToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{CodeToolsGate, CODE_PATH};
use crate::commands::memory_server::{Grant, TOOLS_LIST_TTL_MS};
use crate::commands::session_projects::ProjectAccessBroker;
use crate::commands::session_pull_requests::{repository_of_url, PullRequestBroker};
use atlas_thread_metadata::ProjectAccess;

/// What the server tells the agent about itself. The engine shows it as the
/// description of the `atlas_code` tool namespace; Claude Code as "MCP Server
/// Instructions".
pub const INSTRUCTIONS: &str = "\
Code search over your session's directory, in-process. grep finds text in files (Rust regex, or \
literal=true); find_files finds paths by glob or fuzzy name. Both read the working tree as it is \
now, including your own edits, respect .gitignore, and skip binary and secret files (.env, keys). \
Prefer them to rg, grep or find in a shell: they are faster, read-only, and page their \
output, so follow next_offset instead of re-running a broader search. Paths are relative to your cwd. \
Those two are the whole search surface: there is no symbol, semantic or impact tool here (ADR-0021). \
When you need a folder outside your working directory and the session's attached projects (another \
repository, say), call request_project_access: the user approves or denies it in the session, and \
an approved folder is attached at the access granted. When you open a pull request (or start \
work on one that already exists), call link_pull_request so the user sees it beside this session. \
To follow its checks and reviews, call watch_pull_request and end your turn: Atlas wakes you with \
a message when something needs you, so never poll or sleep on a pull request.";

/// How long one call may search before it answers with what it has.
pub(crate) const DEADLINE: Duration = Duration::from_secs(15);

const OFF_NOTE: &str =
    "Atlas code tools are switched off in Settings → General; search with your shell instead.";

const GREP_DESCRIPTION: &str = "Search file contents with a Rust regex (ripgrep engine). Respects .gitignore; skips binary and secret files. Default: matching file paths, newest first. output_mode=content for matching lines (at most 20 per file), count for per-file counts. No look-around or backreferences; literal=true for plain text. Paged: follow next_offset.";

const FIND_DESCRIPTION: &str = "Find files by path. A glob (contains * ? [ {) matches exactly, newest first: without / it matches file names at any depth (\"*.toml\"), with / the relative path (\"src/**/*.rs\"). Anything else is fuzzy text on the path (fzf syntax: 'exact ^prefix suffix$ !not), best first. Paged: follow next_offset.";

const ACCESS_DESCRIPTION: &str = "Ask the user to attach a folder outside your working directory to this session — another project or repository you need to read or change. The user approves or denies it in the session; approved, it is attached at the access granted (read_only by default) and your sandbox includes it from your next turn. Not for system folders, the home folder or anything above it. Blocks up to 45 s for the answer; if it is still pending, carry on and call again later.";

const NO_ACCESS_NOTE: &str = "Project access requests are not available in this session.";

const LINK_PR_DESCRIPTION: &str = "Call this for every pull request you open (gh pr create) or work on. Links it to this session, so Atlas shows its state and checks beside the session, keeps them current, and settles the session when it merges. Pass the URL, or the number in this session's repository. Linking one already linked succeeds and says so.";

const UNLINK_PR_DESCRIPTION: &str = "Remove a pull request link from this session, for example after closing one you opened by mistake. Pass the URL, or the number. Unlinking one that is not linked succeeds and says so.";

const LIST_PRS_DESCRIPTION: &str = "List the pull requests linked to this session with their last known state, checks, review and whether Atlas is watching them, and how they stack by base branch (bottom to top). Call link_pull_request for any you opened that is missing.";

const WATCH_PR_DESCRIPTION: &str = "Have Atlas watch an open pull request for this session, linking it first if needed. Atlas reads it every two minutes and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to monitor or babysit a pull request instead of polling, sleeping or running a watcher. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision: check readiness yourself before merging. While Atlas watches, the session shows as working in the user's sidebar; when you hand the work back to the user, call unwatch_pull_request first. Watching ends when the pull request merges or closes, when the session settles, when Atlas fails to read it 8 times in a row (a rate limit only delays it), when the user stops the session, or when you call unwatch_pull_request. Unsettle the session before starting a new watch.";

const UNWATCH_PR_DESCRIPTION: &str = "Stop Atlas from watching a pull request for this session. It stays linked. Pass the URL, or the number.";

const NO_LINK_NOTE: &str = "Pull request tools are not available in this session.";

fn schema(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(JsonObject::new()),
    }
}

fn tool(name: &'static str, description: &'static str, input: Value) -> Tool {
    Tool::new(
        Cow::Borrowed(name),
        Cow::Borrowed(description),
        schema(input),
    )
    .with_annotations(ToolAnnotations::new().read_only(true))
}

/// The tools: `grep` first, as the one an agent reaches for most.
pub(super) fn tools() -> Vec<Tool> {
    vec![
        tool(
            "grep",
            GREP_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Rust regex, or a literal string with literal=true." },
                    "path": { "type": "string", "description": "File or directory to search, relative to your cwd. Default: cwd." },
                    "glob": { "type": "string", "description": "Include glob(s), comma- or space-separated, e.g. \"*.rs\" or \"src/**/*.{ts,tsx}\"; prefix ! to exclude." },
                    "type": { "type": "string", "description": "ripgrep file type: rust, ts, py, go, js, md, ..." },
                    "output_mode": { "type": "string", "enum": ["files_with_matches", "content", "count"] },
                    "case_insensitive": { "type": "boolean", "description": "Default: smart case (insensitive unless the pattern has an uppercase letter)." },
                    "literal": { "type": "boolean" },
                    "word": { "type": "boolean" },
                    "multiline": { "type": "boolean", "description": "Let matches span lines; . matches newline." },
                    "context": { "type": "integer", "minimum": 0, "maximum": 10 },
                    "before": { "type": "integer", "minimum": 0, "maximum": 10 },
                    "after": { "type": "integer", "minimum": 0, "maximum": 10 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Page size: files, lines or counts. Default 100 files / 50 lines." },
                    "offset": { "type": "integer", "minimum": 0 },
                    "include_ignored": { "type": "boolean", "description": "Also search gitignored files." },
                    "max_output_tokens": { "type": "integer", "minimum": 1000, "maximum": 12000 }
                },
                "required": ["pattern"]
            }),
        ),
        tool(
            "find_files",
            FIND_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "path": { "type": "string", "description": "Directory to search, relative to your cwd. Default: cwd." },
                    "mode": { "type": "string", "enum": ["auto", "glob", "fuzzy"] },
                    "include_dirs": { "type": "boolean" },
                    "include_ignored": { "type": "boolean" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Default 50." },
                    "offset": { "type": "integer", "minimum": 0 },
                    "max_output_tokens": { "type": "integer", "minimum": 1000, "maximum": 12000 }
                },
                "required": ["query"]
            }),
        ),
        // Not read-only: an approval attaches a folder to the session. And not
        // safe to run in parallel with itself for one folder — the host
        // folds a second request into the card already up.
        Tool::new(
            Cow::Borrowed(REQUEST_ACCESS_TOOL),
            Cow::Borrowed(ACCESS_DESCRIPTION),
            schema(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the folder (~ for home)." },
                    "access": { "type": "string", "enum": ["read_only", "read_write"], "description": "Default read_only. Ask for read_write only when you must change files there." },
                    "reason": { "type": "string", "description": "One sentence the user sees: why you need it." }
                },
                "required": ["path"]
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(false)),
        // Not read-only (it writes the session's links), but linking twice
        // is linking once.
        Tool::new(
            Cow::Borrowed(LINK_PR_TOOL),
            Cow::Borrowed(LINK_PR_DESCRIPTION),
            pr_target_schema(),
        )
        .with_annotations(ToolAnnotations::new().read_only(false).idempotent(true)),
        Tool::new(
            Cow::Borrowed(UNLINK_PR_TOOL),
            Cow::Borrowed(UNLINK_PR_DESCRIPTION),
            pr_target_schema(),
        )
        .with_annotations(
            ToolAnnotations::new()
                .read_only(false)
                .destructive(true)
                .idempotent(true),
        ),
        Tool::new(
            Cow::Borrowed(LIST_PRS_TOOL),
            Cow::Borrowed(LIST_PRS_DESCRIPTION),
            schema(json!({ "type": "object", "properties": {} })),
        )
        .with_annotations(ToolAnnotations::new().read_only(true)),
        Tool::new(
            Cow::Borrowed(WATCH_PR_TOOL),
            Cow::Borrowed(WATCH_PR_DESCRIPTION),
            pr_target_schema(),
        )
        .with_annotations(ToolAnnotations::new().read_only(false).idempotent(true)),
        Tool::new(
            Cow::Borrowed(UNWATCH_PR_TOOL),
            Cow::Borrowed(UNWATCH_PR_DESCRIPTION),
            pr_target_schema(),
        )
        .with_annotations(ToolAnnotations::new().read_only(false).idempotent(true)),
    ]
}

/// The arguments every pull request tool but the list takes.
fn pr_target_schema() -> Arc<JsonObject> {
    schema(json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "The pull request's URL." },
            "number": { "type": "integer", "minimum": 1, "description": "Its number in this session's repository, when no URL is given." }
        }
    }))
}

/// The tool an agent links a pull request to its session with.
pub(crate) const LINK_PR_TOOL: &str = "link_pull_request";
/// ...unlinks one with.
pub(crate) const UNLINK_PR_TOOL: &str = "unlink_pull_request";
/// ...lists the session's with.
pub(crate) const LIST_PRS_TOOL: &str = "list_session_pull_requests";
/// ...has Atlas watch one with.
pub(crate) const WATCH_PR_TOOL: &str = "watch_pull_request";
/// ...stops the watch with.
pub(crate) const UNWATCH_PR_TOOL: &str = "unwatch_pull_request";

#[derive(Debug, Deserialize)]
struct LinkArgs {
    url: Option<String>,
    number: Option<u64>,
}

/// The pull request the arguments name: `(repository, number)` from a URL,
/// or `(None, number)`.
pub(super) fn link_target(
    url: Option<&str>,
    number: Option<u64>,
) -> Result<(Option<String>, u64), String> {
    if let Some(url) = url.map(str::trim).filter(|u| !u.is_empty()) {
        let parsed = url
            .split(['#', '?'])
            .next()
            .unwrap_or(url)
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .and_then(|n| n.parse::<u64>().ok());
        return match (repository_of_url(url), parsed) {
            (Some(repository), Some(n)) if n > 0 => Ok((Some(repository), n)),
            _ => Err(format!("{LINK_PR_TOOL}: {url:?} is not a pull request URL")),
        };
    }
    match number {
        Some(n) if n > 0 => Ok((None, n)),
        _ => Err(format!(
            "{LINK_PR_TOOL}: pass the pull request's url or number"
        )),
    }
}

/// The tool an agent asks for a folder with.
pub(crate) const REQUEST_ACCESS_TOOL: &str = "request_project_access";

#[derive(Debug, Deserialize)]
struct AccessArgs {
    path: String,
    access: Option<String>,
    reason: Option<String>,
}

#[cfg(test)]
pub(super) fn tool_names() -> Vec<String> {
    tools().into_iter().map(|t| t.name.to_string()).collect()
}

/// The `tools/list` answer, cached as the memory and UI servers' are.
pub(super) fn tools_list() -> ListToolsResult {
    ListToolsResult::with_all_items(tools())
        .with_ttl_ms(TOOLS_LIST_TTL_MS)
        .with_cache_scope(CacheScope::Private)
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

/// `max_output_tokens` as a byte budget (4 bytes a token), or the default.
fn budget(max_output_tokens: Option<usize>) -> usize {
    max_output_tokens.map_or(DEFAULT_BUDGET_BYTES, |t| t.clamp(1_000, 12_000) * 4)
}

#[derive(Debug, Deserialize)]
pub(super) struct GrepArgs {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    #[serde(rename = "type")]
    file_type: Option<String>,
    output_mode: Option<String>,
    case_insensitive: Option<bool>,
    #[serde(default)]
    literal: bool,
    #[serde(default)]
    word: bool,
    #[serde(default)]
    multiline: bool,
    context: Option<usize>,
    before: Option<usize>,
    after: Option<usize>,
    limit: Option<usize>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    include_ignored: bool,
    max_output_tokens: Option<usize>,
}

impl GrepArgs {
    pub(super) fn into_request(self, root: PathBuf) -> Result<GrepRequest, String> {
        let mode = match self.output_mode.as_deref() {
            None | Some("files_with_matches") => OutputMode::FilesWithMatches,
            Some("content") => OutputMode::Content,
            Some("count") => OutputMode::Count,
            Some(other) => {
                return Err(format!(
                    "grep: output_mode {other:?} is not one of files_with_matches, content, count"
                ))
            }
        };
        let context = self.context.unwrap_or(0).min(10);
        Ok(GrepRequest {
            path: self.path.map(PathBuf::from),
            globs: self.glob.into_iter().collect(),
            file_type: self.file_type,
            mode,
            case_insensitive: self.case_insensitive,
            literal: self.literal,
            word: self.word,
            multiline: self.multiline,
            before: self.before.unwrap_or(context).min(10),
            after: self.after.unwrap_or(context).min(10),
            limit: self.limit,
            offset: self.offset,
            include_ignored: self.include_ignored,
            ..GrepRequest::new(root, self.pattern)
        })
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct FindArgs {
    query: String,
    path: Option<String>,
    mode: Option<String>,
    #[serde(default)]
    include_dirs: bool,
    #[serde(default)]
    include_ignored: bool,
    limit: Option<usize>,
    #[serde(default)]
    offset: usize,
    max_output_tokens: Option<usize>,
}

impl FindArgs {
    pub(super) fn into_request(self, root: PathBuf) -> Result<FindRequest, String> {
        let mode = match self.mode.as_deref() {
            None | Some("auto") => FindMode::Auto,
            Some("glob") => FindMode::Glob,
            Some("fuzzy") => FindMode::Fuzzy,
            Some(other) => {
                return Err(format!(
                    "find_files: mode {other:?} is not one of auto, glob, fuzzy"
                ))
            }
        };
        Ok(FindRequest {
            path: self.path.map(PathBuf::from),
            mode,
            include_dirs: self.include_dirs,
            include_ignored: self.include_ignored,
            limit: self.limit.unwrap_or(50),
            offset: self.offset,
            ..FindRequest::new(root, self.query)
        })
    }
}

/// Cancels its token when dropped: a call whose future is dropped (the turn
/// was interrupted, the connection went away) stops its search.
struct StopOnDrop(CancelToken);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Run `job` on a blocking thread under `deadline`. The token it is handed
/// is cancelled when `cancelled` resolves (the client sent
/// `notifications/cancelled`) or when this future is dropped, so the walk
/// stops within a file either way. `None` when the call was cancelled (or
/// the job panicked); a deadline is not a cancel: the job returns what it found.
pub(super) async fn run_bounded<T: Send + 'static>(
    job: impl FnOnce(&CancelToken) -> T + Send + 'static,
    cancelled: impl Future<Output = ()> + Send,
    deadline: Duration,
) -> Option<T> {
    let cancel = CancelToken::new().with_deadline(Instant::now() + deadline);
    let _stop_on_drop = StopOnDrop(cancel.clone());
    let worker = cancel.clone();
    let handle = tokio::task::spawn_blocking(move || job(&worker));
    tokio::select! {
        joined = handle => joined.ok(),
        () = cancelled => {
            cancel.cancel();
            None
        }
    }
}

type Job = Box<dyn FnOnce(&CancelToken) -> Result<String, String> + Send>;

#[derive(Clone)]
pub struct CodeTools {
    gate: CodeToolsGate,
    /// Where `request_project_access` goes; `None` answers that it is not
    /// available (the tests that need no host).
    access: Option<Arc<dyn ProjectAccessBroker>>,
    /// Where the pull request tools go; `None` as for `access`.
    pull_requests: Option<Arc<dyn PullRequestBroker>>,
}

impl CodeTools {
    pub fn new(gate: CodeToolsGate) -> Self {
        Self {
            gate,
            access: None,
            pull_requests: None,
        }
    }

    /// Route the pull request tools to `broker`.
    pub fn with_pull_requests(mut self, broker: Arc<dyn PullRequestBroker>) -> Self {
        self.pull_requests = Some(broker);
        self
    }

    /// One of the pull request tools (`name`): the target read off the
    /// arguments, done by the broker against the session's checkout.
    async fn pull_request_tool(&self, name: &str, grant: Grant, args: Value) -> CallToolResult {
        let Some(broker) = self.pull_requests.clone() else {
            return tool_error(NO_LINK_NOTE);
        };
        let answer = if name == LIST_PRS_TOOL {
            broker.list(grant.session_id).await
        } else {
            let args: LinkArgs = match serde_json::from_value(args) {
                Ok(args) => args,
                Err(e) => return tool_error(format!("{name}: {e}")),
            };
            let (repository, number) = match link_target(args.url.as_deref(), args.number) {
                Ok(target) => target,
                Err(e) => return tool_error(e.replacen(LINK_PR_TOOL, name, 1)),
            };
            let (session, cwd) = (grant.session_id, grant.cwd);
            match name {
                UNLINK_PR_TOOL => broker.unlink(session, cwd, repository, number).await,
                WATCH_PR_TOOL => broker.watch(session, cwd, repository, number, true).await,
                UNWATCH_PR_TOOL => broker.watch(session, cwd, repository, number, false).await,
                _ => broker.link(session, cwd, repository, number).await,
            }
        };
        match answer {
            Ok(text) => CallToolResult::success(vec![Content::text(text)]),
            Err(e) => tool_error(e),
        }
    }

    /// Route `request_project_access` to `broker`.
    pub fn with_access(mut self, broker: Arc<dyn ProjectAccessBroker>) -> Self {
        self.access = Some(broker);
        self
    }

    /// `request_project_access`: validated and asked by the broker, which
    /// raises the approval card in the session and waits (bounded) for the
    /// user. Not a search, so not run under the search deadline.
    async fn request_access(&self, grant: Grant, args: Value) -> CallToolResult {
        let Some(broker) = self.access.clone() else {
            return tool_error(NO_ACCESS_NOTE);
        };
        let args: AccessArgs = match serde_json::from_value(args) {
            Ok(args) => args,
            Err(e) => return tool_error(format!("{REQUEST_ACCESS_TOOL}: {e}")),
        };
        let access = match args.access.as_deref() {
            None => ProjectAccess::ReadOnly,
            Some(raw) => match ProjectAccess::parse(raw) {
                Some(access) => access,
                None => {
                    return tool_error(format!(
                        "{REQUEST_ACCESS_TOOL}: access {raw:?} is not read_only or read_write"
                    ))
                }
            },
        };
        match broker
            .request(grant.session_id, grant.cwd, args.path, access, args.reason)
            .await
        {
            Ok(text) => CallToolResult::success(vec![Content::text(text)]),
            Err(e) => tool_error(e),
        }
    }

    /// One call, answered under `grant`: its session's launch directory is the
    /// root nothing outside of which is read.
    pub(super) async fn dispatch(
        &self,
        grant: Grant,
        request: CallToolRequestParams,
        cancelled: impl Future<Output = ()> + Send,
    ) -> CallToolResult {
        if !(self.gate)(&grant.cwd) {
            return tool_error(OFF_NOTE);
        }
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        if name == REQUEST_ACCESS_TOOL {
            return self.request_access(grant, args).await;
        }
        if [
            LINK_PR_TOOL,
            UNLINK_PR_TOOL,
            LIST_PRS_TOOL,
            WATCH_PR_TOOL,
            UNWATCH_PR_TOOL,
        ]
        .contains(&name.as_str())
        {
            return self.pull_request_tool(&name, grant, args).await;
        }
        let root = PathBuf::from(&grant.cwd);
        let job: Job = match name.as_str() {
            "grep" => {
                let args: GrepArgs = match serde_json::from_value(args) {
                    Ok(args) => args,
                    Err(e) => return tool_error(format!("grep: {e}")),
                };
                let budget = budget(args.max_output_tokens);
                let req = match args.into_request(root) {
                    Ok(req) => req,
                    Err(e) => return tool_error(e),
                };
                Box::new(move |cancel: &CancelToken| {
                    atlas_search::grep(&req, cancel)
                        .map(|res| grep_text(&res, &req, None, budget))
                        .map_err(|e| e.to_string())
                })
            }
            "find_files" => {
                let args: FindArgs = match serde_json::from_value(args) {
                    Ok(args) => args,
                    Err(e) => return tool_error(format!("find_files: {e}")),
                };
                let budget = budget(args.max_output_tokens);
                let req = match args.into_request(root) {
                    Ok(req) => req,
                    Err(e) => return tool_error(e),
                };
                Box::new(move |cancel: &CancelToken| {
                    atlas_search::find_files(&req, cancel)
                        .map(|res| find_text(&res, &req, budget))
                        .map_err(|e| e.to_string())
                })
            }
            _ => return tool_error(format!("unknown tool `{name}`")),
        };
        match run_bounded(job, cancelled, DEADLINE).await {
            Some(Ok(text)) => CallToolResult::success(vec![Content::text(text)]),
            Some(Err(e)) => tool_error(e),
            None => tool_error("cancelled"),
        }
    }
}

impl ServerHandler for CodeTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(tools_list())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let grant = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<Grant>())
            .cloned()
            .ok_or_else(|| McpError::invalid_request("no session token", None))?;
        let ct = context.ct.clone();
        Ok(self
            .dispatch(grant, request, async move { ct.cancelled().await })
            .await
            .into())
    }
}

/// The service, routed at [`CODE_PATH`], for the tool-server listener to
/// merge in front of its token check.
pub fn router(tools: CodeTools) -> axum::Router {
    // No idle timeout, as for the memory server: an agent can go many
    // minutes between code tool calls.
    let mut sessions = LocalSessionManager::default();
    sessions.session_config.keep_alive = None;
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(sessions),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service(CODE_PATH, service)
}
