//! Map an Atlas BYOK `(provider, model)` + key to a boxed Cersei provider.
//!
//! Identical strategy to `atlas-codeindex::llm`'s provider table (Anthropic native, all
//! others via the OpenAI-compatible client with a per-provider base URL) — kept
//! as a small self-contained copy so the native-agent crate doesn't pull in the
//! whole review engine.

use cersei::prelude::{Anthropic, Gemini, OpenAi};
use cersei::provider::Provider;

/// OpenAI-compatible base URL for `provider`, or `None` if it isn't an
/// OpenAI-compatible provider (Anthropic and Google are handled natively).
///
/// Google is deliberately NOT here: Gemini 3.x are *thinking* models and their
/// tool calling requires a `thoughtSignature` to be round-tripped on every
/// `functionCall` part (Google returns HTTP 400 `INVALID_ARGUMENT` otherwise).
/// The OpenAI-compatibility shim can't carry that field, so Google goes through
/// the SDK's native `Gemini` provider (which encodes/echoes the signature).
pub fn openai_base_url(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai" => "https://api.openai.com/v1",
        "cohere" => "https://api.cohere.ai/compatibility/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "xai" => "https://api.x.ai/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "together" => "https://api.together.xyz/v1",
        "fireworks" => "https://api.fireworks.ai/inference/v1",
        "deepinfra" => "https://api.deepinfra.com/v1/openai",
        "cerebras" => "https://api.cerebras.ai/v1",
        "perplexity" => "https://api.perplexity.ai",
        "openrouter" => "https://openrouter.ai/api/v1",
        _ => return None,
    })
}

/// Build a boxed Cersei provider for `(provider, model)` using `api_key`.
///
/// Returns a `Send + Sync` box (the `Provider` trait already requires both) so
/// the same builder satisfies `provider_boxed(Box<dyn Provider>)` *and* the
/// delegate tool's `ProviderFactory` (which needs `Box<dyn Provider + Send + Sync>`).
pub fn build_provider(
    provider: &str,
    api_key: &str,
    model: &str,
) -> Result<Box<dyn Provider + Send + Sync>, String> {
    if provider == "anthropic" {
        let p = Anthropic::builder()
            .api_key(api_key)
            .model(model)
            .build()
            .map_err(|e| format!("anthropic provider: {e}"))?;
        return Ok(Box::new(p));
    }

    // Google → native Gemini provider (NOT the OpenAI-compat client): Gemini 3.x
    // thinking models require `thoughtSignature` round-tripping on tool calls,
    // which only the native provider does. Base URL defaults to the native
    // Gemini API. See `openai_base_url`.
    if provider == "google" {
        let p = Gemini::builder()
            .api_key(api_key)
            .model(model)
            .build()
            .map_err(|e| format!("google provider: {e}"))?;
        return Ok(Box::new(p));
    }

    let base = openai_base_url(provider)
        .ok_or_else(|| format!("unsupported provider: {provider}"))?;
    let p = OpenAi::builder()
        .api_key(api_key)
        .base_url(base)
        .model(model)
        .build()
        .map_err(|e| format!("{provider} provider: {e}"))?;
    Ok(Box::new(p))
}

/// Best-first preferred coding model per provider — the offline default the
/// runtime selects when the UI hasn't pinned one yet. Mirrors the frontend
/// `settings/lib/model-catalog.ts` PREFERRED table (keep in sync).
pub fn default_model_for(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "anthropic" => "claude-opus-4-8",
        "openai" => "gpt-5.1",
        "google" => "gemini-3.1-pro-preview",
        "xai" => "grok-4",
        "deepseek" => "deepseek-reasoner",
        "mistral" => "mistral-large-latest",
        "groq" => "moonshotai/kimi-k2-instruct",
        "together" => "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "fireworks" => "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
        "deepinfra" => "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "cerebras" => "qwen-3-coder-480b",
        "openrouter" => "anthropic/claude-sonnet-4.6",
        "perplexity" => "sonar-reasoning-pro",
        "cohere" => "command-a-03-2025",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_known_and_unknown() {
        assert_eq!(openai_base_url("openai"), Some("https://api.openai.com/v1"));
        assert_eq!(openai_base_url("groq"), Some("https://api.groq.com/openai/v1"));
        // Anthropic is handled natively, not via the OpenAI-compat path.
        assert_eq!(openai_base_url("anthropic"), None);
        assert_eq!(openai_base_url("nonsense"), None);
    }

    #[test]
    fn default_models_cover_priority_list() {
        // Every prioritized provider must have a known default model, or the
        // runtime can't auto-select one for it.
        for p in PROVIDER_PRIORITY {
            assert!(default_model_for(p).is_some(), "no default model for {p}");
        }
        assert_eq!(default_model_for("anthropic"), Some("claude-opus-4-8"));
        assert_eq!(default_model_for("nonsense"), None);
    }

    #[test]
    fn priority_leads_with_anthropic() {
        assert_eq!(PROVIDER_PRIORITY.first(), Some(&"anthropic"));
    }

    #[test]
    fn build_provider_known_ok_unknown_err() {
        assert!(build_provider("anthropic", "sk-test", "claude-opus-4-8").is_ok());
        assert!(build_provider("openai", "sk-test", "gpt-5.1").is_ok());
        // Google routes to the native Gemini provider (thought-signature support),
        // not the OpenAI-compat client.
        assert!(build_provider("google", "sk-test", "gemini-3.1-pro-preview").is_ok());
        assert!(build_provider("nonsense", "k", "m").is_err());
    }
}

/// Priority order used to pick a default provider from the configured BYOK keys
/// (strongest coding providers first).
pub const PROVIDER_PRIORITY: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "xai",
    "deepseek",
    "mistral",
    "groq",
    "together",
    "fireworks",
    "deepinfra",
    "cerebras",
    "openrouter",
    "perplexity",
    "cohere",
];
