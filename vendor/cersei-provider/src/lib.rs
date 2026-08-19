//! cersei-provider: Provider trait and built-in LLM providers.
//!
//! Providers abstract over different LLM backends (Anthropic, OpenAI, local models).
//! Each provider implements streaming completion, token counting, and capability discovery.

pub mod anthropic;
pub mod anthropic_vertex;
pub mod gemini;
pub mod openai;
pub mod registry;
pub mod router;
mod stream;
pub mod utf8;

use async_trait::async_trait;
use cersei_types::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

/// ATLAS PATCH marker (vendor/cersei-provider via `[patch.crates-io]`): the
/// SSE error strings carry the `Retry-After` header as "(retry-after: Ns)"
/// so the agent's retry classifier can honor it. Referencing this constant
/// fails to compile against the unpatched crates.io release.
pub const ATLAS_RETRY_AFTER_PATCH: &str = "retry-after-v1";

// Re-exports
pub use anthropic::Anthropic;
pub use anthropic_vertex::AnthropicVertex;
pub use gemini::Gemini;
pub use openai::OpenAi;
pub use router::from_model_string;
pub use stream::StreamAccumulator;

/// ATLAS PATCH (retry-after-v1): the `Retry-After` header of a non-success
/// response, rendered as a `" (retry-after: Ns)"` suffix for the SSE tasks'
/// `HTTP {status}: {body}` error strings. Headers don't survive the
/// `StreamEvent::Error` boundary any other way — `cersei-agent`'s retry
/// classifier parses this token back out to pace its backoff to the server's
/// answer instead of a guess. Empty when the header is absent or not integer
/// seconds (the HTTP-date form is rare from LLM providers and not worth a
/// date parser here).
pub(crate) fn retry_after_suffix(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| format!(" (retry-after: {secs}s)"))
        .unwrap_or_default()
}

// ─── Provider trait ──────────────────────────────────────────────────────────

#[async_trait]
pub trait Provider: Send + Sync {
    /// Human-readable provider name (e.g., "anthropic", "openai").
    fn name(&self) -> &str;

    /// Context window size for the given model.
    fn context_window(&self, model: &str) -> u64;

    /// Capabilities supported by the given model.
    fn capabilities(&self, model: &str) -> ProviderCapabilities;

    /// Send a streaming completion request.
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionStream>;

    /// Send a blocking (non-streaming) completion request.
    async fn complete_blocking(&self, request: CompletionRequest) -> Result<CompletionResponse> {
        self.complete(request).await?.collect().await
    }

    /// Count tokens for a message list. Returns an estimate if exact counting is unavailable.
    async fn count_tokens(&self, messages: &[Message], _model: &str) -> Result<u64> {
        // Default: rough estimate based on character count
        let chars: usize = messages.iter().map(|m| m.get_all_text().len()).sum();
        Ok((chars as u64) / 4) // ~4 chars per token
    }
}

// Blanket impl: Box<dyn Provider> is itself a Provider.
#[async_trait]
impl Provider for Box<dyn Provider> {
    fn name(&self) -> &str {
        (**self).name()
    }
    fn context_window(&self, model: &str) -> u64 {
        (**self).context_window(model)
    }
    fn capabilities(&self, model: &str) -> ProviderCapabilities {
        (**self).capabilities(model)
    }
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionStream> {
        (**self).complete(request).await
    }
    async fn complete_blocking(&self, request: CompletionRequest) -> Result<CompletionResponse> {
        (**self).complete_blocking(request).await
    }
    async fn count_tokens(&self, messages: &[Message], model: &str) -> Result<u64> {
        (**self).count_tokens(messages, model).await
    }
}

// ─── Authentication ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Auth {
    /// API key sent as `x-api-key` header (Anthropic Console) or `Authorization: Bearer` (OpenAI).
    ApiKey(String),
    /// Bearer token sent as `Authorization: Bearer <token>`.
    Bearer(String),
    /// OAuth flow with client ID and token.
    OAuth {
        client_id: String,
        token: OAuthToken,
    },
    /// Custom auth provider for non-standard flows.
    Custom(std::sync::Arc<dyn AuthProvider>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub scopes: Vec<String>,
}

impl OAuthToken {
    pub fn is_expired(&self) -> bool {
        if let Some(exp) = self.expires_at_ms {
            chrono::Utc::now().timestamp_millis() >= exp
        } else {
            false
        }
    }
}

#[async_trait]
pub trait AuthProvider: Send + Sync + std::fmt::Debug {
    /// Returns (header_name, header_value) for the request.
    async fn get_credentials(&self) -> Result<(String, String)>;

    /// Refresh credentials if they have expired.
    async fn refresh(&self) -> Result<()>;
}

// ─── Completion request/response ─────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub system: Option<String>,
    pub tools: Vec<ToolDefinition>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub stop_sequences: Vec<String>,
    /// Provider-specific options (thinking budget, top_p, etc.)
    pub options: ProviderOptions,
}

impl CompletionRequest {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            messages: Vec::new(),
            system: None,
            tools: Vec::new(),
            max_tokens: 16384,
            temperature: None,
            stop_sequences: Vec::new(),
            options: ProviderOptions::default(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProviderOptions {
    entries: HashMap<String, serde_json::Value>,
}

impl ProviderOptions {
    pub fn set(&mut self, key: impl Into<String>, value: impl Serialize) {
        if let Ok(v) = serde_json::to_value(value) {
            self.entries.insert(key.into(), v);
        }
    }

    pub fn get<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Option<T> {
        self.entries
            .get(key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    pub fn has(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }
}

#[derive(Debug, Clone)]
pub struct CompletionResponse {
    pub message: Message,
    pub usage: Usage,
    pub stop_reason: StopReason,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub tool_use: bool,
    pub vision: bool,
    pub thinking: bool,
    pub system_prompt: bool,
    pub caching: bool,
}

// ─── Completion stream ───────────────────────────────────────────────────────

/// A streaming response from a provider. Wraps a channel of StreamEvents.
pub struct CompletionStream {
    rx: mpsc::Receiver<StreamEvent>,
}

impl CompletionStream {
    pub fn new(rx: mpsc::Receiver<StreamEvent>) -> Self {
        Self { rx }
    }

    /// Consume the stream and collect into a complete response.
    pub async fn collect(mut self) -> Result<CompletionResponse> {
        let mut acc = StreamAccumulator::new();
        while let Some(event) = self.rx.recv().await {
            if let StreamEvent::Error { message } = &event {
                return Err(CerseiError::Provider(message.clone()));
            }
            acc.process_event(event);
        }
        acc.into_response()
    }

    /// Access the underlying receiver for real-time event processing.
    pub fn into_receiver(self) -> mpsc::Receiver<StreamEvent> {
        self.rx
    }
}
