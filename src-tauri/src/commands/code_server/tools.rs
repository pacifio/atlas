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

/// What the server tells the agent about itself. The engine shows it as the
/// description of the `atlas_code` tool namespace; Claude Code as "MCP Server
/// Instructions".
pub const INSTRUCTIONS: &str = "\
Code search over your session's directory, in-process. grep finds text in files (Rust regex, or \
literal=true); find_files finds paths by glob or fuzzy name. Both read the working tree as it is \
now, including your own edits, respect .gitignore, and skip binary and secret files (.env, keys). \
Prefer them to rg, grep or find in a shell: they are faster, read-only, and page their \
output, so follow next_offset instead of re-running a broader search. Paths are relative to your cwd. \
Searching: grep for exact identifiers and strings; find_symbol for definitions by name; \
semantic_search for behaviour described in words; related/impact_of_diff before edits; \
task_context once at the start of an unfamiliar task.";

/// How long one call may search before it answers with what it has.
pub(crate) const DEADLINE: Duration = Duration::from_secs(15);

const OFF_NOTE: &str =
    "Atlas code tools are switched off in Settings → General; search with your shell instead.";

const GREP_DESCRIPTION: &str = "Search file contents with a Rust regex (ripgrep engine). Respects .gitignore; skips binary and secret files. Default: matching file paths, newest first. output_mode=content for matching lines (at most 20 per file), count for per-file counts. No look-around or backreferences; literal=true for plain text. Paged: follow next_offset.";

const FIND_DESCRIPTION: &str = "Find files by path. A glob (contains * ? [ {) matches exactly, newest first: without / it matches file names at any depth (\"*.toml\"), with / the relative path (\"src/**/*.rs\"). Anything else is fuzzy text on the path (fzf syntax: 'exact ^prefix suffix$ !not), best first. Paged: follow next_offset.";

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
    ]
}

#[cfg(test)]
pub(super) fn tool_names() -> Vec<String> {
    tools().into_iter().map(|t| t.name.to_string()).collect()
}

/// The `tools/list` answer, cached as the memory and UI servers' are.
/// `with_index`: the code index is attached, so its tools are listed too.
pub(super) fn tools_list(with_index: bool) -> ListToolsResult {
    let mut all = tools();
    if with_index {
        for (name, description, input) in crate::commands::code_index::index_tool_specs() {
            all.push(tool(name, description, input));
        }
    }
    ListToolsResult::with_all_items(all)
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
    /// The code index registry, when the app attached it: serves the symbol
    /// tools and names grep hits by their enclosing symbol.
    index: Option<Arc<crate::commands::code_index::CodeIndexRegistry>>,
}

impl CodeTools {
    pub fn new(gate: CodeToolsGate) -> Self {
        Self { gate, index: None }
    }

    /// Also serve the symbol tools and annotate grep hits from the code index.
    pub fn with_index(
        mut self,
        registry: Arc<crate::commands::code_index::CodeIndexRegistry>,
    ) -> Self {
        self.index = Some(registry);
        self
    }

    /// One call, answered under `grant`: its session's launch directory is the
    /// root nothing outside of which is read.
    pub(super) async fn dispatch(
        &self,
        grant: Grant,
        request: CallToolRequestParams,
        cancelled: impl Future<Output = ()> + Send,
    ) -> CallToolResult {
        if !(self.gate)() {
            return tool_error(OFF_NOTE);
        }
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let root = PathBuf::from(&grant.cwd);
        let job: Job = match name.as_str() {
            "grep" => {
                let args: GrepArgs = match serde_json::from_value(args) {
                    Ok(args) => args,
                    Err(e) => return tool_error(format!("grep: {e}")),
                };
                let budget = budget(args.max_output_tokens);
                // Resolved before `into_request` takes the root; cheap (a map
                // lookup), and `None` while no open project covers the session.
                let locator = self
                    .index
                    .as_ref()
                    .and_then(|r| crate::commands::code_index::grep_locator(r, &root));
                let mut req = match args.into_request(root) {
                    Ok(req) => req,
                    Err(e) => return tool_error(e),
                };
                // The grep prefilter of a large git project (Phase 5), when it
                // is built and trusted; it only ever skips files that cannot match.
                req.candidates = self
                    .index
                    .as_ref()
                    .and_then(|r| r.root_for(&req.root))
                    .and_then(|p| p.grep_index())
                    .map(|g| g as Arc<dyn atlas_search::CandidateSource>);
                Box::new(move |cancel: &CancelToken| {
                    atlas_search::grep(&req, cancel)
                        .map(|res| grep_text(&res, &req, locator.as_deref(), budget))
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
            name if crate::commands::code_index::is_index_tool(name) => {
                let Some(registry) = self.index.clone() else {
                    return tool_error("the code index is not available in this session");
                };
                let name = name.to_string();
                // Index queries are bounded SQL and graph walks (capped rows
                // and hops); the token is not needed.
                Box::new(move |_: &CancelToken| {
                    let scope = crate::commands::code_index::Scope::resolve(&registry, &root)?;
                    crate::commands::code_index::call_index_tool(&scope, &registry, &name, &args)
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
        Ok(tools_list(self.index.is_some()))
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
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service(CODE_PATH, service)
}
