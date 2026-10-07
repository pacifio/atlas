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

    /// ibm-granite/granite-embedding-small-english-r2, the default code model:
    /// CLS pooling, no prefixes (model card). Trained to 8192 positions; capped
    /// at 1024 like the other code models, which fits the 1800-character chunks.
    /// Batches of 4: attention memory grows with batch × tokens², and on CPU a
    /// batch of 16 peaked at 4.5 GB against 1.29 GB for 4, at about the same speed.
    pub fn granite_embedding_small() -> Self {
        Self {
            pooling: Pooling::Cls,
            query_prefix: String::new(),
            document_prefix: String::new(),
            max_tokens: 1024,
            batch_size: 4,
        }
    }

    /// The preset Atlas runs a code model with, by the model's catalog id (its
    /// directory name), or `None` for a model that is not a code model.
    pub fn for_code_model(id: &str) -> Option<Self> {
        match id {
            "granite-embedding-small-r2" => Some(Self::granite_embedding_small()),
            "coderankembed" => Some(Self::code_rank_embed()),
            _ => None,
        }
    }

    /// nomic-ai/CodeRankEmbed: CLS pooling, query instruction prefix (model card).
    pub fn code_rank_embed() -> Self {
        Self {
            pooling: Pooling::Cls,
            query_prefix: "Represent this query for searching relevant code: ".into(),
            document_prefix: String::new(),
            max_tokens: 1024,
            batch_size: 8,
        }
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
    fn code_models_are_found_by_catalog_id() {
        assert_eq!(
            ModelSpec::for_code_model("granite-embedding-small-r2"),
            Some(ModelSpec::granite_embedding_small())
        );
        assert_eq!(
            ModelSpec::for_code_model("coderankembed"),
            Some(ModelSpec::code_rank_embed())
        );
        assert_eq!(ModelSpec::for_code_model("all-minilm-l6-v2"), None);
    }

    #[test]
    fn specs_round_trip_and_presets_match_their_model_cards() {
        let dir = tempfile::tempdir().unwrap();
        ModelSpec::code_rank_embed().write(dir.path()).unwrap();
        let back = ModelSpec::load(dir.path());
        assert_eq!(back.pooling, Pooling::Cls);
        assert_eq!(
            back.query_prefix,
            "Represent this query for searching relevant code: "
        );
        let granite = ModelSpec::granite_embedding_small();
        assert_eq!(granite.pooling, Pooling::Cls);
        assert!(granite.query_prefix.is_empty() && granite.document_prefix.is_empty());
    }
}
