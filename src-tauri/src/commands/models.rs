//! `models` — the Local Model Manager: a curated catalog of on-device
//! **embedding** models the user can search (curated + HuggingFace), download,
//! remove, and select. The selected id lives in `AppSettings`
//! (`embedding_model_id`) and is read by the resolver chokepoint
//! (`memory_graph::model_dir`), so every on-device consumer follows the user's
//! choice automatically.
//!
//! Scope (locked): only models the existing candle loader accepts —
//! **BERT-family** sentence-transformers (`atlas_embed::Embedder`, varied dims).
//! Other architectures are surfaced by HF search but flagged incompatible.
//!
//! On-device *generation* was removed on 2026-08-22 (see `codebase_index`): the
//! only consumer was the code-index Tier-2 summary, which now runs on BYOK.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::memory_indexer::MemoryRegistry;
use crate::state::app_state::AppStateHandle;

/// Embedding models all expose the same three sentence-transformer files; only the
/// source repo differs.
pub const EMBED_FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

/// Retained as a single-variant enum: it is part of the wire shape the frontend
/// filters on, and keeping it leaves room for a second on-device model class
/// without another migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Embedding,
}

/// One file to fetch from `https://huggingface.co/{repo}/resolve/{revision}/{file}`
/// into `dest` under the model's dir. Per-file repo so a model can mix sources.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSpec {
    pub repo: String,
    pub file: String,
    pub dest: String,
}

/// A catalog entry. `id` doubles as the on-disk dir name under `app_data/models/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub kind: ModelKind,
    pub name: String,
    /// HF repo the model "belongs" to (for the detail link); files may pull from
    /// other repos (see `files`).
    pub repo: String,
    pub files: Vec<FileSpec>,
    /// Embedding output dim (embedding models only) — informational; the live dim
    /// is read from the loaded model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dim: Option<usize>,
    pub size_mb: u32,
    pub description: String,
    /// Loadable by the current on-device loaders. Curated entries are always true;
    /// HF-search hits may be false.
    pub compatible: bool,
}

impl ModelEntry {
    /// Local filenames this model needs present to count as "downloaded".
    fn dest_files(&self) -> Vec<&str> {
        self.files.iter().map(|f| f.dest.as_str()).collect()
    }
}

fn embed_repo(id: &str, name: &str, repo: &str, dim: usize, size_mb: u32, desc: &str) -> ModelEntry {
    let files = EMBED_FILES
        .iter()
        .map(|f| FileSpec {
            repo: repo.to_string(),
            file: f.to_string(),
            dest: f.to_string(),
        })
        .collect();
    ModelEntry {
        id: id.to_string(),
        kind: ModelKind::Embedding,
        name: name.to_string(),
        repo: repo.to_string(),
        files,
        dim: Some(dim),
        size_mb,
        description: desc.to_string(),
        compatible: true,
    }
}

/// The curated, guaranteed-compatible catalog. BERT sentence-transformers (384 or
/// 768 dim). Ids match the historical dir names so existing downloads are reused
/// with no migration.
pub fn builtin_catalog() -> Vec<ModelEntry> {
    vec![
        // ── Embedding (BERT-family) ──
        embed_repo("all-MiniLM-L6-v2", "MiniLM-L6-v2", "sentence-transformers/all-MiniLM-L6-v2", 384, 90, "Fast, tiny general-purpose embeddings. The default."),
        embed_repo("all-MiniLM-L12-v2", "MiniLM-L12-v2", "sentence-transformers/all-MiniLM-L12-v2", 384, 130, "Higher-quality MiniLM (12 layers); still fast and 384-d."),
        embed_repo("bge-small-en-v1.5", "BGE-small-en v1.5", "BAAI/bge-small-en-v1.5", 384, 130, "Strong retrieval quality at 384-d; drop-in for MiniLM."),
        embed_repo("gte-small", "GTE-small", "thenlper/gte-small", 384, 70, "General Text Embeddings, small (384-d)."),
        embed_repo("e5-small-v2", "E5-small v2", "intfloat/e5-small-v2", 384, 130, "E5 retrieval embeddings (384-d)."),
        embed_repo("bge-base-en-v1.5", "BGE-base-en v1.5", "BAAI/bge-base-en-v1.5", 768, 440, "Higher-quality 768-d embeddings (rebuilds the index)."),
        embed_repo("gte-base", "GTE-base", "thenlper/gte-base", 768, 220, "General Text Embeddings, base (768-d, rebuilds the index)."),
    ]
}

pub fn find_entry(id: &str) -> Option<ModelEntry> {
    builtin_catalog().into_iter().find(|e| e.id == id)
}

// ── Selection + path resolution (the chokepoints delegate here) ────────────────

/// Root dir holding every downloaded model: `app_data/models/`.
pub fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create models dir: {e}"))?;
    Ok(dir)
}

/// On-disk dir for a model id (created lazily).
pub fn model_dir_for(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = models_root(app)?.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;
    Ok(dir)
}

pub fn selected_embedding_id(app: &AppHandle) -> String {
    app.state::<AppStateHandle>()
        .lock()
        .settings
        .embedding_model_id
        .clone()
}

/// Whether every file for `id` exists on disk. Uses the catalog's file list; for an
/// unknown id (e.g. a legacy/manual dir) falls back to the embedding file triplet.
pub fn is_downloaded(app: &AppHandle, id: &str) -> bool {
    let Ok(dir) = model_dir_for(app, id) else { return false };
    match find_entry(id) {
        Some(e) => e.dest_files().iter().all(|f| dir.join(f).exists()),
        None => EMBED_FILES.iter().all(|f| dir.join(f).exists()),
    }
}

// ── Shared streamed downloader ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Model id (so a single generic listener can route progress).
    pub id: String,
    pub file: String,
    pub file_index: usize,
    pub file_count: usize,
    pub received: u64,
    pub total: u64,
}

/// Download `files` into `dir`, emitting `{progress_event}` with throttled progress.
/// Atomic per-file (`.part` → rename); already-present files are skipped. Caller
/// emits the terminal "done" event.
pub async fn download_files(
    app: &AppHandle,
    id: &str,
    dir: &Path,
    files: &[FileSpec],
    progress_event: &str,
) -> Result<(), String> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let file_count = files.len();
    for (idx, spec) in files.iter().enumerate() {
        let dest_path = dir.join(&spec.dest);
        if dest_path.exists() {
            continue;
        }
        let url = format!(
            "https://huggingface.co/{}/resolve/main/{}",
            spec.repo, spec.file
        );
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("GET {}: {e}", spec.file))?
            .error_for_status()
            .map_err(|e| format!("GET {}: {e}", spec.file))?;
        let total = resp.content_length().unwrap_or(0);

        let tmp = dir.join(format!("{}.part", spec.dest));
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("create {}: {e}", spec.dest))?;

        let mut received: u64 = 0;
        let mut last_emit: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download {}: {e}", spec.dest))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {}: {e}", spec.dest))?;
            received += chunk.len() as u64;
            if received - last_emit >= 2_097_152 {
                last_emit = received;
                let _ = app.emit(
                    progress_event,
                    DownloadProgress {
                        id: id.to_string(),
                        file: spec.dest.clone(),
                        file_index: idx,
                        file_count,
                        received,
                        total,
                    },
                );
            }
        }
        file.flush().await.map_err(|e| format!("flush {}: {e}", spec.dest))?;
        drop(file);
        tokio::fs::rename(&tmp, &dest_path)
            .await
            .map_err(|e| format!("finalize {}: {e}", spec.dest))?;
        let _ = app.emit(
            progress_event,
            DownloadProgress {
                id: id.to_string(),
                file: spec.dest.clone(),
                file_index: idx,
                file_count,
                received,
                total: total.max(received),
            },
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
struct DownloadDone {
    id: String,
    success: bool,
    error: Option<String>,
}

// ── Commands ───────────────────────────────────────────────────────────────────

/// A catalog entry plus per-machine state, for the manager table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub entry: ModelEntry,
    pub downloaded: bool,
    pub selected: bool,
}

/// The curated catalog with downloaded/selected flags for the current machine.
#[tauri::command]
pub async fn models_list(app: AppHandle) -> Result<Vec<ModelStatus>, String> {
    let sel_embed = selected_embedding_id(&app);
    Ok(builtin_catalog()
        .into_iter()
        .map(|entry| {
            let downloaded = is_downloaded(&app, &entry.id);
            let selected = match entry.kind {
                ModelKind::Embedding => entry.id == sel_embed,
            };
            ModelStatus {
                entry,
                downloaded,
                selected,
            }
        })
        .collect())
}

/// Download a catalog model in the background. Frontend listens on
/// `atlas:model-download:progress` / `:done` (both carry `id`).
#[tauri::command]
pub async fn model_download(app: AppHandle, id: String) -> Result<(), String> {
    let entry = find_entry(&id).ok_or_else(|| format!("unknown model '{id}'"))?;
    let dir = model_dir_for(&app, &id)?;
    tokio::spawn(async move {
        let result = download_files(&app, &id, &dir, &entry.files, "atlas:model-download:progress").await;
        let _ = app.emit(
            "atlas:model-download:done",
            DownloadDone {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            },
        );
        let _ = app.emit("atlas:models-changed", ());
    });
    Ok(())
}

/// Delete a downloaded model's files. Refuses to delete a currently-selected model
/// (the frontend guards too).
#[tauri::command]
pub async fn model_remove(app: AppHandle, id: String) -> Result<(), String> {
    if id == selected_embedding_id(&app) {
        return Err("Can't remove the model that's currently selected.".into());
    }
    let dir = model_dir_for(&app, &id)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {id}: {e}"))?;
    let _ = app.emit("atlas:models-changed", ());
    Ok(())
}

/// Result of selecting a model — tells the frontend whether a memory-index rebuild
/// is required (embedding switch) so it can confirm-then-reindex (option 4B).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectResult {
    pub needs_reindex: bool,
}

/// Set the selected embedding model. Persists the setting, invalidates the cached
/// provider so the next call reloads, and reports that the memory index must be
/// rebuilt. The caller (frontend) confirms with the user, then calls
/// `force_reindex` per open project.
#[tauri::command]
pub async fn model_select(
    app: AppHandle,
    id: String,
    registry: State<'_, std::sync::Arc<MemoryRegistry>>,
) -> Result<SelectResult, String> {
    let entry = find_entry(&id).ok_or_else(|| format!("unknown model '{id}'"))?;
    if !is_downloaded(&app, &id) {
        return Err("Download the model before selecting it.".into());
    }

    let state = app.state::<AppStateHandle>();
    let mut needs_reindex = false;
    {
        let mut s = state.lock();
        match entry.kind {
            ModelKind::Embedding => {
                if s.settings.embedding_model_id != id {
                    s.settings.embedding_model_id = id.clone();
                    needs_reindex = true;
                }
            }
        }
        crate::state::app_state::AppState::save(&app, &s).map_err(|e| format!("save settings: {e}"))?;
    }

    // Drop cached models so the next call loads the newly selected one.
    match entry.kind {
        ModelKind::Embedding => registry.invalidate_provider().await,
    }

    let _ = app.emit("atlas:models-changed", ());
    Ok(SelectResult { needs_reindex })
}
