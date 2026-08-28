//! The Atlas-authored model catalogue (spec D3).
//!
//! The engine can fetch a catalogue from `{base}/models`, and against this
//! gateway that path does not work: the engine's fetch adds a
//! `?client_version=` parameter the contract does not define, and then
//! deserializes the reply as its own rich `{"models":[…]}` record — where the
//! gateway serves the stock OpenAI `{"object":"list","data":[…]}` list, which
//! shares nothing with it but the path segment. The deserialize fails outright.
//! So the catalogue is authored here, which is the engine's first-class static
//! path rather than a workaround.
//!
//! # What the numbers in here decide
//!
//! - **`context_window: 200_000`** is the gateway's prompt ceiling, and local
//!   auto-compaction fires at 90% of whatever this says. Author it too high and
//!   compaction never runs before the gateway starts answering `413`; too low
//!   and every long thread compacts early for no reason. Two caveats travel
//!   with the number and neither is fixable here: the engine counts real
//!   usage-reported tokens while the gateway's `413` gate estimates
//!   `ceil(bytes/3)`, so the two meters can cross; and remote compaction is
//!   capability-gated to OpenAI and Azure, so only local summarisation defends
//!   the ceiling.
//! - **The default is `claude-sonnet-4-6`** (D3), which is why it carries
//!   `priority: 1` — the picker orders on it.
//!
//! # Where these rows differ from an upstream row, and why
//!
//! Every difference is the gateway's allowlist showing through. Reasoning
//! effort, reasoning summaries, verbosity and service tiers all ride request
//! fields the gateway answers with a `400`, so a row advertising them would
//! offer the user a control that silently does nothing. Search is off because a
//! `tool_search` tool has no Chat Completions shape. `apply_patch` stays on:
//! the dialect flattens freeform tools on the way out and turns the reply back
//! on the way in, so patching survives the crossing.
//!
//! # `deepseek-v3-2` is deliberately absent
//!
//! It is withdrawn (ATL-173): its price row names no publisher, so the gateway
//! refuses it `403 model_not_allowed` before any spend. Authoring it would put
//! a model in the picker that cannot answer.

use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_protocol::openai_models::ModelsResponse;
use serde_json::Value;
use serde_json::json;

/// D3's default model.
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

/// The gateway's prompt ceiling, and therefore the compaction trigger.
pub const CONTEXT_WINDOW: i64 = 200_000;

/// The file the engine reads the catalogue from.
const CATALOG_FILE: &str = "models.json";

/// The gateway's catalogue, in picker order: `(slug, display name, description)`.
///
/// Priority is the position, not a field — the picker orders on it, and a
/// hand-written number that disagrees with the order of this list would be a
/// silent reordering nobody meant.
const MODELS: &[(&str, &str, &str)] = &[
    (
        DEFAULT_MODEL,
        "Claude Sonnet 4.6",
        "The default. Strong agentic coding at the mid tier.",
    ),
    (
        "claude-opus-5",
        "Claude Opus 5",
        "The most capable model Atlas serves, and the most expensive.",
    ),
    (
        "claude-opus-4-8",
        "Claude Opus 4.8",
        "The previous Opus release, priced identically to Opus 5.",
    ),
    (
        "gemini-3.6-flash",
        "Gemini 3.6 Flash",
        "Fast and inexpensive; Atlas follows the latest Flash rather than pinning a version.",
    ),
    (
        "gemini-3.5-flash-lite",
        "Gemini 3.5 Flash Lite",
        "The cheap tier — roughly a fifth of Flash on input.",
    ),
];

/// One catalogue row.
///
/// Authored as JSON and parsed rather than built as a struct literal, for two
/// reasons: it is the same document the engine loads from disk, so this is the
/// shape being asserted on; and the upstream record has forty-odd fields, most
/// of them defaulted, so a struct literal would have to restate every default
/// and would break on every upstream field addition.
fn row(slug: &str, display_name: &str, description: &str, priority: i32) -> Value {
    json!({
        "slug": slug,
        "display_name": display_name,
        "description": description,
        "priority": priority,
        "visibility": "list",
        "supported_in_api": true,

        // No reasoning knob crosses this wire. The engine's `reasoning` field
        // is off the gateway's allowlist, and the one thinking control the
        // gateway names — `stream_options.thinking_budget` — is its own example
        // of a nested unknown key that earns a 400. Advertising effort levels
        // here would put a control in the UI that changes nothing.
        "supported_reasoning_levels": [],
        "supports_reasoning_summary_parameter": false,
        "default_reasoning_summary": "none",

        // `text.verbosity` and `service_tier` are Responses fields, likewise off
        // the allowlist.
        "support_verbosity": false,
        "default_verbosity": null,
        "service_tiers": [],
        "default_service_tier": null,
        "additional_speed_tiers": [],

        // Kept: the dialect flattens a freeform tool into a function on the way
        // out and turns the reply back into a `CustomToolCall` on the way in,
        // so apply_patch works across this wire.
        "apply_patch_tool_type": "freeform",
        "shell_type": "shell_command",
        // Dropped: `tool_search` is a Responses-native tool shape with no Chat
        // Completions counterpart, so the request builder would drop it and the
        // model would be told about a tool that never arrives.
        "supports_search_tool": false,
        // Responses-only request shape.
        "use_responses_lite": false,
        "experimental_supported_tools": [],

        // Both models take images. The gateway's 2 MB body cap is what bounds
        // them, and that is a policy for the app to enforce (D15c), not a
        // capability to deny here.
        "input_modalities": ["text", "image"],
        "supports_image_detail_original": false,

        "context_window": CONTEXT_WINDOW,
        "max_context_window": CONTEXT_WINDOW,
        "truncation_policy": { "mode": "tokens", "limit": 10000 },

        // The engine's own bundled prompt, unedited.
        //
        // It opens by naming the upstream product and the model family, which
        // is wrong on every row here — the trademark scrub that fixes it is its
        // own gated piece of work, and doing it inside the catalogue would put
        // a rewritten system prompt in a commit about model metadata.
        "model_messages": { "instructions_template": codex_models_manager::model_info::BASE_INSTRUCTIONS.as_str() },
        "include_skills_usage_instructions": true,
        // Both name surfaces that belong to the upstream product, not to Atlas.
        "include_plugin_usage_instructions": false,
        "include_apps_usage_instructions": false,

        "availability_nux": null,
        "upgrade": null,
    })
}

/// The catalogue, parsed into the engine's own record.
pub fn atlas_catalog() -> Result<ModelsResponse> {
    let models: Vec<Value> = MODELS
        .iter()
        .enumerate()
        .map(|(index, (slug, display_name, description))| {
            row(slug, display_name, description, index as i32 + 1)
        })
        .collect();
    serde_json::from_value(json!({ "models": models }))
        .context("the authored model catalogue must parse as the engine's own record")
}

/// Writes the catalogue into the engine's home and returns its path.
///
/// A file rather than an in-memory value because that is the only route the
/// engine offers: `Config` reads a catalogue from the `model_catalog_json` path
/// and nothing else populates it.
pub async fn write_catalog(home: &Path) -> Result<PathBuf> {
    let catalog = atlas_catalog()?;
    let path = home.join(CATALOG_FILE);
    let body = serde_json::to_vec_pretty(&catalog)
        .context("serialising the authored model catalogue")?;
    tokio::fs::write(&path, body)
        .await
        .with_context(|| format!("writing the model catalogue to {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ModelsResponse {
        match atlas_catalog() {
            Ok(catalog) => catalog,
            Err(err) => panic!("the authored catalogue must parse: {err:#}"),
        }
    }

    #[test]
    fn the_catalogue_parses_as_the_record_the_engine_loads() {
        // The whole point of authoring it: the engine's remote fetch cannot
        // read the gateway's list, so this file is the catalogue. A row that
        // does not parse leaves the picker empty and no model selectable.
        assert_eq!(catalog().models.len(), MODELS.len());
    }

    #[test]
    fn the_default_model_is_the_sonnet_the_spec_names_and_it_sorts_first() {
        // D3. The picker orders on `priority`, so being present is not enough.
        let catalog = catalog();
        let Some(first) = catalog.models.first() else {
            panic!("the catalogue must not be empty");
        };
        assert_eq!(first.slug, DEFAULT_MODEL);
        assert_eq!(first.slug, "claude-sonnet-4-6");
        assert_eq!(first.priority, 1);
        assert!(catalog.models.iter().all(|m| m.priority >= 1));
    }

    #[test]
    fn the_five_models_the_gateway_serves_are_the_five_here() {
        let catalog = catalog();
        let slugs: Vec<&str> = catalog.models.iter().map(|m| m.slug.as_str()).collect();
        assert_eq!(
            slugs,
            [
                "claude-sonnet-4-6",
                "claude-opus-5",
                "claude-opus-4-8",
                "gemini-3.6-flash",
                "gemini-3.5-flash-lite",
            ],
        );
    }

    #[test]
    fn the_withdrawn_model_is_not_in_the_catalogue() {
        // `deepseek-v3-2` is withdrawn: its price row names no publisher, so the
        // gateway refuses it before any spend. Authoring it would put a model in
        // the picker that answers 403 to everything.
        assert!(
            !catalog().models.iter().any(|m| m.slug.contains("deepseek")),
            "a withdrawn model must not be selectable",
        );
    }

    #[test]
    fn the_context_window_is_what_makes_compaction_fire_before_the_gateway_refuses() {
        // Auto-compaction triggers at 90% of this. Left unset, the engine has no
        // ceiling to compact against and the first sign of trouble is a 413 the
        // classification arm can only report.
        for model in catalog().models {
            assert_eq!(model.context_window, Some(CONTEXT_WINDOW), "{}", model.slug);
            assert_eq!(
                model.auto_compact_token_limit(),
                Some(180_000),
                "{} must compact before the gateway's ceiling",
                model.slug,
            );
        }
    }

    #[test]
    fn no_row_advertises_a_control_this_wire_cannot_carry() {
        // Each of these rides a request field the gateway answers with a 400.
        // A row that claims them puts a knob in the UI that silently does
        // nothing, which is worse than not offering it.
        for model in catalog().models {
            assert!(
                model.supported_reasoning_levels.is_empty(),
                "{}: no reasoning knob crosses this wire",
                model.slug,
            );
            assert!(!model.support_verbosity, "{}", model.slug);
            assert!(!model.supports_reasoning_summary_parameter, "{}", model.slug);
            assert!(model.service_tiers.is_empty(), "{}", model.slug);
            assert!(!model.use_responses_lite, "{}", model.slug);
            assert!(!model.supports_search_tool, "{}", model.slug);
        }
    }

    #[test]
    fn every_row_carries_instructions_because_an_empty_prompt_is_a_silent_lobotomy() {
        // With no `instructions_template` the engine logs a warning and returns
        // an empty string, and the agent runs with no system prompt at all —
        // visible only as an agent that has forgotten how to do its job.
        for model in catalog().models {
            let instructions = model.get_model_instructions(/*personality*/ None);
            assert!(
                instructions.len() > 1_000,
                "{} has no usable system prompt ({} bytes)",
                model.slug,
                instructions.len(),
            );
        }
    }

    #[test]
    fn apply_patch_survives_the_crossing() {
        // The dialect flattens freeform tools and turns the reply back, so this
        // stays on. If that round trip is ever removed, this row becomes a tool
        // the model is offered and cannot successfully call.
        for model in catalog().models {
            assert!(
                model.apply_patch_tool_type.is_some(),
                "{} lost apply_patch",
                model.slug,
            );
        }
    }

    #[tokio::test]
    async fn the_catalogue_is_written_where_the_engine_will_read_it() {
        let Ok(tmp) = tempfile::tempdir() else {
            panic!("tempdir");
        };
        let Ok(path) = write_catalog(tmp.path()).await else {
            panic!("the catalogue must be writable");
        };
        assert!(path.is_file());

        // Round-trips through disk, which is the path the engine takes.
        let Ok(body) = std::fs::read_to_string(&path) else {
            panic!("read back");
        };
        let Ok(reloaded) = serde_json::from_str::<ModelsResponse>(&body) else {
            panic!("the written catalogue must reload");
        };
        assert_eq!(reloaded.models.len(), MODELS.len());
    }
}
