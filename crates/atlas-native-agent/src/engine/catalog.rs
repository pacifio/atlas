//! Projecting a gateway catalogue row into the engine's own record.
//!
//! **No model is named in this file.** The list of models Atlas Agent may use
//! is the gateway's (`GET /v1/catalogue`), fetched and cached by
//! [`crate::engine::catalog_cache`] (ADR-0007). What lives here is the one
//! thing the gateway cannot know: what the engine needs to be told about a
//! model so that a turn over the Chat Completions dialect survives the
//! crossing.
//!
//! The engine can fetch a catalogue from `{base}/models`, and against this
//! gateway that path does not work: the engine's fetch adds a
//! `?client_version=` parameter the contract does not define, and then
//! deserializes the reply as its own rich `{"models":[…]}` record — where the
//! gateway serves the stock OpenAI `{"object":"list","data":[…]}` list, which
//! shares nothing with it but the path segment. So the seam builds the record
//! itself and hands it to the engine through `model_catalog_json`, the
//! engine's first-class static path.
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
//! # The context window
//!
//! `context_window` is the gateway's prompt ceiling for that model, and local
//! auto-compaction fires at 90% of whatever it says. It is the gateway's
//! number to state (it is being asked to — `docs/requests/gateway-catalogue-
//! metadata.md`), and until it does the field is simply absent: the engine
//! then has no ceiling to compact against, and the gateway's `413` is what
//! ends a long thread. Two caveats travel with the number and neither is
//! fixable here: the engine counts real usage-reported tokens while the
//! gateway's `413` gate estimates `ceil(bytes/3)`, so the two meters can
//! cross; and remote compaction is capability-gated to OpenAI and Azure, so
//! only local summarisation defends the ceiling.
//!
//! # The gateway is not Vertex-only
//!
//! `glm-5.3-flash` is served by Cloudflare Workers AI, not by Vertex, and it
//! bills in Workers AI *neurons* rather than tokens. Nothing in this file has
//! to care — the broker still answers OpenAI on the same
//! `/v1/chat/completions` — but do not derive anything here from the
//! publisher. It replies with a `reasoning_content` field alongside
//! `content`, which the chat stream parser reads as a reasoning item, and
//! writes `"tool_calls":null` on those chunks, which the parser reads as an
//! empty array rather than a lost frame.

use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_protocol::openai_models::ModelsResponse;
use serde_json::Value;
use serde_json::json;

/// The file the engine reads the catalogue from.
const CATALOG_FILE: &str = "models.json";

/// One catalogue row, as the engine's `ModelInfo`.
///
/// Authored as JSON and parsed rather than built as a struct literal, for two
/// reasons: it is the same document the engine loads from disk, so this is the
/// shape being asserted on; and the upstream record has forty-odd fields, most
/// of them defaulted, so a struct literal would have to restate every default
/// and would break on every upstream field addition.
///
/// `description` and `context_window` are `Option` because the gateway does
/// not send them yet. `description` is a required *key* on the engine's
/// record, so an absent one is written as `null`; `context_window` is
/// defaulted there, so an absent one is omitted.
pub fn row(
    slug: &str,
    display_name: &str,
    description: Option<&str>,
    context_window: Option<i64>,
    priority: i32,
) -> Value {
    let mut row = json!({
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

        // Every gateway model takes images. The gateway's 2 MB body cap is
        // what bounds them, and that is a policy for the app to enforce
        // (D15c), not a capability to deny here.
        "input_modalities": ["text", "image"],
        "supports_image_detail_original": false,

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
    });
    if let Some(window) = context_window {
        row["context_window"] = json!(window);
        row["max_context_window"] = json!(window);
    }
    row
}

/// Writes the catalogue into the engine's home and returns its path.
///
/// A file rather than an in-memory value because that is the only route the
/// engine offers: `Config` reads a catalogue from the `model_catalog_json` path
/// and nothing else populates it. Written whole (temp file, then rename):
/// the engine re-reads this file on every thread start, and a half-written
/// one is a failed thread rather than a fallback.
pub async fn write_models_json(home: &Path, catalogue: &ModelsResponse) -> Result<PathBuf> {
    tokio::fs::create_dir_all(home)
        .await
        .with_context(|| format!("creating the engine home at {}", home.display()))?;
    let path = home.join(CATALOG_FILE);
    let tmp = home.join(format!("{CATALOG_FILE}.{}.tmp", std::process::id()));
    let body = serde_json::to_vec_pretty(catalogue).context("serialising the model catalogue")?;
    tokio::fs::write(&tmp, body)
        .await
        .with_context(|| format!("writing the model catalogue to {}", tmp.display()))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .with_context(|| format!("moving the model catalogue into place at {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::openai_models::ModelInfo;

    fn parse(value: Value) -> ModelInfo {
        match serde_json::from_value(value) {
            Ok(model) => model,
            Err(err) => panic!("a projected row must parse as the engine's record: {err:#}"),
        }
    }

    #[test]
    fn a_row_parses_as_the_record_the_engine_loads() {
        // The whole point: the engine's remote fetch cannot read the gateway's
        // list, so this row is what the engine knows about a model. A row that
        // does not parse leaves the picker empty and no model selectable.
        let model = parse(row("claude-opus-5", "Claude Opus 5", Some("big"), Some(200_000), 1));
        assert_eq!(model.slug, "claude-opus-5");
        assert_eq!(model.display_name, "Claude Opus 5");
        assert_eq!(model.description.as_deref(), Some("big"));
        assert_eq!(model.priority, 1);
        assert_eq!(model.context_window, Some(200_000));
        assert_eq!(model.auto_compact_token_limit(), Some(180_000));
    }

    #[test]
    fn a_row_without_metadata_still_parses_and_states_no_ceiling() {
        // What every row looks like until the gateway sends metadata: the
        // slug doubles as the name, and there is no window to compact against.
        let model = parse(row("gemini-3.6-flash", "gemini-3.6-flash", None, None, 3));
        assert_eq!(model.description, None);
        assert_eq!(model.context_window, None);
        assert_eq!(model.max_context_window, None);
        assert_eq!(model.auto_compact_token_limit(), None);
    }

    #[test]
    fn no_row_advertises_a_control_this_wire_cannot_carry() {
        // Each of these rides a request field the gateway answers with a 400.
        // A row that claims them puts a knob in the UI that silently does
        // nothing, which is worse than not offering it.
        let model = parse(row("m", "m", None, None, 1));
        assert!(model.supported_reasoning_levels.is_empty());
        assert!(!model.support_verbosity);
        assert!(!model.supports_reasoning_summary_parameter);
        assert!(model.service_tiers.is_empty());
        assert!(!model.use_responses_lite);
        assert!(!model.supports_search_tool);
    }

    #[test]
    fn every_row_carries_instructions_because_an_empty_prompt_is_a_silent_lobotomy() {
        // With no `instructions_template` the engine logs a warning and returns
        // an empty string, and the agent runs with no system prompt at all —
        // visible only as an agent that has forgotten how to do its job.
        let model = parse(row("m", "m", None, None, 1));
        let instructions = model.get_model_instructions(/*personality*/ None);
        assert!(instructions.len() > 1_000, "no usable system prompt ({} bytes)", instructions.len());
    }

    #[test]
    fn apply_patch_survives_the_crossing() {
        // The dialect flattens freeform tools and turns the reply back, so this
        // stays on. If that round trip is ever removed, this row becomes a tool
        // the model is offered and cannot successfully call.
        assert!(parse(row("m", "m", None, None, 1)).apply_patch_tool_type.is_some());
    }

    #[tokio::test]
    async fn the_catalogue_is_written_where_the_engine_will_read_it() {
        let Ok(tmp) = tempfile::tempdir() else {
            panic!("tempdir");
        };
        let response: ModelsResponse = match serde_json::from_value(json!({
            "models": [row("m", "m", None, None, 1)]
        })) {
            Ok(response) => response,
            Err(err) => panic!("parse: {err:#}"),
        };
        let Ok(path) = write_models_json(tmp.path(), &response).await else {
            panic!("the catalogue must be writable");
        };
        assert!(path.is_file());
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(CATALOG_FILE));

        // Round-trips through disk, which is the path the engine takes.
        let Ok(body) = std::fs::read_to_string(&path) else {
            panic!("read back");
        };
        let Ok(reloaded) = serde_json::from_str::<ModelsResponse>(&body) else {
            panic!("the written catalogue must reload");
        };
        assert_eq!(reloaded.models.len(), 1);
    }
}
