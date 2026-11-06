// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use std::fmt;
use std::ops::Deref;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// A Responses API item ID. New IDs require an explicit prefix; deserialization
/// remains permissive so legacy rollouts can still be read.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(type = "string")]
pub struct ResponseItemId(String);

/// Inlined as a plain string without the description above. schemars 0.8 treated
/// a transparent struct that way; schemars 1 gives a documented one a definition
/// of its own, which would rewrite the committed app-server schemas.
impl JsonSchema for ResponseItemId {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        "ResponseItemId".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        String::json_schema(generator)
    }
}

impl ResponseItemId {
    pub fn new(prefix: &str) -> Self {
        Self::with_suffix(prefix, uuid::Uuid::now_v7())
    }

    pub fn with_suffix(prefix: &str, suffix: impl fmt::Display) -> Self {
        Self(format!("{prefix}_{suffix}"))
    }

    pub fn from_server(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_prefixed(&self) -> bool {
        self.split_once('_')
            .is_some_and(|(prefix, suffix)| !prefix.is_empty() && !suffix.is_empty())
    }
}

impl Deref for ResponseItemId {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl AsRef<str> for ResponseItemId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for ResponseItemId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl From<ResponseItemId> for String {
    fn from(value: ResponseItemId) -> Self {
        value.0
    }
}

#[cfg(test)]
#[path = "response_item_id_tests.rs"]
mod tests;
