// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! The Chat Completions request body, built for the Atlas gateway (spec D3).
//!
//! Added by Atlas. The original engine deleted its Chat Completions dialect deliberately —
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

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use atlas_engine_protocol::models::AgentMessageInputContent;
use atlas_engine_protocol::models::ContentItem;
use atlas_engine_protocol::models::ResponseItem;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tracing::warn;

use super::sse::NamespacedTool;
use crate::error::ApiError;
use atlas_engine_protocol::DEFAULT_FUNCTION_NAMESPACE;

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

/// The gateway refuses a prompt whose conservative byte estimate exceeds this.
///
/// This deliberately does not use the provider's token usage: the gateway
/// measures the serialized prompt fields itself as `ceil(utf8_bytes / 3)`.
/// Keeping the same calculation on the client lets the turn compact before a
/// request that the gateway would certainly reject is put on the wire.
pub const GATEWAY_PROMPT_TOKEN_LIMIT: usize = 200_000;

/// The gateway's prompt meter for one Chat Completions request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GatewayPromptUsage {
    pub utf8_bytes: usize,
    pub tokens: usize,
}

impl GatewayPromptUsage {
    pub fn exceeds_limit(self) -> bool {
        self.tokens > GATEWAY_PROMPT_TOKEN_LIMIT
    }
}

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
    /// Whatever the provider attached to this call on the way out, returned
    /// byte-for-byte. Gemini 3's thought signature lives here, and the replay
    /// is a `400` without it. Absent for every provider that sent none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_content: Option<Value>,
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
    /// Names of tools that were freeform in the original tool shape and had to be flattened into
    /// functions to cross this wire.
    ///
    /// The reply has to be turned back, or the engine's router sends a
    /// `Function` payload to a handler that only accepts `Custom` and the tool
    /// silently never runs. The parser cannot work this out from the reply
    /// alone, so it is carried across from here.
    pub freeform_tools: BTreeSet<String>,
    /// Tools flattened out of a `namespace` (every MCP server's tools), by
    /// the flat name they crossed the wire under. See `flat_tool_name`.
    pub namespaced_tools: BTreeMap<String, NamespacedTool>,
}

/// Measure exactly the fields the gateway treats as model input.
///
/// `model`, `stream`, and `max_tokens` are transport/output controls, so they
/// are intentionally excluded. Serde's compact JSON representation is the
/// wire representation the gateway measures; counting Rust strings here would
/// miss JSON escaping and tool-schema structure.
pub fn gateway_prompt_usage(request: &ChatCompletionsRequest) -> GatewayPromptUsage {
    #[derive(Serialize)]
    struct PromptFields<'a> {
        messages: &'a [ChatMessage],
        #[serde(skip_serializing_if = "Option::is_none")]
        tools: &'a Option<Vec<Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_choice: &'a Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        response_format: &'a Option<Value>,
    }

    let utf8_bytes = serde_json::to_vec(&PromptFields {
        messages: &request.messages,
        tools: &request.tools,
        tool_choice: &request.tool_choice,
        response_format: &request.response_format,
    })
    .expect("Chat Completions prompt fields are always JSON serializable")
    .len();
    GatewayPromptUsage {
        utf8_bytes,
        tokens: utf8_bytes.div_ceil(3),
    }
}

pub fn build_chat_request(input: ChatRequestInput<'_>) -> Result<BuiltChatRequest, ApiError> {
    let mut messages: Vec<ChatMessage> = Vec::new();
    if !input.instructions.trim().is_empty() {
        messages.push(ChatMessage::System {
            content: input.instructions.to_string(),
        });
    }
    let keep_images_from = first_turn_keeping_images(input.items);
    for (index, item) in input.items.iter().enumerate() {
        push_item(&mut messages, item, index >= keep_images_from);
    }
    let messages = merge_adjacent(messages);

    let Reshaped {
        tools,
        freeform_tools,
        namespaced_tools,
    } = reshape_tools(input.tools);

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
        namespaced_tools,
    })
}

fn text_of(content: &[ContentItem]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                Some(text.as_str())
            }
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

/// The index from which replayed images keep their bytes (D15c).
///
/// Everything before it is described rather than re-sent. The engine is
/// stateless — it replays the whole conversation on every request — so an image
/// attached once is re-uploaded on every subsequent turn of that thread. The
/// gateway's body cap is **2 MB, counted before parsing**, which a handful of
/// screenshots crosses long before any token ceiling; past that point the
/// thread `413`s forever and the only escape is starting a new one.
///
/// The boundary is the **immediately-preceding user turn**, so the model still
/// sees an image while it is being discussed, and stops carrying it once the
/// conversation has moved on. A placeholder goes in its place rather than
/// nothing, because an image that silently vanishes makes the surrounding
/// messages read as if they referred to something that was never there.
fn first_turn_keeping_images(items: &[ResponseItem]) -> usize {
    let user_turns: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            matches!(item, ResponseItem::Message { role, .. } if role != "assistant" && role != "system" && role != "developer")
        })
        .map(|(index, _)| index)
        .collect();
    // The current turn and the one before it.
    user_turns
        .len()
        .checked_sub(2)
        .and_then(|i| user_turns.get(i))
        .copied()
        .unwrap_or(0)
}

/// The text that stands in for an evicted image.
const EVICTED_IMAGE: &str = "[earlier image omitted to stay within the request size limit]";

fn push_item(messages: &mut Vec<ChatMessage>, item: &ResponseItem, keep_images: bool) {
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
                let mut parts = parts_of(content);
                if !keep_images {
                    evict_images(&mut parts);
                }
                if !parts.is_empty() {
                    messages.push(ChatMessage::User { content: parts });
                }
            }
        },
        ResponseItem::FunctionCall {
            name,
            namespace,
            arguments,
            call_id,
            internal_chat_message_metadata_passthrough,
            ..
        } => messages.push(ChatMessage::Assistant {
            content: None,
            tool_calls: vec![ToolCallOut {
                id: call_id.clone(),
                kind: "function".to_string(),
                function: FunctionCallOut {
                    // Under the flat name it was offered as, or the model's
                    // own history names a tool it was never given.
                    name: wire_name(namespace.as_deref(), name),
                    // The gateway's Anthropic translation rejects invalid JSON
                    // arguments with a `400` rather than emptying the call, so
                    // an unparseable string here fails the whole request. An
                    // empty object is the one value that is always valid and
                    // always means "no arguments".
                    arguments: valid_json_arguments(arguments),
                },
                extra_content: extra_content_of(internal_chat_message_metadata_passthrough),
            }],
        }),
        ResponseItem::CustomToolCall {
            name,
            namespace,
            input,
            call_id,
            internal_chat_message_metadata_passthrough,
            ..
        } => messages.push(ChatMessage::Assistant {
            content: None,
            tool_calls: vec![ToolCallOut {
                id: call_id.clone(),
                kind: "function".to_string(),
                function: FunctionCallOut {
                    name: wire_name(namespace.as_deref(), name),
                    // Flattened on the way out, so it has to be re-wrapped on
                    // the way back in. See `flatten_freeform`.
                    arguments: json!({ "input": input }).to_string(),
                },
                extra_content: extra_content_of(internal_chat_message_metadata_passthrough),
            }],
        }),
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        } => messages.push(ChatMessage::Tool {
            tool_call_id: call_id.clone(),
            content: output.body.to_text().unwrap_or_default(),
        }),
        ResponseItem::CustomToolCallOutput {
            call_id, output, ..
        } => messages.push(ChatMessage::Tool {
            tool_call_id: call_id.clone(),
            content: output.body.to_text().unwrap_or_default(),
        }),
        // Thinking has no wire here. The gateway keeps Claude's thinking out of
        // `content` on the way back and documents no way to send it in, so a
        // replayed reasoning item would be a `400` at best. This is the
        // accepted loss recorded in the gateway-fit research, not an oversight.
        ResponseItem::Reasoning { .. } => {}
        // Inter-agent mail (multi-agent v2): a spawned child's task, a parent's
        // follow-up, a child's FINAL_ANSWER. The Responses wire carries it as
        // an item of its own; Chat Completions has no such thing, so it rides
        // as a user message — which is the form the engine's own agent charter
        // tells the model to expect ("messages in the analysis channel: Message
        // Type / Task name / Sender / Payload").
        //
        // `encrypted_content` is not encrypted on this path. The engine uses
        // `new_encrypted` for any message that did not come straight from a
        // user's plaintext, and the gateway does no envelope encryption, so
        // the field holds the message itself (the rollouts show it verbatim).
        //
        // Before this arm the item fell through to the drop below. A child then
        // never saw its task — it ran on its system prompt alone, which is why
        // "count the files" became a hundred-call tour of the repository — and
        // the parent never saw a result, so it polled `wait_agent` until the
        // user stopped it.
        ResponseItem::AgentMessage { content, .. } => {
            let text: String = content
                .iter()
                .map(|part| match part {
                    AgentMessageInputContent::InputText { text } => text.as_str(),
                    AgentMessageInputContent::EncryptedContent { encrypted_content } => {
                        encrypted_content.as_str()
                    }
                })
                .collect();
            if !text.is_empty() {
                messages.push(ChatMessage::User {
                    content: vec![ContentPart::Text { text }],
                });
            }
        }
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

/// The provider metadata a replayed tool call has to carry, if the stream
/// parser recorded any on it.
fn extra_content_of(
    passthrough: &Option<atlas_engine_protocol::models::InternalChatMessageMetadataPassthrough>,
) -> Option<Value> {
    passthrough
        .as_ref()
        .and_then(|metadata| metadata.atlas_tool_call_extra_content.clone())
}

/// Replaces image parts with a placeholder, keeping the turn's text intact.
fn evict_images(parts: &mut Vec<ContentPart>) {
    let mut evicted = false;
    parts.retain(|part| {
        let is_image = matches!(part, ContentPart::ImageUrl { .. });
        evicted |= is_image;
        !is_image
    });
    if evicted {
        parts.push(ContentPart::Text {
            text: EVICTED_IMAGE.to_string(),
        });
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

/// Responses tools, reshaped for this wire, plus what the reply needs to turn
/// each flattened call back into the shape the engine dispatches.
struct Reshaped {
    tools: Option<Vec<Value>>,
    freeform_tools: BTreeSet<String>,
    namespaced_tools: BTreeMap<String, NamespacedTool>,
}

/// Responses tool JSON → Chat Completions tool JSON.
///
/// Records the names of tools that had to be flattened out of a shape this
/// wire has no word for, so the reply can be turned back into that shape.
fn reshape_tools(tools: &[Value]) -> Reshaped {
    let mut reshaped = Reshaped {
        tools: None,
        freeform_tools: BTreeSet::new(),
        namespaced_tools: BTreeMap::new(),
    };
    let mut out = Vec::with_capacity(tools.len());

    for tool in tools {
        let kind = tool.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "function" | "custom" => {
                if let Some(value) = reshape_one(tool, None, &mut reshaped) {
                    out.push(value);
                }
            }
            // One per MCP server. This wire has no namespaces, so each tool
            // inside crosses as an ordinary function under a flat name, and
            // the reply is mapped back to (namespace, name) for the router.
            // Dropping the namespace instead hid every MCP tool from the model.
            "namespace" => {
                let Some(namespace) = tool.get("name").and_then(Value::as_str) else {
                    warn!("tool dropped: a namespace with no name");
                    continue;
                };
                for child in tool
                    .get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(value) = reshape_one(child, Some(namespace), &mut reshaped) {
                        out.push(value);
                    }
                }
            }
            // `tool_search` and `web_search` are Responses-native and have no
            // representation here. Sending one as-is would be a `400` that
            // kills the whole request rather than one tool, so they are
            // dropped — and the authored catalogue turns each of them off,
            // which is why this should not fire in a shipped build.
            other => warn!(tool_type = other, "tool dropped: no Chat Completions shape"),
        }
    }

    reshaped.tools = (!out.is_empty()).then_some(out);
    reshaped
}

/// One `function` or `custom` tool, optionally from inside a namespace.
fn reshape_one(tool: &Value, namespace: Option<&str>, reshaped: &mut Reshaped) -> Option<Value> {
    let kind = tool.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(own_name) = tool.get("name").and_then(Value::as_str) else {
        warn!(tool_type = kind, "tool dropped: a tool with no name");
        return None;
    };
    let name = wire_name(namespace, own_name);
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let value = match kind {
        "function" => json!({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                // `function.parameters` is what the gateway rewrites
                // into Anthropic's `input_schema`, so the key name is
                // load-bearing rather than cosmetic.
                "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            }
        }),
        "custom" => {
            reshaped.freeform_tools.insert(name.clone());
            flatten_freeform(&name, description)
        }
        other => {
            warn!(tool_type = other, "tool dropped: no Chat Completions shape");
            return None;
        }
    };
    if let Some(namespace) = namespace.filter(|ns| !is_default_namespace(ns)) {
        reshaped.namespaced_tools.insert(
            name,
            NamespacedTool {
                namespace: namespace.to_string(),
                name: own_name.to_string(),
            },
        );
    }
    Some(value)
}

fn is_default_namespace(namespace: &str) -> bool {
    namespace.is_empty() || namespace == DEFAULT_FUNCTION_NAMESPACE
}

/// The name a tool crosses this wire under: bare in the default namespace,
/// flattened otherwise.
fn wire_name(namespace: Option<&str>, name: &str) -> String {
    match namespace {
        Some(ns) if !is_default_namespace(ns) => flat_tool_name(ns, name),
        _ => name.to_string(),
    }
}

/// Longest tool name every provider behind the gateway accepts.
const MAX_TOOL_NAME: usize = 64;

/// One flat name for a namespaced tool, in the characters and length every
/// provider behind the gateway accepts (`[A-Za-z0-9_-]{1,64}`).
///
/// MCP namespaces already end in `__` (`mcp__server__`), so the joined name
/// reads the way the engine's own flat MCP names do. A name that would run
/// long is cut and suffixed with a hash of the whole, so it stays stable
/// across turns and distinct from its neighbours.
pub(crate) fn flat_tool_name(namespace: &str, name: &str) -> String {
    let joined = if namespace.ends_with("__") {
        format!("{namespace}{name}")
    } else {
        format!("{namespace}__{name}")
    };
    let clean: String = joined
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if clean.len() <= MAX_TOOL_NAME {
        return clean;
    }
    // FNV-1a over the original, so two names that clean to the same prefix
    // still come apart.
    let hash = joined.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    let suffix = format!("_{:08x}", hash as u32);
    format!("{}{suffix}", &clean[..MAX_TOOL_NAME - suffix.len()])
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
