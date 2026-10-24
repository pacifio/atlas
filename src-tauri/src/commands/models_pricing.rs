//! Model pricing from models.dev (https://models.dev/api.json).
//!
//! Strategy: cache the normalized price map to `<app_config_dir>/models-pricing.json`.
//! On every app launch we fetch in the background, compare to the cache, and
//! rewrite only if something changed (emitting `atlas:models-pricing-updated`
//! so the UI reloads). First launch with no cache simply populates it. The UI
//! can also force a refresh from Settings → General or the model menu.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const CATALOG_URL: &str = "https://models.dev/api.json";

/// Normalized per-model price, USD per 1M tokens.
///
/// Cache rates are carried because for an agent like Claude Code they ARE the
/// bill: a session of this project's own transcripts runs ~99.5% cache tokens,
/// so a cost computed from input and output alone reads as roughly zero. They
/// default to 0.0 rather than `Option`, so a provider that publishes no cache
/// price simply contributes nothing — and so a cache file written before this
/// field existed still deserializes (its 0.0s then differ from the fetched
/// catalogue, which is what triggers the rewrite that fills them in).
///
/// Beside the price, the three facts models.dev states about a model that
/// Settings → Agents labels its models with. Each defaults to "not stated",
/// for the same reason as the cache rates.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
    /// It reasons before answering.
    #[serde(default)]
    pub reasoning: bool,
    /// It reads images.
    #[serde(default)]
    pub images: bool,
    /// Its context window in tokens; 0 when unstated.
    #[serde(default)]
    pub context: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PricingCache {
    #[serde(default)]
    pub fetched_at: String,
    /// Keyed by both `"provider/model"` and bare `"model"` for lookup fallback.
    #[serde(default)]
    pub prices: BTreeMap<String, ModelPrice>,
}

fn cache_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("models-pricing.json")
}

fn read_cache(app: &AppHandle) -> PricingCache {
    std::fs::read_to_string(cache_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, c: &PricingCache) -> Result<(), String> {
    let p = cache_path(app);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())
}

/// Parse models.dev `api.json` (`{ "<provider>": { "models": { "<model>": {
/// "cost": { "input", "output", "cache_read", "cache_write" } } } } }`) into a
/// normalized price map.
///
/// `input` and `output` are required — an entry without them is not a price.
/// The two cache rates are optional and default to zero, because only some
/// providers publish them (Anthropic does; several others do not).
fn parse_catalog(v: &serde_json::Value) -> BTreeMap<String, ModelPrice> {
    let mut out = BTreeMap::new();
    let Some(providers) = v.as_object() else {
        return out;
    };
    for (pid, pval) in providers {
        let Some(models) = pval.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (mid, mval) in models {
            let cost = mval.get("cost");
            let input = cost
                .and_then(|c| c.get("input"))
                .and_then(serde_json::Value::as_f64);
            let output = cost
                .and_then(|c| c.get("output"))
                .and_then(serde_json::Value::as_f64);
            let rate = |key: &str| {
                cost.and_then(|c| c.get(key))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0)
            };
            if let (Some(input), Some(output)) = (input, output) {
                let price = ModelPrice {
                    input,
                    output,
                    cache_read: rate("cache_read"),
                    cache_write: rate("cache_write"),
                    reasoning: mval
                        .get("reasoning")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    images: mval
                        .pointer("/modalities/input")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|kinds| kinds.iter().any(|k| k == "image")),
                    context: mval
                        .pointer("/limit/context")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0),
                };
                out.insert(format!("{pid}/{mid}"), price.clone());
                // Bare model id as a fallback key (first provider wins).
                out.entry(mid.clone()).or_insert(price);
            }
        }
    }
    out
}

async fn fetch_catalog() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Atlas/", env!("CARGO_PKG_VERSION"), " (pricing)"))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(CATALOG_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("models.dev returned HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct RefreshResult {
    pub updated: bool,
    pub model_count: usize,
    pub changed: usize,
}

/// Fetch → compare → write-if-changed. Shared by the command + the startup task.
pub async fn refresh(app: &AppHandle) -> Result<RefreshResult, String> {
    let catalog = fetch_catalog().await?;
    let prices = parse_catalog(&catalog);
    if prices.is_empty() {
        return Err("models.dev returned no usable pricing".into());
    }
    let prev = read_cache(app);
    let changed = prices
        .iter()
        .filter(|(k, v)| prev.prices.get(*k).map(|old| old != *v).unwrap_or(true))
        .count();
    let updated = changed > 0 || prices.len() != prev.prices.len();
    if updated {
        let cache = PricingCache {
            fetched_at: chrono::Utc::now().to_rfc3339(),
            prices: prices.clone(),
        };
        write_cache(app, &cache)?;
        let _ = app.emit("atlas:models-pricing-updated", ());
    }
    Ok(RefreshResult {
        updated,
        model_count: prices.len(),
        changed,
    })
}

/// Kick a silent background refresh (called once at startup).
pub fn refresh_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = refresh(&app).await {
            tracing::debug!(target: "atlas::pricing", "background pricing refresh failed: {e}");
        }
    });
}

/// Cached pricing map (read-only). Empty until the first successful fetch.
#[tauri::command]
pub fn models_pricing_get(app: AppHandle) -> BTreeMap<String, ModelPrice> {
    read_cache(&app).prices
}

/// Force a fetch + compare + cache update (Settings / model menu refresh).
#[tauri::command]
pub async fn models_pricing_refresh(app: AppHandle) -> Result<RefreshResult, String> {
    refresh(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The facts Settings → Agents labels a model with come along with its
    /// price, and a model that states none of them reads as unstated.
    #[test]
    fn a_models_capabilities_ride_with_its_price() {
        let catalog = serde_json::json!({
            "anthropic": { "models": {
                "claude-opus-5": {
                    "cost": { "input": 5.0, "output": 25.0 },
                    "reasoning": true,
                    "modalities": { "input": ["text", "image"], "output": ["text"] },
                    "limit": { "context": 200000, "output": 64000 },
                },
                "plain": { "cost": { "input": 1.0, "output": 2.0 } },
            } }
        });
        let prices = parse_catalog(&catalog);
        let opus = &prices["anthropic/claude-opus-5"];
        assert!(opus.reasoning && opus.images);
        assert_eq!(opus.context, 200_000);
        let plain = &prices["plain"];
        assert!(!plain.reasoning && !plain.images);
        assert_eq!(plain.context, 0);
    }
}
