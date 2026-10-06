//! The app's code embedder: the selected code model, loaded once on a
//! blocking thread, handed to the code index registry.

use std::sync::atomic::{AtomicU64, Ordering};
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

/// Refreshes overlap (a slow load still running when the user picks another
/// model); only the latest one may install its result.
static LATEST: AtomicU64 = AtomicU64::new(0);

/// Start a refresh; its ticket stays current until a newer refresh starts.
fn begin() -> u64 {
    LATEST.fetch_add(1, Ordering::SeqCst) + 1
}

fn is_current(ticket: u64) -> bool {
    LATEST.load(Ordering::SeqCst) == ticket
}

/// Load the selected code model if it is downloaded and give it to the
/// registry (`None` when it is not: search stays keyword + symbol). Called at
/// startup, after a code model downloads, and when the selection changes.
pub async fn refresh(app: &AppHandle) {
    let ticket = begin();
    let Some(registry) = app.try_state::<Arc<super::CodeIndexRegistry>>() else {
        return;
    };
    let registry = registry.inner().clone();
    // A newer refresh decides; this one's (possibly outdated) model is dropped.
    let install = |e: Option<Arc<dyn atlas_codeindex::Embedder>>| {
        if is_current(ticket) {
            registry.set_embedder(e);
        }
    };
    let id = crate::state::atlas_config::read(app).code_embedding_model_id;
    if !crate::commands::models::is_downloaded(app, &id) {
        install(None);
        return;
    }
    let dir = match crate::commands::models::model_dir_for(app, &id) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!(target: "atlas::code_index", "code model {id}: {e}");
            install(None);
            return;
        }
    };
    // Written on every load, not only at download: a model downloaded before its
    // preset changed, or placed by hand, is driven with today's pooling, prefixes
    // and batch size (without the file it would fall back to mean pooling).
    if let Some(spec) = crate::commands::models::code_model_spec(&id) {
        if let Err(e) = spec.write(&dir) {
            tracing::warn!(target: "atlas::code_index", "code model {id}: write spec: {e}");
        }
    }
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
            install(Some(
                Arc::new(embedder) as Arc<dyn atlas_codeindex::Embedder>
            ));
        }
        Ok(Err(e)) => {
            tracing::warn!(target: "atlas::code_index", "load code model {id}: {e:#}");
            install(None);
        }
        Err(e) => {
            tracing::warn!(target: "atlas::code_index", "load code model {id}: {e}");
            install(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_latest_refresh_installs() {
        let older = begin();
        let newer = begin();
        assert!(!is_current(older));
        assert!(is_current(newer));
    }
}
