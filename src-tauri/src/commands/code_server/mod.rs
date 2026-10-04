//! The **code tool server**: code search as MCP tools, served by the Tauri
//! backend itself (ADR-0015). A third Atlas service on the memory tool
//! server's listener, behind the same token check and the same per-session
//! token: the token table holds one token per session, so a separately
//! minted one would revoke the memory one (see `ui_server`).
//!
//! - **Offered to every agent that speaks HTTP MCP** ([`offers`]) while the
//!   user's "Let agents search code with Atlas" setting is on. Not gated by
//!   the shared-memory toggle — code search holds no memory — and never
//!   decided by which agent it is.
//! - **Ten read-only tools** ([`tools`]) over the session's launch directory
//!   (`Grant::cwd`); nothing outside it is read. `grep` and `find_files` run
//!   the `atlas_search` engine and are listed to the native agent only, since
//!   every ACP agent ships its own. The code index's eight (`find_symbol`,
//!   `outline`, `read_symbol`, `related`, `impact_of_diff`, `repo_map`,
//!   `semantic_search`, `task_context`) are listed to every session.
//! - **Bounded**: each call runs on a blocking thread with a 15 s deadline
//!   and stops when the call is cancelled or its future is dropped.
//! - **The project search overlay runs on the same engine** ([`code_grep`]).

mod offers;
#[cfg(test)]
mod tests;
mod tools;

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

#[allow(unused_imports)]
pub use offers::{CodeOffer, CodeOfferDecision};
#[allow(unused_imports)]
pub use tools::{router, CodeTools, INSTRUCTIONS};

/// The name the server goes by in every agent's MCP configuration; its tools
/// reach the model as `mcp__atlas_code__<tool>`.
pub const CODE_SERVER_NAME: &str = "atlas_code";

/// Where the service is mounted on the tool-server listener.
pub const CODE_PATH: &str = "/code";

/// Whether the user lets agents use the code tools (Settings → General →
/// "Let agents search code with Atlas"). Checked when a session is offered
/// the server and on every call, so switching it off stops them at once.
pub type CodeToolsGate = Arc<dyn Fn() -> bool + Send + Sync>;

/// One matching line, for the project search overlay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGrepMatch {
    /// Relative to the searched root, `/`-separated.
    pub path: String,
    pub line: u64,
    /// Clipped to 300 chars around the match.
    pub text: String,
}

/// What the overlay renders: matching lines, newest-modified file first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGrepResult {
    pub matches: Vec<CodeGrepMatch>,
    pub total_matches: usize,
    pub total_files: usize,
    /// More matched than `matches` holds.
    pub truncated: bool,
    /// The 15 s deadline stopped the search.
    pub partial: bool,
}

/// The project search overlay (Cmd+Shift+F) on the agents' engine: literal
/// unless `regex`, case-insensitive unless `case_sensitive`, `whole_word` on
/// word boundaries; `.gitignore` respected, binary and secret files skipped.
/// Replaces `search_in_files`. Not gated by the code-tools setting: that
/// setting is about agents, and this is the user's own search.
#[tauri::command]
pub async fn code_grep(
    path: String,
    query: String,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    max_results: Option<usize>,
    registry: tauri::State<'_, Arc<crate::commands::code_index::CodeIndexRegistry>>,
) -> Result<CodeGrepResult, String> {
    let options = OverlaySearch {
        regex: regex.unwrap_or(false),
        case_sensitive: case_sensitive.unwrap_or(false),
        whole_word: whole_word.unwrap_or(false),
        max_results: max_results.unwrap_or(100),
    };
    grep_overlay(path, query, options, Some(registry.inner().as_ref())).await
}

/// The overlay's toggles, defaults applied.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct OverlaySearch {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub max_results: usize,
}

/// [`code_grep`] without the Tauri state: `registry` supplies the grep
/// prefilter of a large git project, when one is built.
pub(crate) async fn grep_overlay(
    path: String,
    query: String,
    options: OverlaySearch,
    registry: Option<&crate::commands::code_index::CodeIndexRegistry>,
) -> Result<CodeGrepResult, String> {
    let max = options.max_results.clamp(1, 500);
    let mut req = atlas_search::GrepRequest {
        mode: atlas_search::OutputMode::Content,
        literal: !options.regex,
        case_insensitive: Some(!options.case_sensitive),
        word: options.whole_word,
        limit: Some(max),
        ..atlas_search::GrepRequest::new(path, query)
    };
    // Same prefilter the agents' grep uses.
    req.candidates = registry
        .and_then(|r| r.root_for(&req.root))
        .and_then(|p| p.grep_index())
        .map(|g| g as Arc<dyn atlas_search::CandidateSource>);
    let cancel = atlas_search::CancelToken::new().with_deadline(Instant::now() + tools::DEADLINE);
    // Off the async runtime: the walk reads every candidate file.
    let res = tokio::task::spawn_blocking(move || atlas_search::grep(&req, &cancel))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(flatten(&res, max))
}

/// The first `max` matching lines of `res`, in its order.
pub(crate) fn flatten(res: &atlas_search::GrepResult, max: usize) -> CodeGrepResult {
    let matches: Vec<CodeGrepMatch> = res
        .files
        .iter()
        .flat_map(|file| {
            file.lines
                .iter()
                .filter(|l| l.is_match)
                .map(move |l| CodeGrepMatch {
                    path: file.rel.clone(),
                    line: l.line,
                    text: l.text.clone(),
                })
        })
        .take(max)
        .collect();
    CodeGrepResult {
        truncated: matches.len() < res.total_matches || res.match_cap_hit,
        partial: res.partial,
        total_matches: res.total_matches,
        total_files: res.total_files,
        matches,
    }
}
