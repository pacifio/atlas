// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! The Chat Completions request body, built for the Atlas gateway (spec D3).
//!
//! Added by Atlas. Upstream deleted its Chat Completions dialect deliberately —
//! `wire_api = "chat"` fails to deserialize with an error pointing at the
//! removal discussion — so there was nothing to resurrect and this is authored
//! from scratch against the gateway contract (`docs/reference/atlas-ai-api.md`).
//!
//! # The rule this file exists to enforce
//!
//! The gateway rejects **anything not on its forwarded allowlist**, nested
//! unknown keys included, with a `400` rather than a silent drop. Ten of the
//! fifteen fields the Responses builder sends today are off that list, so a
//! request assembled the old way fails outright. The defence here is
//! structural rather than a filter: the request *type* has only allowlisted
//! fields, so there is no field to forget to strip. [`ALLOWED_TOP_LEVEL_KEYS`]
//! and the test below are what keep that true as the type changes.
//!
//! # `max_tokens` is never absent
//!
//! Absence is not "no limit" here — the gateway injects `4,096`, counted
//! *reasoning-inclusive*, which silently truncates a reasoning-heavy agent turn
//! and looks like the model stopping early. So the field is non-optional in the
//! type.
//!
//! # Six parameters are refused on Claude
//!
//! `temperature`, `top_p`, `seed`, `presence_penalty`, `frequency_penalty` and
//! `response_format` are on the forwarded list but are a `400 invalid_parameter`
//! on Claude models — which the default `claude-sonnet-4-6` is. Five of them
//! this builder never emits at all. `response_format` it *would* emit, for a
//! schema-constrained turn — so a schema-constrained turn against a Claude
//! model is **refused here**, with an error naming the limit.
//!
//! Refusing is the harder-looking choice and the right one. Dropping the schema
//! and sending the turn anyway returns free text where the caller asked for
//! JSON, bills them for it, and gives them nothing to connect the two — the
//! precise failure the gateway's own allowlist rule exists to prevent
//! ("Silently dropping is the failure this rule exists to prevent"). The
//! gateway would answer the same request with a `400` anyway; this says so one
//! round trip earlier, and says which parameter and why.

use std::collections::BTreeSet;

use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tracing::warn;

use crate::error::ApiError;

/// The gateway's hard clamp on `max_tokens`. Asking for more is not an error,
/// but nothing above this is honoured.
pub const OUTPUT_TOKEN_CLAMP: u32 = 32_768;

/// What Atlas asks for when nothing else says otherwise.
///
/// The two failure directions are not symmetric, which is why this is neither
/// the clamp nor something small:
///
/// - too low truncates an agent turn mid-answer, and the truncation is
///   invisible — it reads as the model deciding to stop;
/// - too high is charged before the call, not after. The gateway reserves the
///   **full clamped `max_tokens`** against the caller's cap up front, so asking
///   for the ceiling on every turn makes small turns expensive and can put a
///   modest cap permanently out of reach of a large model.
///
/// Well clear of the injected 4,096 that causes the first, at half the
/// reservation of the second.
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 16_384;

/// Every key this builder may put at the top level of a request body.
///
/// `model`, `max_tokens` and `stream` are the server-overridden trio; the rest
/// are forwarded unchanged. Anything else — including a nested unknown — is a
/// `400`, so this list is the contract, not a style preference.
pub const ALLOWED_TOP_LEVEL_KEYS: &[&str] = &[
    "model",
    "messages",
    "stream",
    "max_tokens",
    "tools",
    "tool_choice",
    "response_format",
    "stop",
];

/// Forwarded by the gateway, refused by Claude.
///
/// Named so the test below can assert none of them is ever emitted, rather
/// than relying on nobody adding one.
pub const REFUSED_BY_CLAUDE: &[&str] = &[
    "temperature",
    "top_p",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "response_format",
];

/// Whether the gateway will serve this slug through Anthropic's Messages API.
///
/// Read off the slug rather than off a capability the catalogue authors,
/// because it is a fact about the *gateway*, not about the model: the contract
/// names the Claude family as the set whose six sampling parameters are
/// refused. A capability row would restate that one layer away from the
/// document that decides it, and the two would drift.
pub fn is_claude_model(slug: &str) -> bool {
    slug.to_ascii_lowercase().starts_with("claude")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatCompletionsRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    /// Never optional. See the module docs.
    pub max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ChatMessage {
    System {
        content: String,
    },
    User {
        content: Vec<ContentPart>,
    },
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCallOut>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlPart },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageUrlPart {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolCallOut {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCallOut,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FunctionCallOut {
    pub name: String,
    pub arguments: String,
}

/// What the turn has to say, in the engine's own vocabulary.
pub struct ChatRequestInput<'a> {
    pub model: &'a str,
    /// The baked system prompt. Becomes the leading `system` message, because
    /// the Responses `instructions` field is not on the allowlist.
    pub instructions: &'a str,
    pub items: &'a [ResponseItem],
    /// Tools in the Responses API's own JSON shape, as
    /// `create_tools_json_for_responses_api` produces them. Re-shaped here.
    pub tools: &'a [Value],
    pub max_output_tokens: u32,
    pub output_schema: Option<&'a Value>,
}

/// A built request, plus the one thing the stream parser needs to know about it.
pub struct BuiltChatRequest {
    pub request: ChatCompletionsRequest,
    /// Names of tools that were freeform upstream and had to be flattened into
    /// functions to cross this wire.
    ///
    /// The reply has to be turned back, or the engine's router sends a
    /// `Function` payload to a handler that only accepts `Custom` and the tool
    /// silently never runs. The parser cannot work this out from the reply
    /// alone, so it is carried across from here.
    pub freeform_tools: BTreeSet<String>,
}

pub fn build_chat_request(input: ChatRequestInput<'_>) -> Result<BuiltChatRequest, ApiError> {
    let mut messages: Vec<ChatMessage> = Vec::new();
    if !input.instructions.trim().is_empty() {
        messages.push(ChatMessage::System {
            content: input.instructions.to_string(),
        });
    }
    for item in input.items {
        push_item(&mut messages, item);
    }
    let messages = merge_adjacent(messages);

    let (tools, freeform_tools) = reshape_tools(input.tools);

    // The one allowlisted parameter this builder would otherwise send blind.
    let response_format = match input.output_schema {
        Some(schema) if !is_claude_model(input.model) => Some(json!({
            "type": "json_schema",
            "json_schema": { "name": "response", "strict": true, "schema": schema },
        })),
        // Refused, not dropped. See the module docs: a schema-constrained turn
        // that quietly comes back as prose is worse than one that does not run.
        Some(_) => {
            return Err(ApiError::InvalidRequest {
                message: format!(
                    "{} cannot answer with a fixed JSON schema. The gateway serves Claude \
                     through Anthropic's API, which refuses `response_format` with \
                     400 invalid_parameter. Choose a Gemini model for this turn.",
                    input.model,
                ),
            });
        }
        None => None,
    };

    Ok(BuiltChatRequest {
        request: ChatCompletionsRequest {
            model: input.model.to_string(),
            messages,
            stream: true,
            max_tokens: input.max_output_tokens.clamp(1, OUTPUT_TOKEN_CLAMP),
            tool_choice: tools.as_ref().map(|_| "auto".to_string()),
            tools,
            response_format,
        },
        freeform_tools,
    })
}

fn text_of(content: &[ContentItem]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn parts_of(content: &[ContentItem]) -> Vec<ContentPart> {
    content
        .iter()
        .filter_map(|part| match part {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                Some(ContentPart::Text { text: text.clone() })
            }
            ContentItem::InputImage { image_url, .. } => Some(ContentPart::ImageUrl {
                image_url: ImageUrlPart {
                    url: image_url.clone(),
                },
            }),
            // Audio has no Chat Completions counterpart on this gateway.
            ContentItem::InputAudio { .. } => None,
        })
        .collect()
}

fn push_item(messages: &mut Vec<ChatMessage>, item: &ResponseItem) {
    match item {
        ResponseItem::Message { role, content, .. } => match role.as_str() {
            // The Responses API's "developer" role is the system prompt's own
            // role; Chat Completions has no such thing, and the gateway
            // concatenates system messages in order for Anthropic anyway.
            "system" | "developer" => {
                let text = text_of(content);
                if !text.is_empty() {
                    messages.push(ChatMessage::System { content: text });
                }
            }
            "assistant" => {
                let text = text_of(content);
                if !text.is_empty() {
                    messages.push(ChatMessage::Assistant {
                        content: Some(text),
                        tool_calls: Vec::new(),
                    });
                }
            }
            _ => {
                let parts = parts_of(content);
                if !parts.is_empty() {
                    messages.push(ChatMessage::User { content: parts });
                }
            }
        },
        ResponseItem::FunctionCall {
            name,
            arguments,
            call_id,
            ..
        } => messages.push(ChatMessage::Assistant {
            content: None,
            tool_calls: vec![ToolCallOut {
                id: call_id.clone(),
                kind: "function".to_string(),
                function: FunctionCallOut {
                    name: name.clone(),
                    // The gateway's Anthropic translation rejects invalid JSON
                    // arguments with a `400` rather than emptying the call, so
                    // an unparseable string here fails the whole request. An
                    // empty object is the one value that is always valid and
                    // always means "no arguments".
                    arguments: valid_json_arguments(arguments),
                },
            }],
        }),
        ResponseItem::CustomToolCall {
            name,
            input,
            call_id,
            ..
        } => messages.push(ChatMessage::Assistant {
            content: None,
            tool_calls: vec![ToolCallOut {
                id: call_id.clone(),
                kind: "function".to_string(),
                function: FunctionCallOut {
                    name: name.clone(),
                    // Flattened on the way out, so it has to be re-wrapped on
                    // the way back in. See `flatten_freeform`.
                    arguments: json!({ "input": input }).to_string(),
                },
            }],
        }),
        ResponseItem::FunctionCallOutput { call_id, output, .. } => {
            messages.push(ChatMessage::Tool {
                tool_call_id: call_id.clone(),
                content: output.body.to_text().unwrap_or_default(),
            })
        }
        ResponseItem::CustomToolCallOutput { call_id, output, .. } => {
            messages.push(ChatMessage::Tool {
                tool_call_id: call_id.clone(),
                content: output.body.to_text().unwrap_or_default(),
            })
        }
        // Thinking has no wire here. The gateway keeps Claude's thinking out of
        // `content` on the way back and documents no way to send it in, so a
        // replayed reasoning item would be a `400` at best. This is the
        // accepted loss recorded in the gateway-fit research, not an oversight.
        ResponseItem::Reasoning { .. } => {}
        // Responses-native items with no Chat Completions counterpart. The
        // authored catalogue turns off every feature that produces one, so
        // reaching this arm means something was configured on that this wire
        // cannot carry — worth a line in the log rather than a silent hole in
        // the transcript.
        other => {
            warn!(item = ?std::mem::discriminant(other), "item dropped: no Chat Completions shape");
        }
    }
}

/// Arguments the gateway's Anthropic translation will accept.
fn valid_json_arguments(arguments: &str) -> String {
    if serde_json::from_str::<Value>(arguments).is_ok() {
        arguments.to_string()
    } else {
        warn!("tool-call arguments were not valid JSON; sending an empty object");
        "{}".to_string()
    }
}

/// Collapses runs of same-role messages.
///
/// Parallel tool calls arrive as several consecutive `FunctionCall` items,
/// which is one assistant turn holding several `tool_calls` on this wire — and
/// Anthropic, which the gateway translates to for the default model, wants one
/// turn per role rather than a run of them.
fn merge_adjacent(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::with_capacity(messages.len());
    for message in messages {
        match (out.last_mut(), message) {
            (Some(ChatMessage::System { content: prev }), ChatMessage::System { content }) => {
                prev.push_str("\n\n");
                prev.push_str(&content);
            }
            (Some(ChatMessage::User { content: prev }), ChatMessage::User { content }) => {
                prev.extend(content);
            }
            (
                Some(ChatMessage::Assistant {
                    content: prev_content,
                    tool_calls: prev_calls,
                }),
                ChatMessage::Assistant {
                    content,
                    tool_calls,
                },
            ) => {
                if let Some(text) = content {
                    match prev_content {
                        Some(prev) => {
                            prev.push('\n');
                            prev.push_str(&text);
                        }
                        None => *prev_content = Some(text),
                    }
                }
                prev_calls.extend(tool_calls);
            }
            (_, message) => out.push(message),
        }
    }
    out
}

/// Responses tool JSON → Chat Completions tool JSON.
///
/// Returns the names of tools that had to be flattened out of a shape this wire
/// has no word for, so the reply can be turned back into that shape.
fn reshape_tools(tools: &[Value]) -> (Option<Vec<Value>>, BTreeSet<String>) {
    let mut out = Vec::with_capacity(tools.len());
    let mut freeform = BTreeSet::new();

    for tool in tools {
        let kind = tool.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "function" => {
                let Some(name) = tool.get("name").and_then(Value::as_str) else {
                    warn!("tool dropped: a function tool with no name");
                    continue;
                };
                out.push(json!({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": tool.get("description").and_then(Value::as_str).unwrap_or_default(),
                        // `function.parameters` is what the gateway rewrites
                        // into Anthropic's `input_schema`, so the key name is
                        // load-bearing rather than cosmetic.
                        "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                    }
                }));
            }
            "custom" => {
                let Some(name) = tool.get("name").and_then(Value::as_str) else {
                    warn!("tool dropped: a freeform tool with no name");
                    continue;
                };
                freeform.insert(name.to_string());
                out.push(flatten_freeform(
                    name,
                    tool.get("description").and_then(Value::as_str).unwrap_or_default(),
                ));
            }
            // `namespace`, `tool_search` and `web_search` are Responses-native
            // and have no representation here. Sending one as-is would be a
            // `400` that kills the whole request rather than one tool, so they
            // are dropped — and the authored catalogue turns each of them off,
            // which is why this should not fire in a shipped build.
            other => warn!(tool_type = other, "tool dropped: no Chat Completions shape"),
        }
    }

    ((!out.is_empty()).then_some(out), freeform)
}

/// A freeform tool, expressed as the only shape this wire has.
///
/// Freeform tools take one blob of text in a grammar of their own —
/// `apply_patch` is the one that matters. Chat Completions has only
/// JSON-argument functions, so the blob becomes a single required string and
/// the parser unwraps it again on the way back.
fn flatten_freeform(name: &str, description: &str) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": format!(
                "{description}\n\nPass the entire tool input, verbatim and unescaped, as the `input` string."
            ),
            "parameters": {
                "type": "object",
                "properties": { "input": { "type": "string" } },
                "required": ["input"],
                "additionalProperties": false,
            },
        }
    })
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
