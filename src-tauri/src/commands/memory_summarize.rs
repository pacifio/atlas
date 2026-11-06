//! Shared Cross-Agent Memory — optional provider summarization of the handoff.
//!
//! When the per-project summarizer preference is `mode: "provider"`, the raw
//! recent-session tail is condensed into a tight briefing via a BYOK provider
//! before injection. This reuses the exact Rig 3-arm dispatch from
//! [`super::modelchat`] (OpenAI-compatible / Anthropic / Gemini) but collapsed
//! to a one-shot: no `stream_id`, no cancel flag — just collect the full text.
//!
//! [`summarize`] is **best-effort and time-bounded**: an internal 8s timeout
//! plus a raw-text fallback on any error (no key, unsupported provider, network
//! failure, empty result). It can never block or fail the agent turn — the
//! worst case is the user gets the raw tail instead of a summary.

use std::time::Duration;

use futures::StreamExt;
use rig_core::message::Message as RigMessage;
use rig_core::operation::Completion;
use rig_core::streaming::{Item, StreamEvent, Streamed};
use tauri::AppHandle;

use super::byok;
use super::modelchat::{build_model, provider_endpoint, start_stream};

/// Hard cap on a single summarization call. Belt-and-suspenders: the caller in
/// `agents_send` also wraps the whole build+summarize path in its own budget.
const SUMMARIZE_TIMEOUT_SECS: u64 = 8;

const SUMMARY_INSTRUCTION: &str = "You are condensing a coding-session transcript so another AI agent can resume the work. Produce a tight briefing (5-8 short bullets) capturing: decisions made, files changed, conventions established, and any unfinished work. Be concrete and omit pleasantries. Output only the briefing.\n\n--- TRANSCRIPT ---\n";

/// Summarize `text` via a BYOK provider, returning the summary on success or
/// the original `text` verbatim on any failure/timeout. Never errors.
pub async fn summarize(app: &AppHandle, text: &str, provider: &str, model: &str) -> String {
    if provider.is_empty() || model.is_empty() || text.trim().is_empty() {
        return text.to_string();
    }
    match tokio::time::timeout(
        Duration::from_secs(SUMMARIZE_TIMEOUT_SECS),
        run_summary(app, text, provider, model),
    )
    .await
    {
        Ok(Ok(s)) if !s.trim().is_empty() => s,
        Ok(Err(e)) => {
            tracing::debug!(target: "atlas::memory_sharing", "summarize fell back to raw: {e}");
            text.to_string()
        }
        Ok(Ok(_)) => text.to_string(), // empty summary → raw fallback
        Err(_) => {
            tracing::warn!(target: "atlas::memory_sharing", "summarize timed out after {SUMMARIZE_TIMEOUT_SECS}s; using raw handoff");
            text.to_string()
        }
    }
}

async fn run_summary(
    app: &AppHandle,
    text: &str,
    provider: &str,
    model: &str,
) -> Result<String, String> {
    run_completion(app, format!("{SUMMARY_INSTRUCTION}{text}"), provider, model).await
}

/// One-shot BYOK completion: send `prompt_text` to `provider`/`model` and
/// collect the full text. Shared by [`summarize`] and the extractor's BYOK route
/// (`super::memory_extract`).
pub(crate) async fn run_completion(
    app: &AppHandle,
    prompt_text: String,
    provider: &str,
    model: &str,
) -> Result<String, String> {
    let (api, base) =
        provider_endpoint(provider).ok_or_else(|| format!("{provider} does not support chat"))?;
    // Synchronous file read — done before any await, never held across one.
    let key = byok::byok_get(app.clone(), provider.to_string())?
        .ok_or_else(|| format!("No API key configured for {provider}"))?;
    let prompt = RigMessage::user(prompt_text);

    let model = build_model(api, base, &key, model);
    let stream = start_stream(&model, prompt, Vec::<RigMessage>::new())?;
    collect_text(stream).await
}

/// Drain a Rig stream into a single string (text deltas only).
async fn collect_text(mut stream: Streamed<Completion>) -> Result<String, String> {
    let mut buf = String::new();
    while let Some(item) = stream.next().await {
        if let Item::Event(StreamEvent::Text { text, .. }) = item.map_err(|e| e.to_string())? {
            buf.push_str(&text);
        }
    }
    // A reply cut before the provider's terminal record is `Truncated` here;
    // fail so `summarize` falls back to raw text instead of a partial summary.
    stream.finish().await.map_err(|e| e.to_string())?;
    Ok(buf)
}
