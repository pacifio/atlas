//! How a downloaded embedding model is driven: pooling, prefixes, limits.
//! Written next to the weights as `atlas-embed.json` by the downloader; an
//! absent file means the BERT sentence-transformer default every pre-spec
//! model used (mean pooling, no prefixes, 512 tokens).

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SPEC_FILE: &str = "atlas-embed.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pooling {
    #[default]
    Mean,
    Cls,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelSpec {
    pub pooling: Pooling,
    pub query_prefix: String,
    pub document_prefix: String,
    pub max_tokens: usize,
    pub batch_size: usize,
}

impl Default for ModelSpec {
    fn default() -> Self {
        Self {
            pooling: Pooling::Mean,
            query_prefix: String::new(),
            document_prefix: String::new(),
            max_tokens: 512,
            batch_size: 16,
        }
    }
}

impl ModelSpec {
    pub fn load(model_dir: &Path) -> Self {
        std::fs::read_to_string(model_dir.join(SPEC_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn write(&self, model_dir: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(model_dir.join(SPEC_FILE), json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_broken_spec_is_the_bert_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(ModelSpec::load(dir.path()), ModelSpec::default());
        std::fs::write(dir.path().join(SPEC_FILE), "{not json").unwrap();
        assert_eq!(ModelSpec::load(dir.path()).pooling, Pooling::Mean);
    }

    #[test]
    fn a_spec_round_trips_through_the_model_dir() {
        let dir = tempfile::tempdir().unwrap();
        let spec = ModelSpec {
            pooling: Pooling::Cls,
            query_prefix: "query: ".into(),
            document_prefix: "passage: ".into(),
            max_tokens: 1024,
            batch_size: 8,
        };
        spec.write(dir.path()).unwrap();
        assert_eq!(ModelSpec::load(dir.path()), spec);
    }
}
