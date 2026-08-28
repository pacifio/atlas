// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! The Chat Completions stream, read the way the Atlas gateway writes it.
//!
//! Added by Atlas; the Responses machine next door cannot read this wire. Its
//! terminal event is `response.completed`, `data: [DONE]` is a line it skips as
//! unparseable, and the gateway's in-stream error frame has no top-level `type`
//! so it is skipped too — leaving a caller with "stream closed before
//! response.completed" in place of the gateway's own diagnosis.
//!
//! # `200` means the stream started, not that it succeeded
//!
//! The gateway's rule, and the reason this machine fails closed:
//!
//! - a mid-stream failure emits `data: {"error":…}` **and withholds
//!   `data: [DONE]`** — two independent signals, either sufficient alone;
//! - **a stream that ends without `[DONE]` is incomplete**, never a short
//!   success.
//!
//! Both are honoured here. The philosophy is the same one the Responses machine
//! already has — an absent terminal event is an error — so only the sentinel
//! changes.
//!
//! # Usage comes from the last frame, and is derived the way the meter derives it
//!
//! `stream_options.include_usage` is forced on server-side, so the last
//! content-bearing frame is followed by a usage-only chunk. Output tokens are
//! computed as `total − prompt` rather than read from `completion_tokens`,
//! because that is what the gateway's own meter does: Anthropic reports input
//! excluding cache reads and writes, and the gateway re-adds them into
//! `prompt_tokens` and recomputes `total_tokens` itself. Trusting
//! `completion_tokens` here would put Atlas's context accounting on a different
//! footing from the number the user is billed for.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use codex_client::ByteStream;
use codex_client::StreamResponse;
use codex_protocol::models::ReasoningItemContent;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::TokenUsage;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio::time::timeout;
use tracing::debug;
use tracing::trace;

use crate::atlas_gateway;
use crate::common::ResponseEvent;
use crate::common::ResponseStream;
use crate::error::ApiError;
use crate::telemetry::SseTelemetry;

/// The gateway's success sentinel.
const DONE_SENTINEL: &str = "[DONE]";

/// What the parser needs to know about the request that produced this stream.
#[derive(Debug, Clone, Default)]
pub struct ChatDialect {
    /// Tools that were freeform upstream and were flattened into functions to
    /// cross this wire, by name.
    ///
    /// Their replies have to be turned back into `CustomToolCall`s: the
    /// engine's router hands a `Function` payload to the matching handler, and
    /// the one that runs patches accepts only `Custom`, so a call that is not
    /// turned back is a tool that silently never runs.
    pub freeform_tools: BTreeSet<String>,
}

pub fn spawn_chat_stream(
    stream_response: StreamResponse,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
    dialect: ChatDialect,
) -> ResponseStream {
    // The gateway's own request id. Quoting it is what makes a support
    // conversation about one failed turn possible at all.
    let upstream_request_id = stream_response
        .headers
        .get("x-atlas-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let (tx_event, rx_event) = mpsc::channel::<Result<ResponseEvent, ApiError>>(1600);
    tokio::spawn(async move {
        process_chat_sse(
            stream_response.bytes,
            tx_event,
            idle_timeout,
            telemetry,
            dialect,
        )
        .await;
    });

    ResponseStream {
        rx_event,
        upstream_request_id,
    }
}

#[derive(Debug, Default, Deserialize)]
struct ChatChunk {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    delta: ChatDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatDelta {
    #[serde(default)]
    content: Option<String>,
    /// Claude's thinking, kept out of `content` by the gateway so a client that
    /// ignores it still sees only the answer.
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ChatToolCallDelta>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatToolCallDelta {
    /// Which call this fragment belongs to. Ids and names arrive once, on the
    /// opening fragment; arguments arrive in pieces afterwards with nothing but
    /// the index to tie them together.
    #[serde(default)]
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<ChatFunctionDelta>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatUsage {
    #[serde(default)]
    prompt_tokens: i64,
    #[serde(default)]
    total_tokens: i64,
    #[serde(default)]
    prompt_tokens_details: Option<ChatPromptTokensDetails>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatPromptTokensDetails {
    #[serde(default)]
    cached_tokens: i64,
}

impl From<ChatUsage> for TokenUsage {
    fn from(usage: ChatUsage) -> Self {
        let cached = usage
            .prompt_tokens_details
            .map(|details| details.cached_tokens)
            .unwrap_or(0);
        TokenUsage {
            input_tokens: usage.prompt_tokens,
            cached_input_tokens: cached,
            // The gateway folds cache writes into `prompt_tokens` and reports
            // no separate figure, so there is nothing honest to put here.
            cache_write_input_tokens: 0,
            // Derived, not read. See the module docs.
            output_tokens: (usage.total_tokens - usage.prompt_tokens).max(0),
            // Claude's output count already includes thinking tokens and the
            // gateway does not break them out, so this stays 0 rather than
            // guessing at a split.
            reasoning_output_tokens: 0,
            total_tokens: usage.total_tokens,
            codex_rollout_budget_units: None,
        }
    }
}

#[derive(Default)]
struct PartialToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

#[derive(Default)]
struct TurnState {
    response_id: Option<String>,
    text: String,
    reasoning: String,
    tool_calls: BTreeMap<u32, PartialToolCall>,
    finish_reason: Option<String>,
    usage: Option<TokenUsage>,
}

/// Did the model end its turn, or was it interrupted by something?
///
/// `tool_calls` is the one that matters: the turn continues, and reporting it
/// as ended would strand the tool results the engine is about to produce.
/// `length` means the answer was cut off at `max_tokens`, which is also not a
/// turn the model chose to end.
fn end_turn_for(finish_reason: Option<&str>) -> Option<bool> {
    finish_reason.map(|reason| matches!(reason, "stop" | "content_filter"))
}

async fn process_chat_sse(
    stream: ByteStream,
    tx_event: mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
    dialect: ChatDialect,
) {
    let mut stream = stream.eventsource();
    let mut state = TurnState::default();
    // Recorded rather than raised immediately: the gateway may still write
    // trailing frames, and the withheld `[DONE]` is what actually ends the
    // stream. Raised on close, so the error survives whatever follows it.
    let mut stream_error: Option<ApiError> = None;

    loop {
        let start = Instant::now();
        let polled = timeout(idle_timeout, stream.next()).await;
        if let Some(t) = telemetry.as_ref() {
            t.on_sse_poll(&polled, start.elapsed());
        }

        let sse = match polled {
            Ok(Some(Ok(sse))) => sse,
            Ok(Some(Err(err))) => {
                debug!("SSE error: {err:#}");
                let _ = tx_event.send(Err(ApiError::Stream(err.to_string()))).await;
                return;
            }
            Ok(None) => {
                // No `[DONE]`. Incomplete by the gateway's own rule — never a
                // short success.
                let error = stream_error.unwrap_or_else(|| {
                    ApiError::Stream(
                        "the model stream ended without `data: [DONE]`, so the answer is incomplete"
                            .to_string(),
                    )
                });
                let _ = tx_event.send(Err(error)).await;
                return;
            }
            Err(_) => {
                let _ = tx_event
                    .send(Err(ApiError::Stream("idle timeout waiting for SSE".into())))
                    .await;
                return;
            }
        };

        trace!("chat SSE frame: {}", &sse.data);

        if sse.data.trim() == DONE_SENTINEL {
            if let Some(error) = stream_error {
                // Belt and braces. The gateway withholds the sentinel after an
                // error frame, but if one ever arrived anyway the error still
                // wins: a truncated answer that looks finished is the exact
                // outcome the withholding rule exists to prevent.
                let _ = tx_event.send(Err(error)).await;
                return;
            }
            emit_turn(&tx_event, state, &dialect).await;
            return;
        }

        // The error frame carries no `choices`, so it has to be recognised
        // before the chunk parse rather than after it.
        if is_error_frame(&sse.data) {
            let disposition = atlas_gateway::classify_stream_frame(&sse.data);
            stream_error = Some(disposition.into_api_error());
            continue;
        }

        let chunk: ChatChunk = match serde_json::from_str(&sse.data) {
            Ok(chunk) => chunk,
            Err(err) => {
                debug!(error = %err, "failed to parse a chat.completion.chunk");
                continue;
            }
        };

        if state.response_id.is_none() {
            state.response_id = chunk.id.clone();
        }
        if let Some(usage) = chunk.usage {
            state.usage = Some(usage.into());
        }

        for choice in chunk.choices {
            if let Some(reason) = choice.finish_reason {
                state.finish_reason = Some(reason);
            }
            if let Some(delta) = choice.delta.reasoning_content.filter(|d| !d.is_empty()) {
                state.reasoning.push_str(&delta);
                if tx_event
                    .send(Ok(ResponseEvent::ReasoningContentDelta {
                        delta,
                        content_index: 0,
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            if let Some(delta) = choice.delta.content.filter(|d| !d.is_empty()) {
                state.text.push_str(&delta);
                if tx_event
                    .send(Ok(ResponseEvent::OutputTextDelta(delta)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            for call in choice.delta.tool_calls {
                let entry = state.tool_calls.entry(call.index).or_default();
                if let Some(id) = call.id {
                    entry.id = Some(id);
                }
                if let Some(function) = call.function {
                    if let Some(name) = function.name {
                        entry.name = Some(name);
                    }
                    if let Some(arguments) = function.arguments {
                        entry.arguments.push_str(&arguments);
                    }
                }
            }
        }
    }
}

/// Whether this frame is the gateway's in-stream failure, rather than a chunk.
fn is_error_frame(data: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .and_then(|value| value.get("error").cloned())
        .is_some_and(|error| !error.is_null())
}

async fn emit_turn(
    tx_event: &mpsc::Sender<Result<ResponseEvent, ApiError>>,
    state: TurnState,
    dialect: &ChatDialect,
) {
    let TurnState {
        response_id,
        text,
        reasoning,
        tool_calls,
        finish_reason,
        usage,
    } = state;

    // Thinking first, then the answer, then the calls — the order the model
    // produced them, and the order the Responses machine reports them in.
    if !reasoning.is_empty() {
        let item = ResponseItem::Reasoning {
            id: None,
            summary: Vec::new(),
            content: Some(vec![ReasoningItemContent::ReasoningText { text: reasoning }]),
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
        };
        if tx_event
            .send(Ok(ResponseEvent::OutputItemDone(item)))
            .await
            .is_err()
        {
            return;
        }
    }

    if !text.is_empty() {
        let item = ResponseItem::Message {
            id: None,
            role: "assistant".to_string(),
            content: vec![codex_protocol::models::ContentItem::OutputText { text }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        };
        if tx_event
            .send(Ok(ResponseEvent::OutputItemDone(item)))
            .await
            .is_err()
        {
            return;
        }
    }

    for (index, call) in tool_calls {
        let Some(name) = call.name else {
            debug!(index, "tool call fragment never named a function; dropped");
            continue;
        };
        // A provider that never sends an id leaves the engine unable to match
        // the result back, so a synthesised one beats no call at all.
        let call_id = call.id.unwrap_or_else(|| format!("call_{index}"));
        let item = if dialect.freeform_tools.contains(&name) {
            ResponseItem::CustomToolCall {
                id: None,
                status: None,
                call_id,
                name,
                namespace: None,
                input: unwrap_freeform_input(&call.arguments),
                internal_chat_message_metadata_passthrough: None,
            }
        } else {
            ResponseItem::FunctionCall {
                id: None,
                name,
                namespace: None,
                arguments: call.arguments,
                encrypted_function_args: None,
                call_id,
                internal_chat_message_metadata_passthrough: None,
            }
        };
        if tx_event
            .send(Ok(ResponseEvent::OutputItemDone(item)))
            .await
            .is_err()
        {
            return;
        }
    }

    let _ = tx_event
        .send(Ok(ResponseEvent::Completed {
            response_id: response_id.unwrap_or_default(),
            token_usage: usage,
            end_turn: end_turn_for(finish_reason.as_deref()),
        }))
        .await;
}

/// The text a freeform tool was actually given, out of the wrapper the request
/// builder had to put it in.
///
/// Falling back to the raw arguments keeps a malformed wrapper from becoming an
/// empty patch — the handler's own error is far more use than silence.
fn unwrap_freeform_input(arguments: &str) -> String {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("input")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| arguments.to_string())
}

#[cfg(test)]
#[path = "sse_tests.rs"]
mod tests;
