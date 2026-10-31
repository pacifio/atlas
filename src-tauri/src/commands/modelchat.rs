//! BYOK Model-Chat — provider calls + token streaming via the Rig SDK.
//!
//! Rust owns the network/LLM work (Atlas's "Rust owns business logic" rule):
//! the frontend sends `(provider, model, messages)`, Rust resolves the BYOK key
//! from app-local storage, builds a Rig agent, and streams token deltas to the
//! webview over the `atlas:modelchat` event. A 3-arm dispatch covers everything:
//! OpenAI's Chat-Completions client (with `base_url`) for OpenAI **and** every
//! OpenAI-compatible provider, plus native Anthropic and native Gemini.
//!
//! Model listing stays a plain `/models` fetch (`modelchat_models`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use rig_core::completion::CompletionRequest;
use rig_core::message::{ImageMediaType, Message as RigMessage, UserContent};
use rig_core::operation::Completion;
use rig_core::providers::anthropic::Anthropic;
use rig_core::providers::gemini::Gemini;
use rig_core::providers::openai::OpenAIConfig;
use rig_core::streaming::{Item, StreamEvent, Streamed};
use rig_core::DynModel;

use super::byok;

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ApiKind {
    OpenAi,
    Anthropic,
    Google,
}

/// `(api kind, base url)` for each chat-capable provider. The base url is only
/// used by the OpenAI-compatible arm. Shared with `memory_summarize` (sibling
/// module) for the one-shot handoff summarizer.
pub(super) fn provider_endpoint(provider: &str) -> Option<(ApiKind, &'static str)> {
    Some(match provider {
        "openai" => (ApiKind::OpenAi, "https://api.openai.com/v1"),
        "anthropic" => (ApiKind::Anthropic, ""),
        "google" => (ApiKind::Google, ""),
        "cohere" => (ApiKind::OpenAi, "https://api.cohere.ai/compatibility/v1"),
        "mistral" => (ApiKind::OpenAi, "https://api.mistral.ai/v1"),
        "xai" => (ApiKind::OpenAi, "https://api.x.ai/v1"),
        "deepseek" => (ApiKind::OpenAi, "https://api.deepseek.com/v1"),
        "groq" => (ApiKind::OpenAi, "https://api.groq.com/openai/v1"),
        "together" => (ApiKind::OpenAi, "https://api.together.xyz/v1"),
        "fireworks" => (ApiKind::OpenAi, "https://api.fireworks.ai/inference/v1"),
        "deepinfra" => (ApiKind::OpenAi, "https://api.deepinfra.com/v1/openai"),
        "cerebras" => (ApiKind::OpenAi, "https://api.cerebras.ai/v1"),
        "perplexity" => (ApiKind::OpenAi, "https://api.perplexity.ai"),
        "openrouter" => (ApiKind::OpenAi, "https://openrouter.ai/api/v1"),
        "empero" => (ApiKind::OpenAi, "https://free.empero.org/v1"),
        "orcarouter" => (ApiKind::OpenAi, "https://api.orcarouter.ai/v1"),
        "cheaperinference" => (ApiKind::OpenAi, "https://api.cheaperinference.com/v1"),
        "runcrate" => (ApiKind::OpenAi, "https://api.runcrate.ai/v1"),
        _ => return None,
    })
}

// ── Cancellation state ──────────────────────────────────────────────────────

#[derive(Default)]
pub struct ModelChatState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ModelChatState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ── Streaming events ────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ModelChatEvent {
    TextDelta {
        delta: String,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    Done,
    Error {
        message: String,
    },
}

#[derive(Serialize, Clone)]
struct ModelChatEnvelope {
    stream_id: String,
    #[serde(flatten)]
    event: ModelChatEvent,
}

/// Per-1M ($input, $output) for a BYOK model, from the models.dev catalogue
/// Atlas caches. `None` when the catalogue does not know the model — the
/// dashboard then shows tokens with no cost for that turn, which is the honest
/// answer.
///
/// One pricing source. This used to fall through to a hardcoded ladder of
/// `model.contains("gpt-4o")`-style guesses, and for Anthropic models to a
/// second hardcoded table that lived in the deleted Claude scrape module. Both
/// went stale silently: a wrong price is worse than no price, because nothing
/// about it looks wrong.
fn byok_pricing(app: &AppHandle, model: &str) -> Option<(f64, f64)> {
    let prices = super::usage::read_prices(app);
    let price = super::usage::price_for(Some(model), &prices)?;
    Some((price.input, price.output))
}

/// Append one usage line to `<app_config_dir>/byok-usage.jsonl` (read back by
/// `usage_dashboard`). Fire-and-forget; failures are swallowed.
fn persist_byok_usage(app: &AppHandle, provider: &str, model: &str, input: u64, output: u64) {
    let Some(path) = super::usage_dashboard::byok_usage_path(app) else {
        return;
    };
    let cost = byok_pricing(app, model).map(|(p_in, p_out)| {
        (input as f64 / 1_000_000.0) * p_in + (output as f64 / 1_000_000.0) * p_out
    });
    let entry = serde_json::json!({
        "ts": chrono::Local::now().to_rfc3339(),
        "provider": provider,
        "model": model,
        "inputTokens": input,
        "outputTokens": output,
        "costUsd": cost,
    });
    let line = format!("{entry}\n");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

fn emit(app: &AppHandle, stream_id: &str, event: ModelChatEvent) {
    let _ = app.emit(
        "atlas:modelchat",
        ModelChatEnvelope {
            stream_id: stream_id.to_string(),
            event,
        },
    );
}

// ── Messages ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ImageData {
    pub mime: String,
    /// Base64-encoded image bytes (no data-URL prefix).
    pub data: String,
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageData>,
}

fn image_media_type(mime: &str) -> Option<ImageMediaType> {
    Some(match mime {
        "image/jpeg" | "image/jpg" => ImageMediaType::JPEG,
        "image/png" => ImageMediaType::PNG,
        "image/gif" => ImageMediaType::GIF,
        "image/webp" => ImageMediaType::WEBP,
        _ => return None,
    })
}

fn to_rig(m: &ChatMsg) -> Option<RigMessage> {
    match m.role.as_str() {
        "assistant" => Some(RigMessage::assistant(m.content.clone())),
        "user" => {
            if m.images.is_empty() {
                return Some(RigMessage::user(m.content.clone()));
            }
            // Multimodal turn: text (if any) + one block per image.
            let mut parts: Vec<UserContent> = Vec::new();
            if !m.content.is_empty() {
                parts.push(UserContent::text(m.content.clone()));
            }
            for img in &m.images {
                parts.push(UserContent::image_base64(
                    img.data.clone(),
                    image_media_type(&img.mime),
                    None,
                ));
            }
            if parts.is_empty() {
                return None;
            }
            Some(RigMessage::User { content: parts })
        }
        _ => None,
    }
}

/// Split the conversation into `(prompt, prior_history)` — Rig's request wants
/// the latest user turn as the prompt, ahead of which the history goes.
fn split_messages(msgs: &[ChatMsg]) -> Result<(RigMessage, Vec<RigMessage>), String> {
    let mut history: Vec<RigMessage> = msgs.iter().filter_map(to_rig).collect();
    let prompt = history.pop().ok_or("empty conversation")?;
    Ok((prompt, history))
}

/// The three-arm provider dispatch, shared with `memory_summarize`: Chat
/// Completions (with `base_url`) for OpenAI and every OpenAI-compatible
/// provider, native Anthropic, native Gemini.
pub(super) fn build_model(
    api: ApiKind,
    base: &str,
    key: &str,
    model: &str,
) -> DynModel<Completion> {
    match api {
        ApiKind::OpenAi => {
            let mut config = OpenAIConfig::new(key);
            config.base_url = base.to_string();
            config.client().chat(model).into()
        }
        ApiKind::Anthropic => Anthropic::new(key).completion(model).into(),
        ApiKind::Google => Gemini::new(key).completion(model).into(),
    }
}

/// Start a stream for `prompt` after `history`.
pub(super) fn start_stream(
    model: &DynModel<Completion>,
    prompt: RigMessage,
    history: Vec<RigMessage>,
) -> Result<Streamed<Completion>, String> {
    let request = CompletionRequest::new(prompt).messages(history);
    model.stream(request).map_err(|e| e.to_string())
}

// ── Stream drain (shared across providers) ──────────────────────────────────

/// Iterate a Rig completion stream, forwarding text deltas to the UI, then read
/// token usage from the folded response once the stream is exhausted.
async fn drain(
    mut stream: Streamed<Completion>,
    app: &AppHandle,
    stream_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(u64, u64), String> {
    while let Some(item) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Ok((0, 0));
        }
        if let Item::Event(StreamEvent::Text { text, .. }) = item.map_err(|e| e.to_string())? {
            if !text.is_empty() {
                emit(app, stream_id, ModelChatEvent::TextDelta { delta: text });
            }
        }
    }
    // The stream is fully read: its folded response carries the usage. A reply
    // the provider never ended (connection cut before the terminal record)
    // fails here as `Truncated` rather than as a stream item, so it must surface
    // as an error, not as `Done` after partial text.
    let response = stream.finish().await.map_err(|e| e.to_string())?;
    Ok((
        response.usage.input_tokens.unwrap_or(0),
        response.usage.output_tokens.unwrap_or(0),
    ))
}

// ── Stream command ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn modelchat_stream(
    app: AppHandle,
    state: State<'_, ModelChatState>,
    stream_id: String,
    provider: String,
    model: String,
    messages: Vec<ChatMsg>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .insert(stream_id.clone(), cancel.clone());

    let result = run_stream(&app, &stream_id, &provider, &model, messages, &cancel).await;

    state.cancels.lock().remove(&stream_id);

    match result {
        Ok((input_tokens, output_tokens)) => {
            if input_tokens + output_tokens > 0 {
                emit(
                    &app,
                    &stream_id,
                    ModelChatEvent::Usage {
                        input_tokens,
                        output_tokens,
                    },
                );
                // Persist for the Usage tab's BYOK usage history (accrues
                // going forward; old sessions have no token data).
                persist_byok_usage(&app, &provider, &model, input_tokens, output_tokens);
            }
            // Telemetry: provider/model + token counts only (no message text).
            app.state::<std::sync::Arc<crate::telemetry::TelemetryClient>>()
                .capture(
                    "model_chat_sent",
                    serde_json::json!({
                        "provider": &provider,
                        "model": &model,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    }),
                );
            emit(&app, &stream_id, ModelChatEvent::Done);
            Ok(())
        }
        Err(e) => {
            if cancel.load(Ordering::Relaxed) {
                emit(&app, &stream_id, ModelChatEvent::Done);
                Ok(())
            } else {
                emit(
                    &app,
                    &stream_id,
                    ModelChatEvent::Error { message: e.clone() },
                );
                Err(e)
            }
        }
    }
}

async fn run_stream(
    app: &AppHandle,
    stream_id: &str,
    provider: &str,
    model: &str,
    messages: Vec<ChatMsg>,
    cancel: &Arc<AtomicBool>,
) -> Result<(u64, u64), String> {
    let (api, base) =
        provider_endpoint(provider).ok_or_else(|| format!("{provider} does not support chat"))?;
    let key = byok::byok_get(app.clone(), provider.to_string())?
        .ok_or_else(|| format!("No API key configured for {provider}"))?;
    let (prompt, history) = split_messages(&messages)?;

    let model = build_model(api, base, &key, model);
    let stream = start_stream(&model, prompt, history)?;
    drain(stream, app, stream_id, cancel).await
}

#[tauri::command]
pub fn modelchat_cancel(state: State<'_, ModelChatState>, stream_id: String) {
    if let Some(flag) = state.cancels.lock().get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

// ── Model listing (unchanged: live `/models` + curated fallback) ────────────

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
}

fn fallback_models(provider: &str) -> Vec<&'static str> {
    match provider {
        "perplexity" => vec![
            "sonar",
            "sonar-pro",
            "sonar-reasoning",
            "sonar-reasoning-pro",
        ],
        "anthropic" => vec![
            "claude-opus-4-1",
            "claude-sonnet-4-5",
            "claude-3-5-haiku-latest",
        ],
        "openai" => vec!["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
        "google" => vec![
            "gemini-3.1-pro-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
        ],
        "cohere" => vec!["command-a-03-2025", "command-r-plus", "command-r"],
        "empero" => vec!["glm-5.3-flash"],
        "orcarouter" => vec!["orcarouter/auto"],
        "cheaperinference" => vec!["gpt-5.4-mini", "gpt-5.4", "claude-sonnet-5"],
        "runcrate" => vec![
            "deepseek-ai/DeepSeek-V4.1-Flash",
            "zai-org/GLM-5.3",
            "openai/gpt-oss-120b",
        ],
        _ => vec![],
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!(
            "Atlas/",
            env!("CARGO_PKG_VERSION"),
            " (model-chat)"
        ))
        .build()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn modelchat_models(app: AppHandle, provider: String) -> Result<Vec<ModelInfo>, String> {
    let (api, base) =
        provider_endpoint(&provider).ok_or_else(|| format!("{provider} does not support chat"))?;
    let key = byok::byok_get(app, provider.clone())?
        .ok_or_else(|| format!("No API key configured for {provider}"))?;

    let models_base = match api {
        ApiKind::Google => "https://generativelanguage.googleapis.com/v1beta/openai",
        ApiKind::Anthropic => "https://api.anthropic.com/v1",
        ApiKind::OpenAi => base,
    };

    let fetched = match api {
        ApiKind::Anthropic => fetch_anthropic_models(models_base, &key).await,
        _ => fetch_openai_models(models_base, &key).await,
    };

    let mut ids: Vec<String> = match fetched {
        Ok(v) if !v.is_empty() => v,
        _ => fallback_models(&provider)
            .into_iter()
            .map(String::from)
            .collect(),
    };
    for id in ids.iter_mut() {
        if let Some(stripped) = id.strip_prefix("models/") {
            *id = stripped.to_string();
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids.into_iter().map(|id| ModelInfo { id }).collect())
}

async fn fetch_openai_models(base: &str, key: &str) -> Result<Vec<String>, String> {
    let resp = http()
        .get(format!("{base}/models"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("models: HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

async fn fetch_anthropic_models(base: &str, key: &str) -> Result<Vec<String>, String> {
    let resp = http()
        .get(format!("{base}/models"))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("models: HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orcarouter_endpoint() {
        let (kind, url) = provider_endpoint("orcarouter").expect("orcarouter endpoint must exist");
        assert_eq!(kind, ApiKind::OpenAi);
        assert_eq!(url, "https://api.orcarouter.ai/v1");
    }

    #[test]
    fn test_orcarouter_fallback_models() {
        let models = fallback_models("orcarouter");
        assert_eq!(models, vec!["orcarouter/auto"]);
    }

    #[test]
    fn test_cheaperinference_endpoint() {
        let (kind, url) =
            provider_endpoint("cheaperinference").expect("cheaperinference endpoint must exist");
        assert_eq!(kind, ApiKind::OpenAi);
        assert_eq!(url, "https://api.cheaperinference.com/v1");
    }

    #[test]
    fn test_cheaperinference_fallback_models() {
        let models = fallback_models("cheaperinference");
        assert_eq!(models, vec!["gpt-5.4-mini", "gpt-5.4", "claude-sonnet-5"]);
    }

    #[test]
    fn test_runcrate_endpoint() {
        let (kind, url) = provider_endpoint("runcrate").expect("runcrate endpoint must exist");
        assert_eq!(kind, ApiKind::OpenAi);
        assert_eq!(url, "https://api.runcrate.ai/v1");
    }

    #[test]
    fn test_runcrate_fallback_models() {
        let models = fallback_models("runcrate");
        assert_eq!(
            models,
            vec![
                "deepseek-ai/DeepSeek-V4.1-Flash",
                "zai-org/GLM-5.3",
                "openai/gpt-oss-120b",
            ]
        );
    }
}
