//! The app's code embedder: the selected code model, loaded once on a
//! blocking thread, handed to the code index registry.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

pub struct CodeEmbedder {
    inner: atlas_embed::Embedder,
    id: String,
}

impl atlas_codeindex::Embedder for CodeEmbedder {
    fn model_id(&self) -> &str {
        &self.id
    }

    fn dims(&self) -> usize {
        self.inner.dim()
    }

    fn embed_documents(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        self.inner.embed_documents(texts).map_err(|e| e.to_string())
    }

    fn embed_query(&self, text: &str) -> Result<Vec<f32>, String> {
        self.inner.embed_query(text).map_err(|e| e.to_string())
    }
}

/// Load the selected code model if it is downloaded and give it to the
/// registry (`None` when it is not: search stays keyword + symbol). Called at
/// startup, after a code model downloads, and when the selection changes.
pub async fn refresh(app: &AppHandle) {
    let Some(registry) = app.try_state::<Arc<super::CodeIndexRegistry>>() else {
        return;
    };
    let registry = registry.inner().clone();
    let id = crate::state::atlas_config::read(app).code_embedding_model_id;
    if !crate::commands::models::is_downloaded(app, &id) {
        registry.set_embedder(None);
        return;
    }
    let dir = match crate::commands::models::model_dir_for(app, &id) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!(target: "atlas::code_index", "code model {id}: {e}");
            registry.set_embedder(None);
            return;
        }
    };
    let model = id.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        atlas_embed::Embedder::load(&dir).map(|inner| CodeEmbedder { inner, id: model })
    })
    .await;
    match loaded {
        Ok(Ok(embedder)) => {
            tracing::info!(
                target: "atlas::code_index",
                "code model {id} loaded ({} dims, {})",
                embedder.inner.dim(),
                embedder.inner.backend()
            );
            registry.set_embedder(Some(Arc::new(embedder)));
        }
        Ok(Err(e)) => {
            tracing::warn!(target: "atlas::code_index", "load code model {id}: {e:#}");
            registry.set_embedder(None);
        }
        Err(e) => {
            tracing::warn!(target: "atlas::code_index", "load code model {id}: {e}");
            registry.set_embedder(None);
        }
    }
}
