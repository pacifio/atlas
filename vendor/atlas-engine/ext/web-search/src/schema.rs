// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use atlas_engine_api::SearchCommands;
use atlas_engine_protocol::schema_compat::Compat08;
use schemars::generate::SchemaSettings;
use serde_json::Map;
use serde_json::Value;

pub(crate) fn commands_schema() -> Value {
    let schema = SchemaSettings::draft2019_09()
        .with(|settings| {
            settings.inline_subschemas = true;
            settings.transforms.push(Box::new(Compat08::without_null()));
        })
        .into_generator()
        .into_root_schema_for::<SearchCommands>();
    let schema = match serde_json::to_value(schema) {
        Ok(schema) => schema,
        Err(err) => panic!("search commands schema should serialize: {err}"),
    };
    let Value::Object(mut schema) = schema else {
        unreachable!("search commands schema must be an object");
    };

    let mut tool_schema = Map::new();
    for key in [
        "properties",
        "required",
        "type",
        "additionalProperties",
        "$defs",
        "definitions",
    ] {
        if let Some(value) = schema.remove(key) {
            tool_schema.insert(key.to_string(), value);
        }
    }
    Value::Object(tool_schema)
}
