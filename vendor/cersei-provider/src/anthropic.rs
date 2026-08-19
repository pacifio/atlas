//! Anthropic provider: Claude API client with streaming SSE support.

use crate::*;
use cersei_types::*;
use futures::StreamExt;
use tokio::sync::mpsc;

const ANTHROPIC_API_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const ANTHROPIC_BETA_HEADER: &str =
    "interleaved-thinking-2025-04-14,token-efficient-tools-2025-02-19";

// ─── Anthropic provider ──────────────────────────────────────────────────────

#[allow(dead_code)]
pub struct Anthropic {
    auth: Auth,
    base_url: String,
    default_model: String,
    thinking_budget: Option<u32>,
    max_retries: u32,
    client: reqwest::Client,
}

impl Anthropic {
    pub fn new(auth: Auth) -> Self {
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| ANTHROPIC_API_BASE.to_string());
        Self {
            auth,
            base_url,
            default_model: "claude-sonnet-4-6".to_string(),
            thinking_budget: None,
            max_retries: 5,
            client: reqwest::Client::new(),
        }
    }

    /// Create from `ANTHROPIC_API_KEY` environment variable.
    pub fn from_env() -> Result<Self> {
        let key = std::env::var("ANTHROPIC_API_KEY")
            .map_err(|_| CerseiError::Auth("ANTHROPIC_API_KEY not set".into()))?;
        Ok(Self::new(Auth::ApiKey(key)))
    }

    pub fn builder() -> AnthropicBuilder {
        AnthropicBuilder::default()
    }

    async fn auth_headers(&self) -> Result<Vec<(String, String)>> {
        match &self.auth {
            Auth::ApiKey(key) => Ok(vec![("x-api-key".into(), key.clone())]),
            Auth::Bearer(token) => Ok(vec![("authorization".into(), format!("Bearer {}", token))]),
            Auth::OAuth { token, .. } => Ok(vec![(
                "authorization".into(),
                format!("Bearer {}", token.access_token),
            )]),
            Auth::Custom(provider) => {
                let (name, value) = provider.get_credentials().await?;
                Ok(vec![(name, value)])
            }
        }
    }
}

#[async_trait::async_trait]
impl Provider for Anthropic {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn context_window(&self, model: &str) -> u64 {
        match model {
            m if m.contains("opus") => 200_000,
            m if m.contains("sonnet") => 200_000,
            m if m.contains("haiku") => 200_000,
            _ => 200_000,
        }
    }

    fn capabilities(&self, _model: &str) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_use: true,
            vision: true,
            thinking: true,
            system_prompt: true,
            caching: true,
        }
    }

    async fn complete(&self, request: CompletionRequest) -> Result<CompletionStream> {
        let model = if request.model.is_empty() {
            self.default_model.clone()
        } else {
            request.model.clone()
        };

        let thinking_budget = request
            .options
            .get::<u32>("thinking_budget")
            .or(self.thinking_budget);
        // Direct Anthropic: include "model" in the body, no vertex version.
        let body = build_anthropic_body(Some(&model), &request, thinking_budget, None);

        let url = format!("{}/v1/messages", self.base_url);
        let mut req_builder = self
            .client
            .post(&url)
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("anthropic-beta", ANTHROPIC_BETA_HEADER)
            .header("content-type", "application/json");
        for (name, value) in self.auth_headers().await? {
            req_builder = req_builder.header(&name, &value);
        }

        let http_request = req_builder.json(&body).build().map_err(CerseiError::Http)?;
        Ok(spawn_sse(self.client.clone(), http_request))
    }
}

// ─── Shared request/stream helpers (reused by the Vertex provider) ─────────────

/// Build the Anthropic Messages request body.
///
/// - `model`: `Some(model)` for direct Anthropic (adds the `model` field);
///   `None` for Vertex (model is in the URL path; adds `anthropic_version`).
/// - Prompt caching: a `cache_control: {type: ephemeral}` breakpoint is placed
///   on the tool list and the system prompt (the stable prefix), so multi-turn
///   runs reuse the cached prefix. (Inspired by efficiency-focused agents like
///   vix/codex; implemented via Anthropic's native prompt caching.)
pub(crate) fn build_anthropic_body(
    model: Option<&str>,
    request: &CompletionRequest,
    thinking_budget: Option<u32>,
    vertex_version: Option<&str>,
) -> serde_json::Value {
    let api_messages: Vec<serde_json::Value> = request
        .messages
        .iter()
        .filter(|m| m.role != Role::System)
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut body = serde_json::json!({
        "max_tokens": request.max_tokens,
        "messages": api_messages,
        "stream": true,
    });
    if let Some(m) = model {
        body["model"] = serde_json::Value::String(m.to_string());
    }
    if let Some(v) = vertex_version {
        body["anthropic_version"] = serde_json::Value::String(v.to_string());
    }

    // System prompt as a cacheable content block (stable prefix).
    if let Some(system) = &request.system {
        body["system"] = serde_json::json!([{
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" },
        }]);
    }

    // Tools, with a cache breakpoint on the last tool (caches the whole tool set).
    if !request.tools.is_empty() {
        let mut api_tools: Vec<serde_json::Value> = request
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();
        if let Some(last) = api_tools.last_mut() {
            last["cache_control"] = serde_json::json!({ "type": "ephemeral" });
        }
        body["tools"] = serde_json::Value::Array(api_tools);
    }

    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }
    if !request.stop_sequences.is_empty() {
        body["stop_sequences"] = serde_json::json!(request.stop_sequences);
    }
    if let Some(budget) = thinking_budget {
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
    }
    body
}

/// Spawn an SSE consumer that parses Anthropic streaming events into a
/// `CompletionStream`. Shared by the direct and Vertex providers.
pub(crate) fn spawn_sse(client: reqwest::Client, request: reqwest::Request) -> CompletionStream {
    let (tx, rx) = mpsc::channel(256);
    tokio::spawn(async move {
        match client.execute(request).await {
            Ok(response) => {
                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    // ATLAS PATCH (retry-after-v1): fold the Retry-After
                    // header into the error string before `.text()` consumes
                    // the response — the retry classifier reads it from here.
                    let retry_after = crate::retry_after_suffix(&response);
                    let body = response.text().await.unwrap_or_default();
                    let _ = tx
                        .send(StreamEvent::Error {
                            message: format!("HTTP {}{}: {}", status, retry_after, body),
                        })
                        .await;
                    return;
                }
                let mut stream = response.bytes_stream();
                let mut buffer = String::new();
                let mut utf8 = crate::utf8::Utf8ChunkDecoder::new();
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            utf8.push(&bytes, &mut buffer);
                            while let Some(pos) = buffer.find("\n\n") {
                                let event_str = buffer[..pos].to_string();
                                buffer = buffer[pos + 2..].to_string();
                                if let Some(event) = parse_sse_event(&event_str) {
                                    if tx.send(event).await.is_err() {
                                        return;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(StreamEvent::Error { message: e.to_string() }).await;
                            return;
                        }
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(StreamEvent::Error { message: e.to_string() }).await;
            }
        }
    });
    CompletionStream::new(rx)
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

fn parse_sse_event(raw: &str) -> Option<StreamEvent> {
    let mut event_type = String::new();
    let mut data = String::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("event: ") {
            event_type = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data: ") {
            data = rest.trim().to_string();
        }
    }

    let json: serde_json::Value = serde_json::from_str(&data).ok()?;

    match event_type.as_str() {
        "message_start" => {
            let msg = &json["message"];
            Some(StreamEvent::MessageStart {
                id: msg["id"].as_str().unwrap_or("").to_string(),
                model: msg["model"].as_str().unwrap_or("").to_string(),
            })
        }
        "content_block_start" => {
            let index = json["index"].as_u64().unwrap_or(0) as usize;
            let block_type = json["content_block"]["type"]
                .as_str()
                .unwrap_or("text")
                .to_string();
            Some(StreamEvent::ContentBlockStart {
                index,
                block_type,
                id: json["content_block"]["id"].as_str().map(String::from),
                name: json["content_block"]["name"].as_str().map(String::from),
            })
        }
        "content_block_delta" => {
            let index = json["index"].as_u64().unwrap_or(0) as usize;
            let delta = &json["delta"];
            let delta_type = delta["type"].as_str().unwrap_or("");
            match delta_type {
                "text_delta" => Some(StreamEvent::TextDelta {
                    index,
                    text: delta["text"].as_str().unwrap_or("").to_string(),
                }),
                "input_json_delta" => Some(StreamEvent::InputJsonDelta {
                    index,
                    partial_json: delta["partial_json"].as_str().unwrap_or("").to_string(),
                }),
                "thinking_delta" => Some(StreamEvent::ThinkingDelta {
                    index,
                    thinking: delta["thinking"].as_str().unwrap_or("").to_string(),
                }),
                _ => None,
            }
        }
        "content_block_stop" => {
            let index = json["index"].as_u64().unwrap_or(0) as usize;
            Some(StreamEvent::ContentBlockStop { index })
        }
        "message_delta" => {
            let stop_reason = json["delta"]["stop_reason"].as_str().and_then(|s| match s {
                "end_turn" => Some(StopReason::EndTurn),
                "max_tokens" => Some(StopReason::MaxTokens),
                "tool_use" => Some(StopReason::ToolUse),
                "stop_sequence" => Some(StopReason::StopSequence),
                _ => None,
            });
            let usage = if let Some(u) = json["usage"].as_object() {
                Some(Usage {
                    input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    ..Default::default()
                })
            } else {
                None
            };
            Some(StreamEvent::MessageDelta { stop_reason, usage })
        }
        "message_stop" => Some(StreamEvent::MessageStop),
        "ping" => Some(StreamEvent::Ping),
        "error" => Some(StreamEvent::Error {
            message: json["error"]["message"]
                .as_str()
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => None,
    }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct AnthropicBuilder {
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    thinking_budget: Option<u32>,
    oauth_token: Option<OAuthToken>,
    max_retries: Option<u32>,
}

impl AnthropicBuilder {
    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn thinking(mut self, budget_tokens: u32) -> Self {
        self.thinking_budget = Some(budget_tokens);
        self
    }

    pub fn oauth(mut self, token: OAuthToken) -> Self {
        self.oauth_token = Some(token);
        self
    }

    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = Some(n);
        self
    }

    pub fn build(self) -> Result<Anthropic> {
        let auth = if let Some(token) = self.oauth_token {
            Auth::OAuth {
                client_id: String::new(),
                token,
            }
        } else if let Some(key) = self.api_key {
            Auth::ApiKey(key)
        } else {
            return Err(CerseiError::Auth(
                "No API key or OAuth token provided. Set ANTHROPIC_API_KEY or use .oauth()".into(),
            ));
        };

        Ok(Anthropic {
            auth,
            base_url: self
                .base_url
                .unwrap_or_else(|| ANTHROPIC_API_BASE.to_string()),
            default_model: self
                .model
                .unwrap_or_else(|| "claude-sonnet-4-6".to_string()),
            thinking_budget: self.thinking_budget,
            max_retries: self.max_retries.unwrap_or(5),
            client: reqwest::Client::new(),
        })
    }
}
