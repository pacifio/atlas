//! Projections of the (`#[non_exhaustive]`, unstable-gated) ACP schema response
//! types into the flat JSON-friendly shapes the Atlas host + UI consume.

use agent_client_protocol::schema::v1::{NewSessionResponse, SessionId};
use serde::Serialize;

/// Public view of a newly created session — what gets returned to the UI.
/// `NewSessionResponse` from the schema is `#[non_exhaustive]`, so we project
/// the bits we actually want to expose.
#[derive(Debug, Clone, Serialize)]
pub struct NewSessionInfo {
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<serde_json::Value>,
    /// The agent's advertised `config_options`, RAW.
    ///
    /// Not redundant with `modes`/`models` above: those are normalised
    /// PROJECTIONS of two well-known ids, and everything else the agent
    /// advertises (Codex's `reasoning_effort`, Claude's `effort`/`fast`) lived
    /// nowhere once they were extracted. Agents that push a
    /// `config_option_update` after session start (Claude) happened to
    /// backfill it; agents that only answer on `session/new` (Codex) left the
    /// host with nothing — which is exactly how the effort picker went missing
    /// for Codex while working for Claude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<serde_json::Value>,
}

impl From<NewSessionResponse> for NewSessionInfo {
    fn from(resp: NewSessionResponse) -> Self {
        // Round-trip via serde_json so we don't have to hand-port every nested
        // schema type (modes / models / config_options are all `non_exhaustive`
        // and gated on unstable features). The TS side already speaks JSON.
        let config_options = serde_json::to_value(&resp.config_options).ok();
        // Config-options-dialect agents (Kilo) omit the legacy `modes` blob and
        // advertise modes as a `SessionConfigOption` select instead — fall back
        // to normalising that so the mode picker still populates.
        let modes = resp
            .modes
            .as_ref()
            .and_then(|m| serde_json::to_value(m).ok())
            .or_else(|| {
                config_options
                    .as_ref()
                    .and_then(modes_blob_from_config_options)
            });
        // ACP 1.x: model selection lives entirely in `config_options` (a
        // `SessionConfigOption` with id/category "model") — the dedicated
        // `models` blob was removed. Normalise it into the
        // `{ currentModelId, availableModels }` shape the rest of the pipeline +
        // the UI expect; selection is pushed via `session/set_config_option`.
        let models = config_options
            .as_ref()
            .and_then(model_blob_from_config_options);
        Self {
            session_id: resp.session_id,
            modes,
            models,
            config_options: config_options.filter(|v| v.as_array().is_some_and(|a| !a.is_empty())),
        }
    }
}

/// What a resumed session advertises. Mirrors the `session/new` projection so
/// `load_session` seeds exactly the same state — a resumed Codex session must
/// get its `reasoning_effort` picker back, not just its modes.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LoadedSessionInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<serde_json::Value>,
}

/// Normalise a `config_options` array into a `SessionModeState`-shaped JSON
/// blob (`{ currentModeId, availableModes: [{id,name,description}] }`) by
/// finding the `select` option with id/category "mode". Config-options-dialect
/// agents (Kilo) advertise modes ONLY this way — no legacy `modes` field.
/// Returns `None` when absent so legacy agents are untouched.
pub(crate) fn modes_blob_from_config_options(
    config_options: &serde_json::Value,
) -> Option<serde_json::Value> {
    let arr = config_options.as_array()?;
    let opt = arr.iter().find(|o| {
        o.get("id").and_then(|v| v.as_str()) == Some("mode")
            || o.get("category").and_then(|v| v.as_str()) == Some("mode")
    })?;
    let current = opt.get("currentValue").and_then(|v| v.as_str())?.to_string();
    let raw = opt.get("options").and_then(|v| v.as_array())?;
    let available: Vec<serde_json::Value> = raw
        .iter()
        .filter_map(|o| {
            let value = o.get("value").and_then(|v| v.as_str())?;
            let name = o.get("name").and_then(|v| v.as_str()).unwrap_or(value);
            let description = o.get("description").and_then(|v| v.as_str());
            Some(serde_json::json!({
                "id": value,
                "name": name,
                "description": description,
            }))
        })
        .collect();
    if available.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "currentModeId": current,
        "availableModes": available,
    }))
}

/// Normalise a `config_options` array into a `SessionModelState`-shaped JSON
/// blob (`{ currentModelId, availableModels: [{modelId,name,description}] }`) by
/// finding the `select` option with id/category "model". Returns `None` if
/// there's no model option (so the caller falls through to "no models"). Handles
/// both ungrouped and grouped option lists.
fn model_blob_from_config_options(config_options: &serde_json::Value) -> Option<serde_json::Value> {
    let arr = config_options.as_array()?;
    let opt = arr.iter().find(|o| {
        o.get("id").and_then(|v| v.as_str()) == Some("model")
            || o.get("category").and_then(|v| v.as_str()) == Some("model")
    })?;
    let current = opt.get("currentValue").and_then(|v| v.as_str())?.to_string();
    // `options` is either an array of `{value,name,description}` (ungrouped) or
    // an array of `{group,name,options:[...]}` (grouped) — flatten both.
    let raw = opt.get("options").and_then(|v| v.as_array())?;
    let mut available: Vec<serde_json::Value> = Vec::new();
    for item in raw {
        let leaves = if item.get("value").is_some() {
            std::slice::from_ref(item).to_vec()
        } else if let Some(group) = item.get("options").and_then(|v| v.as_array()) {
            group.clone()
        } else {
            Vec::new()
        };
        for o in leaves {
            let Some(value) = o.get("value").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = o.get("name").and_then(|v| v.as_str()).unwrap_or(value);
            let description = o.get("description").and_then(|v| v.as_str());
            available.push(serde_json::json!({
                "modelId": value,
                "name": name,
                "description": description,
            }));
        }
    }
    if available.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "currentModelId": current,
        "availableModels": available,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim `configOptions` shapes from live `codex-acp` 1.6.2 and
    /// `claude-agent-acp` 0.70.0 `session/new` probes (2026-08-22). Codex is
    /// the load-bearing case: it advertises `reasoning_effort` ONLY here — it
    /// never pushes a `config_option_update` — so dropping the raw list from
    /// the projection is precisely how its effort picker went missing while
    /// Claude's (which does push) kept working.
    fn codex_new_session_response() -> NewSessionResponse {
        serde_json::from_value(serde_json::json!({
            "sessionId": "sess-codex-1",
            "configOptions": [
                {"id":"mode","name":"Mode","category":"mode","type":"select",
                 "currentValue":"agent",
                 "options":[{"value":"read-only","name":"Read Only"},
                            {"value":"agent","name":"Agent"},
                            {"value":"agent-full-access","name":"Full Access"}]},
                {"id":"model","name":"Model","category":"model","type":"select",
                 "currentValue":"gpt-5.6-terra",
                 "options":[{"value":"gpt-5.6-terra","name":"GPT-5.6-Terra"},
                            {"value":"gpt-5.6-luna","name":"GPT-5.6-Luna"}]},
                {"id":"reasoning_effort","name":"Reasoning Effort",
                 "category":"thought_level","type":"select",
                 "currentValue":"medium",
                 "options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},
                            {"value":"high","name":"High"},{"value":"xhigh","name":"Xhigh"},
                            {"value":"max","name":"Max"},{"value":"ultra","name":"Ultra"}]}
            ]
        }))
        .expect("live codex session/new shape decodes")
    }

    #[test]
    fn new_session_info_carries_config_options_raw() {
        // The projection must keep the FULL advertised list alongside the
        // derived modes/models — `reasoning_effort` has no derived form, and
        // the composer's effort picker reads it from exactly this field.
        let info: NewSessionInfo = codex_new_session_response().into();
        let opts = info.config_options.expect("raw options carried");
        let arr = opts.as_array().unwrap();
        assert_eq!(arr.len(), 3, "nothing filtered out of the advertisement");
        let effort = arr
            .iter()
            .find(|o| o["category"] == "thought_level")
            .expect("reasoning effort present, findable by CATEGORY (its id is
                     agent-specific: codex says reasoning_effort, claude says effort)");
        assert_eq!(effort["currentValue"], "medium");
        assert_eq!(effort["options"].as_array().unwrap().len(), 6);
        // …and the derived projections still work off the same list.
        assert!(info.modes.is_some(), "mode select still projects to modes");
        assert!(info.models.is_some(), "model select still projects to models");
    }

    #[test]
    fn empty_config_options_project_to_none() {
        // An agent with no options must record None, not Some([]) — the UI
        // treats "advertised nothing" and "not yet seeded" differently.
        let resp: NewSessionResponse =
            serde_json::from_value(serde_json::json!({ "sessionId": "s", "configOptions": [] }))
                .unwrap();
        let info: NewSessionInfo = resp.into();
        assert!(info.config_options.is_none());
    }

    /// Verbatim (truncated) `configOptions` from a live `kilo acp` 7.4.20
    /// `session/new` probe — the config-options dialect with NO legacy
    /// `modes`/`models` blobs.
    fn kilo_config_options() -> serde_json::Value {
        serde_json::json!([
            {"id":"model","name":"Model","category":"model","type":"select",
             "currentValue":"kilo/google/gemini-3-pro-image",
             "options":[
               {"value":"openai/gpt-5.4","name":"OpenAI/GPT-5.4"},
               {"value":"kilo/anthropic/claude-opus-5","name":"Kilo Gateway/Claude Opus 5"}
             ]},
            {"id":"effort","name":"Effort","category":"thought_level","type":"select",
             "currentValue":"thinking","options":[{"value":"thinking","name":"Thinking"}]},
            {"id":"mode","name":"Session Mode","category":"mode","type":"select",
             "currentValue":"code",
             "options":[
               {"value":"code","name":"code","description":"The default agent."},
               {"value":"ask","name":"ask","description":"Get answers without changes."},
               {"value":"plan","name":"plan","description":"Plan mode."}
             ]}
        ])
    }

    #[test]
    fn kilo_modes_normalise_from_config_options() {
        let blob = modes_blob_from_config_options(&kilo_config_options()).unwrap();
        assert_eq!(blob["currentModeId"], "code");
        let modes = blob["availableModes"].as_array().unwrap();
        assert_eq!(modes.len(), 3);
        assert_eq!(modes[0]["id"], "code");
        assert_eq!(modes[2]["description"], "Plan mode.");
    }

    #[test]
    fn kilo_models_normalise_from_config_options() {
        let blob = model_blob_from_config_options(&kilo_config_options()).unwrap();
        assert_eq!(blob["currentModelId"], "kilo/google/gemini-3-pro-image");
        let models = blob["availableModels"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[1]["modelId"], "kilo/anthropic/claude-opus-5");
    }

    #[test]
    fn modes_fallback_absent_without_mode_option() {
        // Legacy agents (no config-options mode select) must yield None so the
        // `resp.modes` path stays authoritative.
        let co = serde_json::json!([
            {"id":"model","category":"model","type":"select","currentValue":"x",
             "options":[{"value":"x","name":"X"}]}
        ]);
        assert!(modes_blob_from_config_options(&co).is_none());
    }
}
