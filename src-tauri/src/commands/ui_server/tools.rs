//! The MCP surface of the UI tool server: the tools, their instructions, and
//! the handler that turns each call into one UI action.
//!
//! Rust validates nothing beyond "the arguments are an object" — and the two
//! ids that open a Space page ([`space_page_refusal`]): what a tool does, and
//! what it answers, is the frontend's (`src/features/ui-actions`).
//! Schemas are kept flat, with one-clause descriptions, because every native
//! turn carries them in its fixed prefix.

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde_json::{json, Value};
use uuid::Uuid;

use super::bridge::{UiBridge, UiRequest};
use super::{NavigationGate, UI_PATH};
use crate::commands::memory_server::{Grant, TOOLS_LIST_TTL_MS};
use crate::commands::org_server::is_org_id;

/// What the server tells the agent about itself. The engine shows it as the
/// description of the `atlas_ui` tool namespace.
pub const INSTRUCTIONS: &str = "\
Atlas app control. These tools act on the Atlas window the user is looking at: open files, diffs, \
settings and tabs; show or hide panels; steer the chat composer; type a line into a terminal (the \
user presses Enter). They act on the project that is active and never switch projects; ui_state \
says whether that is your own. Call ui_state first when you need to know what is open or where \
the cursor is; it is cheap. Prefer opening something over telling the user where to click. Every \
call happens in the user's window at once and is reported in the chat, so do not open or close \
things the user did not ask about, and never put text in a chat or terminal the user did not ask \
for. Results are JSON from the app; an error names what was not found or why it was refused.";

/// What a tool answers while the user has switched agent navigation off.
const OFF_NOTE: &str = "Atlas Agent navigation is switched off in Settings → General; ask the user to turn it on.";

fn schema(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(JsonObject::new()),
    }
}

fn tool(name: &'static str, description: &'static str, input: Value) -> Tool {
    Tool::new(Cow::Borrowed(name), Cow::Borrowed(description), schema(input))
}

/// The tools, reads first.
pub(super) fn tools() -> Vec<Tool> {
    vec![
        tool(
            "ui_state",
            "What the Atlas window shows now: project (and whether it is yours), tabs, active file and cursor, panels, focused group.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "ui_open",
            "Open something in the active project and make it the active tab. file: optional 1-based line/column/endLine/endColumn. \
             diff: git diff of `path`. tab: a plain tab type. thread: a chat by session id. space_page: a conversation's Space \
             on pageId. Paths may be relative to your cwd.",
            json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "enum": ["file", "diff", "settings", "tab", "thread", "new_chat", "timeline", "url", "knowledge", "space_page"] },
                    "path": { "type": "string" },
                    "line": { "type": "integer" },
                    "column": { "type": "integer" },
                    "endLine": { "type": "integer" },
                    "endColumn": { "type": "integer" },
                    "repoPath": { "type": "string" },
                    "staged": { "type": "boolean" },
                    "commit": { "type": "string" },
                    "section": { "type": "string", "enum": ["general", "appearance", "icons", "layouts", "providers", "skills", "agents", "models", "updates", "keybindings", "about"] },
                    "type": { "type": "string", "enum": ["canvas", "browser", "tasks", "knowledge", "knowledge-graph", "memory", "settings", "log", "usage", "artifacts"] },
                    "sessionId": { "type": "string" },
                    "agent": { "type": "string" },
                    "url": { "type": "string" },
                    "noteId": { "type": "string" },
                    "conversationId": { "type": "string" },
                    "pageId": { "type": "string" }
                },
                "required": ["target"]
            }),
        ),
        tool(
            "ui_focus",
            "Activate a tab, show/hide a panel (omit visible to toggle), pick a side panel section or the right panel's mode, \
             focus a split column by its index in ui_state.groups, or reveal a path in the explorer.",
            json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "enum": ["tab", "panel", "section", "right_mode", "group", "explorer"] },
                    "id": { "type": "string" },
                    "name": { "type": "string", "enum": ["left", "right", "chat_sidebar", "terminal", "timeline_sidebar", "tab_bar"] },
                    "visible": { "type": "boolean" },
                    "side": { "type": "string", "enum": ["left", "right"] },
                    "section": { "type": "string", "enum": ["files", "knowledge", "changes", "github", "git-graph"] },
                    "mode": { "type": "string", "enum": ["source-control", "chat"] },
                    "index": { "type": "integer" },
                    "path": { "type": "string" }
                },
                "required": ["target"]
            }),
        ),
        tool(
            "ui_close",
            "Close a tab (default: the active one). An editor with unsaved changes is refused; a busy chat asks the user.",
            json!({ "type": "object", "properties": { "tabId": { "type": "string" } } }),
        ),
        tool(
            "ui_command",
            "Run a command by its keybinding id, as its shortcut would: e.g. panels.terminal, tabs.next, split.new, nav.search. \
             An unknown id fails with the list of runnable ids.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "ui_chat",
            "Steer a chat tab (default: your own): focus, prefill (replaces the draft) or insert (appends) text for the user to send, \
             jump to message index, send into ANOTHER chat, or switch another chat's agent. Never sends or switches in your own chat.",
            json!({
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["focus", "prefill", "insert", "send", "jump", "switch_agent"] },
                    "tabId": { "type": "string" },
                    "text": { "type": "string" },
                    "index": { "type": "integer" },
                    "agent": { "type": "string" }
                },
                "required": ["op"]
            }),
        ),
        tool(
            "ui_terminal",
            "open: a terminal tab. type: put one line at a new terminal's prompt WITHOUT pressing Enter; the user runs it.",
            json!({
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["open", "type"] },
                    "tabId": { "type": "string" },
                    "text": { "type": "string" }
                },
                "required": ["op"]
            }),
        ),
    ]
}

pub(super) fn tool_names() -> Vec<String> {
    tools().into_iter().map(|t| t.name.to_string()).collect()
}

/// The `tools/list` answer, with the cache fields MCP 2026-07-28 requires
/// (see the memory tool server's `tools_list`).
pub(super) fn tools_list() -> ListToolsResult {
    ListToolsResult::with_all_items(tools())
        .with_ttl_ms(TOOLS_LIST_TTL_MS)
        .with_cache_scope(CacheScope::Private)
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

/// Why a `ui_open` of a Space page is refused before the window is asked, or
/// `None`. The page is opened by two ids — the conversation's and the page's
/// — and they reach the window only in an organisation id's shape
/// ([`is_org_id`]), so nothing else rides into the Space's routes as one.
fn space_page_refusal(name: &str, args: &Value) -> Option<String> {
    if name != "ui_open" || args.get("target").and_then(Value::as_str) != Some("space_page") {
        return None;
    }
    ["conversationId", "pageId"].into_iter().find_map(|key| match args.get(key).and_then(Value::as_str) {
        Some(id) if is_org_id(id) => None,
        Some(id) => Some(format!("ui_open: {key} \"{id}\" is not an id")),
        None => Some(format!("ui_open: target space_page needs {key}")),
    })
}

#[derive(Clone)]
pub struct UiTools {
    bridge: Arc<UiBridge>,
    gate: NavigationGate,
}

impl UiTools {
    pub fn new(bridge: Arc<UiBridge>, gate: NavigationGate) -> Self {
        Self { bridge, gate }
    }

    async fn dispatch(&self, grant: Grant, request: CallToolRequestParams) -> CallToolResult {
        let name = request.name.to_string();
        if !(self.gate)() {
            return tool_error(OFF_NOTE);
        }
        if !tool_names().contains(&name) {
            return tool_error(format!("unknown tool `{name}`"));
        }
        let args = Value::Object(request.arguments.unwrap_or_default());
        if let Some(refusal) = space_page_refusal(&name, &args) {
            return tool_error(refusal);
        }
        let asked = UiRequest {
            request_id: Uuid::new_v4(),
            session_id: grant.session_id,
            agent: grant.agent,
            cwd: grant.cwd,
            tool: name,
            args,
        };
        match self.bridge.perform(asked).await {
            Ok(result) => CallToolResult::success(vec![Content::text(result.to_string())]),
            Err(e) => tool_error(e),
        }
    }
}

impl ServerHandler for UiTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(INSTRUCTIONS)
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
        Ok(self.dispatch(grant, request).await.into())
    }
}

/// The service, routed at [`UI_PATH`], for the tool-server listener to merge
/// in front of its token check.
pub fn router(tools: UiTools) -> axum::Router {
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service(UI_PATH, service)
}
