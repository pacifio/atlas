// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use crate::config_toml::ConfigToml;
use crate::types::RawMcpServerConfig;
use atlas_engine_features::FEATURES;
use atlas_engine_features::legacy_feature_keys;
use atlas_engine_protocol::schema_compat::Compat08;
use schemars::JsonSchema;
use schemars::Schema;
use schemars::SchemaGenerator;
use schemars::generate::SchemaSettings;
use schemars::json_schema;
use serde_json::Map;
use serde_json::Value;
use std::path::Path;

/// Schema for the `[features]` map with known + legacy keys only.
pub fn features_schema(schema_gen: &mut SchemaGenerator) -> Schema {
    let mut properties = Map::new();
    for feature in FEATURES {
        if feature.id == atlas_engine_features::Feature::Artifact {
            continue;
        }
        if feature.id == atlas_engine_features::Feature::CodeMode {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<atlas_engine_features::CodeModeConfigToml>,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::CodeModeHost {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::CodeModeHostConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::NonPrefixedMcpToolNames {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::NonPrefixedMcpToolNamesConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::MultiAgentV2 {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::MultiAgentV2ConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::TokenBudget {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::TokenBudgetConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::RolloutBudget {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::RolloutBudgetConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::CurrentTimeReminder {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::CurrentTimeReminderConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::AppsMcpPathOverride {
            properties.insert(
                feature.key.to_string(),
                removed_apps_mcp_path_override_schema(schema_gen).to_value(),
            );
            continue;
        }
        if feature.id == atlas_engine_features::Feature::NetworkProxy {
            properties.insert(
                feature.key.to_string(),
                subschema::<
                    atlas_engine_features::FeatureToml<
                        atlas_engine_features::NetworkProxyConfigToml,
                    >,
                >(schema_gen),
            );
            continue;
        }
        properties.insert(feature.key.to_string(), subschema::<bool>(schema_gen));
    }
    for legacy_key in legacy_feature_keys() {
        properties.insert(legacy_key.to_string(), subschema::<bool>(schema_gen));
    }
    properties.insert(
        "tool_registry".to_string(),
        subschema::<atlas_engine_features::ToolRegistryConfigToml>(schema_gen),
    );
    json_schema!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
    })
}

fn removed_apps_mcp_path_override_schema(schema_gen: &mut SchemaGenerator) -> Schema {
    let config = json_schema!({
        "type": "object",
        "properties": {
            "enabled": subschema::<bool>(schema_gen),
            "path": subschema::<String>(schema_gen),
        },
        "additionalProperties": false,
    });
    json_schema!({
        "anyOf": [subschema::<bool>(schema_gen), config],
    })
}

/// Schema for the `[mcp_servers]` map using the raw input shape.
pub fn mcp_servers_schema(schema_gen: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": subschema::<RawMcpServerConfig>(schema_gen),
    })
}

/// A subschema as plain JSON, for splicing into a hand-built schema.
fn subschema<T: JsonSchema + ?Sized>(schema_gen: &mut SchemaGenerator) -> Value {
    schema_gen.subschema_for::<T>().to_value()
}

/// Build the config schema for `config.toml`.
pub fn config_schema() -> Schema {
    let mut schema = SchemaSettings::draft07()
        .with_transform(Compat08::without_null())
        .into_generator()
        .into_root_schema_for::<ConfigToml>();
    add_shell_environment_policy_constraints(&mut schema);
    restore_flattened_map_additional_properties(&mut schema);
    schema
}

/// `additionalProperties` of the structs that `#[serde(flatten)]` a map.
///
/// schemars 0.8 took that keyword from the flattened map only when the struct
/// also had `deny_unknown_fields`, and left it out otherwise. schemars 1 does
/// the opposite, which is more accurate but would rewrite the committed
/// `config.schema.json`. `None` removes the keyword.
fn restore_flattened_map_additional_properties(schema: &mut Schema) {
    let restored: [(&str, Option<Value>); 9] = [
        (
            "AgentsToml",
            Some(serde_json::json!({ "$ref": "#/definitions/AgentRoleToml" })),
        ),
        (
            "AppToolsConfig",
            Some(serde_json::json!({ "$ref": "#/definitions/AppToolConfig" })),
        ),
        (
            "AppsConfigToml",
            Some(serde_json::json!({ "$ref": "#/definitions/AppConfig" })),
        ),
        (
            "ModelAvailabilityNuxConfig",
            Some(serde_json::json!({ "type": "integer", "format": "uint32", "minimum": 0.0 })),
        ),
        ("FilesystemPermissionsToml", None),
        ("NetworkDomainPermissionsToml", None),
        ("NetworkUnixSocketPermissionsToml", None),
        ("PermissionsToml", None),
        ("WorkspaceRootsToml", None),
    ];
    for (name, additional_properties) in restored {
        let Some(definition) = schema
            .pointer_mut(&format!("/definitions/{name}"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        match additional_properties {
            Some(value) => definition.insert("additionalProperties".to_string(), value),
            None => definition.remove("additionalProperties"),
        };
    }
}

fn add_shell_environment_policy_constraints(schema: &mut Schema) {
    let Some(policy) = schema
        .pointer_mut("/definitions/ShellEnvironmentPolicyToml")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Value::Array(all_of) = policy
        .entry("allOf")
        .or_insert_with(|| Value::Array(Vec::new()))
    else {
        return;
    };
    for fields in [["exclude", "filters"], ["filters", "include_only"]] {
        all_of.push(serde_json::json!({ "not": { "required": fields } }));
    }
}

/// Canonicalize a JSON value by sorting its keys.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            let mut sorted = Map::with_capacity(map.len());
            for (key, child) in entries {
                sorted.insert(key.clone(), canonicalize(child));
            }
            Value::Object(sorted)
        }
        _ => value.clone(),
    }
}

/// The Apache-2.0 §4(b) change notice carried by `config.schema.json`.
///
/// It is injected here rather than hand-written into the fixture because the
/// fixture is *generated*: a header typed into the file would be silently
/// dropped by the next `write_config_schema`, and `config_schema_matches_fixture`
/// would then fail for a reason that looks nothing like its cause. `$comment` is
/// a draft-07 keyword that validators ignore. See CONTEXT.md, "Engine
/// licensing".
const ATLAS_CHANGE_NOTICE: &str =
    "Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.";

/// Render the config schema as pretty-printed JSON.
pub fn config_schema_json() -> anyhow::Result<Vec<u8>> {
    let schema = config_schema();
    let value = serde_json::to_value(schema)?;
    let mut value = canonicalize(&value);
    if let Some(root) = value.as_object_mut() {
        root.insert(
            "$comment".to_string(),
            serde_json::Value::String(ATLAS_CHANGE_NOTICE.to_string()),
        );
    }
    let json = serde_json::to_vec_pretty(&value)?;
    Ok(json)
}

/// Write the config schema fixture to disk.
pub fn write_config_schema(out_path: &Path) -> anyhow::Result<()> {
    let json = config_schema_json()?;
    std::fs::write(out_path, json)?;
    Ok(())
}
