//! `search_memory` on the ported engine.
//!
//! Acceptance bar item 11. Atlas indexes the project's memory into an
//! on-device embedding store, and the agent reaches it through a tool so it can
//! ground answers in prior decisions instead of guessing or asking.
//!
//! **The retrieval itself is not ported and does not move.** `atlas-memory`,
//! `atlas-embed` and `atlas-codeindex` have no dependency on either engine —
//! the survival research checked, and their manifests name neither. What died
//! with the Cersei path is only the *tool projection*: the thin shim that
//! exposed that retrieval to the agent. This is its replacement, and it calls
//! the same retrieval through the same injected callback shape.
//!
//! # Why a dynamic tool
//!
//! The engine lets a client declare tools it will implement itself
//! (`thread/start`'s `dynamicTools`), and calls them back over
//! `item/tool/call`. That is the right seam: the retrieval needs Atlas's app
//! state and embedding model, which the engine has no way to reach, and
//! nothing about it belongs inside the fork.
//!
//! # Per-connection first, registered as a fallback
//!
//! The Cersei path put retrieval in a process-wide `OnceLock`, which means the
//! tool cannot be exercised without setting global state. Here a connection
//! takes its callback directly, so a test drives the real tool with its own
//! retrieval and no globals.
//!
//! A registration still exists, and it is not redundant: in the app the
//! retrieval needs the Tauri app handle, and these types live behind a cargo
//! feature — so passing one through `AgentHost::new` would `cfg`-gate that
//! signature and every caller of it. The explicit callback wins when present;
//! the registration is what the app uses.

use std::sync::Arc;

use codex_app_server_protocol::DynamicToolCallOutputContentItem;
use codex_app_server_protocol::DynamicToolFunctionSpec;
use codex_app_server_protocol::DynamicToolSpec;
use futures::future::BoxFuture;
use serde_json::json;

/// One retrieved snippet, as the agent will read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemDoc {
    pub title: String,
    pub source: String,
    pub text: String,
}

/// `(cwd, query, limit) -> ranked docs`.
///
/// Async because retrieval embeds the query and runs a kNN search. The same
/// signature the Cersei path used, so `src-tauri` injects the same closure.
pub type MemorySearch =
    Arc<dyn Fn(String, String, usize) -> BoxFuture<'static, Vec<MemDoc>> + Send + Sync>;

pub const TOOL_NAME: &str = "search_memory";

/// Retrieval registered by the host, for connections that were not handed one.
///
/// A connection takes its callback explicitly — that is what lets a test drive
/// the tool without touching global state. But in the app the retrieval needs
/// the Tauri app handle, which does not exist in a form the seam's constructor
/// can take: the engine types are behind a cargo feature, so a constructor
/// parameter would have to be `cfg`-gated through `AgentHost::new`'s signature
/// and every caller of it. Registering is the smaller cut, and it is what the
/// Cersei path already does.
static REGISTERED: std::sync::OnceLock<MemorySearch> = std::sync::OnceLock::new();

/// Installs the host's retrieval. Called once, at startup.
pub fn register_search(search: MemorySearch) {
    let _ = REGISTERED.set(search);
}

/// The registered retrieval, if the host installed one.
pub fn registered_search() -> Option<MemorySearch> {
    REGISTERED.get().cloned()
}

/// Default and bounds for `limit`.
///
/// Clamped rather than trusted: the model chooses this number, and an
/// unbounded one is a prompt-sized retrieval that would crowd out the
/// conversation it was meant to inform.
const DEFAULT_LIMIT: usize = 6;
const MAX_LIMIT: usize = 20;

/// The tool as the engine advertises it to the model.
///
/// Description copied from the Cersei path verbatim. It is a prompt, not a
/// label: it is what decides whether the model reaches for memory before
/// asking the user, and rewording it would change behaviour on the switch for
/// reasons nobody would connect to the switch.
pub fn tool_spec() -> DynamicToolSpec {
    DynamicToolSpec::Function(DynamicToolFunctionSpec {
        name: TOOL_NAME.to_string(),
        description: "Search Atlas's indexed project memory — prior decisions, conventions, \
             feature notes, and codebase summaries — and return the most relevant \
             snippets. Use this BEFORE asking the user about project history or \
             established patterns; it grounds your answer in what's already known."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to recall (natural language)." },
                "limit": { "type": "integer", "description": "Max snippets to return (default 6)." }
            },
            "required": ["query"]
        }),
        defer_loading: false,
    })
}

/// The query and limit from a call's arguments.
///
/// `None` when there is no usable query: the model is capable of calling this
/// with an empty string, and searching for nothing returns noise rather than
/// an error the model can learn from.
pub fn parse_arguments(arguments: &serde_json::Value) -> Option<(String, usize)> {
    let query = arguments
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if query.is_empty() {
        return None;
    }
    let limit = arguments
        .get("limit")
        .and_then(|l| l.as_u64())
        .map(|l| l as usize)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    Some((query, limit))
}

/// Retrieved docs as the single text block the tool returns.
///
/// Same shape the Cersei path produced — heading, source, body — because the
/// model was prompted against that layout.
pub fn render(docs: &[MemDoc]) -> String {
    if docs.is_empty() {
        return "No relevant project memory found.".to_string();
    }
    let mut out = String::new();
    for d in docs {
        out.push_str(&format!("## {} ({})\n{}\n\n", d.title, d.source, d.text.trim()));
    }
    out.trim().to_string()
}

/// The tool's answer in the shape `item/tool/call` expects.
pub fn output(text: String, success: bool) -> Vec<DynamicToolCallOutputContentItem> {
    let _ = success;
    vec![DynamicToolCallOutputContentItem::InputText { text }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(title: &str) -> MemDoc {
        MemDoc {
            title: title.to_string(),
            source: "CONTEXT.md".to_string(),
            text: format!("  body of {title}  "),
        }
    }

    #[test]
    fn the_tool_is_advertised_under_the_name_the_prompt_already_uses() {
        // The baked instructions tell the model to call `search_memory`. A
        // different name here is a tool the model has been told to use and
        // cannot find.
        let DynamicToolSpec::Function(spec) = tool_spec() else {
            panic!("search_memory is a function tool");
        };
        assert_eq!(spec.name, TOOL_NAME);
        assert!(spec.description.contains("indexed project memory"));
        assert_eq!(spec.input_schema["required"], json!(["query"]));
    }

    #[test]
    fn a_missing_or_blank_query_is_not_a_search() {
        // Searching for nothing returns noise. The model can call this with an
        // empty string, and it does.
        assert!(parse_arguments(&json!({})).is_none());
        assert!(parse_arguments(&json!({"query": ""})).is_none());
        assert!(parse_arguments(&json!({"query": "   "})).is_none());
    }

    #[test]
    fn the_limit_is_clamped_because_the_model_chooses_it() {
        // An unbounded limit is a prompt-sized retrieval that crowds out the
        // conversation it was meant to inform.
        assert_eq!(parse_arguments(&json!({"query": "q"})).unwrap().1, DEFAULT_LIMIT);
        assert_eq!(parse_arguments(&json!({"query": "q", "limit": 0})).unwrap().1, 1);
        assert_eq!(
            parse_arguments(&json!({"query": "q", "limit": 9999})).unwrap().1,
            MAX_LIMIT,
        );
        assert_eq!(parse_arguments(&json!({"query": "q", "limit": 3})).unwrap().1, 3);
    }

    #[test]
    fn the_query_is_trimmed_rather_than_searched_with_its_whitespace() {
        assert_eq!(
            parse_arguments(&json!({"query": "  how does auth work  "}))
                .unwrap()
                .0,
            "how does auth work",
        );
    }

    #[test]
    fn an_empty_result_says_so_instead_of_returning_nothing() {
        // A tool that returns an empty string reads to the model as a broken
        // tool, and it retries. Saying "nothing found" ends that.
        assert_eq!(render(&[]), "No relevant project memory found.");
    }

    #[test]
    fn results_keep_the_heading_and_source_layout_the_model_was_prompted_against() {
        let rendered = render(&[doc("ADR-0003"), doc("CONTEXT")]);
        assert!(rendered.starts_with("## ADR-0003 (CONTEXT.md)\nbody of ADR-0003"));
        assert!(rendered.contains("## CONTEXT (CONTEXT.md)"));
        assert!(!rendered.ends_with('\n'), "no trailing blank line");
    }
}
