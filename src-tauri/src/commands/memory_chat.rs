//! Memory-Chat — a local RAG chat over a project's indexed memory.
//!
//! Retrieval reuses the existing memory embedding index (`memory_graph`):
//! embed the question with MiniLM, cosine-search the per-project vector store,
//! and pull the matching documents' text from `agent_memory::collect_corpus`.
//! Generation is fully local too — a small quantized Qwen2.5-Instruct model
//! (`atlas_embed::chat`) streams the answer token-by-token. No API key, no
//! network: you talk to the codebase's own recorded memory (features, policies,
//! change logs, agent activity) entirely on-device.
//!
//! Two model downloads gate the feature: MiniLM (shared with Memory ▸ Graph) for
//! retrieval, and the Qwen GGUF for generation. Both are user-triggered.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use atlas_embed::chat::{build_qwen_prompt, QuantizedChatModel};
use atlas_embed::{BruteForce, VectorStore};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::agent_memory::collect_corpus;
use super::memory_graph::{load_doc_vectors, model_dir, MODEL_FILES};
use super::memory_indexer::MemoryRegistry;

// The local generative model is now user-selectable (Qwen3-family GGUF) via the
// Local Model Manager; paths + downloads resolve through `super::models` keyed on
// the selected `llm_model_id`. All Qwen3 quants run on the Apple-Silicon GPU via
// candle's Metal backend.

/// How many memory docs to retrieve as context, and how much of each to keep.
const TOP_K: usize = 10;
const PER_DOC_CHARS: usize = 1200;
/// Generation cap. Generous on Apple Silicon (Metal); revisit per-device later.
const MAX_TOKENS: usize = 1200;
const TEMPERATURE: f64 = 0.6;
/// Recent commits to fold into the RAG context for git-aware questions.
const GIT_LOG_LIMIT: usize = 20;
const GIT_CONTEXT_MAX_CHARS: usize = 2600;

// ── State ────────────────────────────────────────────────────────────────────

/// Caches the loaded local chat model (loading a GGUF each message would add a
/// multi-second stall) and tracks per-stream cancellation flags. The embedder is
/// NOT cached here — retrieval borrows the single app-wide MiniLM held by
/// [`MemoryRegistry::provider`], so the model is only ever loaded once.
pub struct MemoryChatState {
    chat: Arc<Mutex<Option<QuantizedChatModel>>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl MemoryChatState {
    pub fn new() -> Self {
        Self {
            chat: Arc::new(Mutex::new(None)),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// Shared handle to the cached local chat model, so the codebase indexer can
    /// reuse it for Tier-2 file summaries instead of loading its own.
    pub(crate) fn chat_model(&self) -> Arc<Mutex<Option<QuantizedChatModel>>> {
        self.chat.clone()
    }

    /// Drop the cached local LLM so the next generation reloads. Called when the
    /// user selects a different local LLM.
    pub(crate) fn clear_chat(&self) {
        *self.chat.lock() = None;
    }
}

/// Resolve the **selected** local LLM's gguf + tokenizer paths, erroring if the
/// model isn't present. Shared with the codebase indexer.
pub(crate) fn local_model_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    super::models::selected_llm_paths(app)
}

impl Default for MemoryChatState {
    fn default() -> Self {
        Self::new()
    }
}

/// Dir of the selected local LLM (`app_data/models/<llm_model_id>`).
fn chat_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    super::models::model_dir_for(app, &super::models::selected_llm_id(app))
}

/// Marker written in the selected model's dir when candle's Metal kernels fail to
/// compile on this machine, so subsequent loads skip the (panicking) Metal
/// attempt and go straight to CPU. Per-model: switching models re-tries Metal,
/// deleting the model dir clears it.
fn metal_incompatible_marker(app: &AppHandle) -> Option<PathBuf> {
    chat_model_dir(app).ok().map(|d| d.join(".metal_incompatible"))
}

/// Load the selected local LLM with the Metal→CPU fallback, honouring the
/// persisted "Metal incompatible" marker and writing it the first time a Metal
/// attempt falls back. Returns the loaded model. Blocking — call under
/// `spawn_blocking`. `force_cpu` is derived here from the marker. Shared with the
/// codebase indexer so both users of the cached model get the same resilience.
pub(crate) fn load_chat_model(
    app: &AppHandle,
    gguf_path: &Path,
    tok_path: &Path,
) -> Result<QuantizedChatModel, String> {
    let marker = metal_incompatible_marker(app);
    let force_cpu = marker.as_ref().map(|p| p.exists()).unwrap_or(false);
    let (model, fell_back) = QuantizedChatModel::load_with(gguf_path, tok_path, force_cpu)
        .map_err(|e| format!("load chat model: {e}"))?;
    if fell_back {
        if let Some(p) = &marker {
            let _ = std::fs::write(p, b"metal kernel compile failed; using cpu\n");
        }
    }
    Ok(model)
}

// ── Model download / status ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelStatus {
    pub downloaded: bool,
    pub model: String,
}

#[tauri::command]
pub async fn memory_chat_model_status(app: AppHandle) -> Result<ChatModelStatus, String> {
    let id = super::models::selected_llm_id(&app);
    Ok(ChatModelStatus {
        downloaded: super::models::is_downloaded(&app, &id),
        model: id,
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadDone {
    success: bool,
    error: Option<String>,
}

/// Download the **selected** local LLM in the background. The frontend listens on
/// `atlas:memory-chat-model:progress` / `:done`. The Local Model Manager uses the
/// generic `models::model_download` instead.
#[tauri::command]
pub async fn memory_chat_model_download(app: AppHandle) -> Result<(), String> {
    let id = super::models::selected_llm_id(&app);
    let entry =
        super::models::find_entry(&id).ok_or_else(|| format!("unknown LLM model '{id}'"))?;
    let dir = chat_model_dir(&app)?;
    tokio::spawn(async move {
        let result = super::models::download_files(
            &app,
            &id,
            &dir,
            &entry.files,
            "atlas:memory-chat-model:progress",
        )
        .await;
        let _ = app.emit(
            "atlas:memory-chat-model:done",
            DownloadDone {
                success: result.is_ok(),
                error: result.err(),
            },
        );
        let _ = app.emit("atlas:models-changed", ());
    });
    Ok(())
}

/// Warm-load the downloaded chat model into the cached state. Used by the
/// "Install model" flow to surface a "Loading Model" step (and to make the first
/// message instant). No-op if already loaded; errors if not downloaded.
/// Warm-load the model and return which backend it runs on (`"metal"` / `"cpu"`).
#[tauri::command]
pub async fn memory_chat_model_load(
    app: AppHandle,
    state: State<'_, MemoryChatState>,
) -> Result<String, String> {
    let (gguf_path, tok_path) = local_model_paths(&app)?;
    let chat_arc = state.chat.clone();
    let app_bg = app.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut guard = chat_arc.lock();
        if guard.is_none() {
            let m = load_chat_model(&app_bg, &gguf_path, &tok_path)?;
            *guard = Some(m);
        }
        Ok(guard.as_ref().unwrap().backend().as_str().to_string())
    })
    .await
    .map_err(|e| format!("model load join: {e}"))?
}

/// Backend of the currently cached model, or `None` if not loaded yet. Lets the
/// UI render the Metal/CPU pill without starting a stream.
#[tauri::command]
pub fn memory_chat_backend(state: State<'_, MemoryChatState>) -> Option<String> {
    state
        .chat
        .lock()
        .as_ref()
        .map(|m| m.backend().as_str().to_string())
}

// ── Chat streaming ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WireMsg {
    pub role: String,
    pub content: String,
}

/// Retrieval-time metadata for a corpus document (title/source/path + full text).
struct DocMeta {
    title: String,
    source: String,
    file_path: Option<String>,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceRef {
    id: String,
    title: String,
    source: String,
    score: f32,
    /// Absolute path of the underlying file (memory `.md` or codebase file), so
    /// the UI can open it. `None` for sources with no backing file (e.g. Codex
    /// threads).
    file_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ChatEvent {
    Sources { sources: Vec<SourceRef> },
    Backend { backend: String },
    TextDelta { delta: String },
    Done,
    Error { message: String },
}

#[derive(Serialize, Clone)]
struct ChatEnvelope {
    stream_id: String,
    #[serde(flatten)]
    event: ChatEvent,
}

fn emit(app: &AppHandle, stream_id: &str, event: ChatEvent) {
    let _ = app.emit(
        "atlas:memory-chat",
        ChatEnvelope {
            stream_id: stream_id.to_string(),
            event,
        },
    );
}

const SYSTEM_PREAMBLE: &str = "You are Atlas's memory assistant. Answer the user's question about THIS codebase using only the project memory context provided below. The context contains the project's recorded knowledge: features, policies, change logs, coding-agent activity, and recent git history. Be concise and specific, cite concrete details, and if the context doesn't cover the question say so plainly rather than inventing an answer.";

/// Recent git history as an extra context block — lets the RAG answer questions
/// about commits and (file-level) authorship that the embedded memory docs miss.
fn git_context(project_path: &str) -> String {
    let log = Command::new("git")
        .args([
            "-C",
            project_path,
            "log",
            &format!("-{GIT_LOG_LIMIT}"),
            "--date=short",
            "--pretty=format:commit %h (%ad) by %an: %s",
            "--name-status",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if log.is_empty() {
        return String::new();
    }
    let mut log = log;
    if log.len() > GIT_CONTEXT_MAX_CHARS {
        log.truncate(GIT_CONTEXT_MAX_CHARS);
        log.push('…');
    }
    let branch = Command::new("git")
        .args(["-C", project_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    format!(
        "## Recent git history (current branch: {branch})\nEach entry is a commit and the files it changed (A=added, M=modified, D=deleted, R=renamed).\n{log}\n\n"
    )
}

/// Run one RAG turn: retrieve from the memory index, then stream a local answer.
#[tauri::command]
pub async fn memory_chat_send(
    app: AppHandle,
    stream_id: String,
    project_path: String,
    messages: Vec<WireMsg>,
    state: State<'_, MemoryChatState>,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    let pp = project_path.trim_end_matches('/').to_string();

    let query = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(());
    }

    // Preconditions: both models present, index built.
    let embed_dir = model_dir(&app)?;
    if !MODEL_FILES.iter().all(|f| embed_dir.join(f).exists()) {
        emit(&app, &stream_id, ChatEvent::Error {
            message: "Download the embedding model first (Memory ▸ Graph).".into(),
        });
        return Ok(());
    }
    let (gguf_path, tok_path) = match local_model_paths(&app) {
        Ok(p) => p,
        Err(_) => {
            emit(&app, &stream_id, ChatEvent::Error {
                message: "Download the local chat model first.".into(),
            });
            return Ok(());
        }
    };

    let retrieve_started = std::time::Instant::now();
    let vmap = load_doc_vectors(&pp);
    let corpus_size = vmap.len() as u64;
    if vmap.is_empty() {
        crate::telemetry::retrieval::record(
            &app, "memory_chat", 0, 0, None,
            retrieve_started.elapsed().as_millis() as u64,
            "ui", Some("empty_index"),
        );
        emit(&app, &stream_id, ChatEvent::Error {
            message: "No memory index yet — build it in Memory ▸ Graph first.".into(),
        });
        return Ok(());
    }

    // Corpus (async) holds the document texts keyed by id.
    let corpus = collect_corpus(&pp).await;
    let mut texts: HashMap<String, DocMeta> = HashMap::new();
    for d in &corpus {
        texts.insert(
            d.id.clone(),
            DocMeta {
                title: d.title.clone(),
                source: d.source.clone(),
                file_path: d.file_path.clone(),
                text: d.text.clone(),
            },
        );
    }
    let git_ctx = git_context(&pp);

    // Register a cancellation flag for this stream.
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().insert(stream_id.clone(), cancel.clone());

    // Shared, load-once MiniLM (same instance the indexer / graph / retrieve use).
    let Some(provider) = registry.provider(&app).await else {
        crate::telemetry::retrieval::record(
            &app, "memory_chat", corpus_size, 0, None,
            retrieve_started.elapsed().as_millis() as u64,
            "ui", Some("no_provider"),
        );
        emit(&app, &stream_id, ChatEvent::Error {
            message: "Download the embedding model first (Memory ▸ Graph).".into(),
        });
        return Ok(());
    };
    let embedder = provider.embedder();

    let chat_arc = state.chat.clone();
    let turns: Vec<(String, String)> = messages
        .into_iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| (m.role, m.content))
        .collect();

    let app_bg = app.clone();
    let sid = stream_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        // 1. Embed the query on the shared MiniLM.
        let qv = match embedder.embed_one(&query) {
            Ok(v) => v,
            Err(e) => {
                emit(&app_bg, &sid, ChatEvent::Error { message: format!("embed query: {e}") });
                return;
            }
        };

        // 2. Cosine-search the index.
        let mut ids: Vec<String> = Vec::with_capacity(vmap.len());
        let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(vmap.len());
        for (id, v) in vmap {
            ids.push(id);
            vectors.push(v);
        }
        let store = BruteForce::new(vectors);
        let hits = store.search(&qv, TOP_K);
        crate::telemetry::retrieval::record(
            &app_bg, "memory_chat", corpus_size,
            hits.len() as u64,
            hits.first().map(|(_, s)| *s),
            retrieve_started.elapsed().as_millis() as u64,
            "ui", None,
        );

        // 3. Assemble retrieved context + source list.
        let mut sources: Vec<SourceRef> = Vec::new();
        let mut context = String::new();
        for (i, score) in &hits {
            let id = &ids[*i];
            if let Some(d) = texts.get(id) {
                let mut snippet = d.text.trim().to_string();
                if snippet.len() > PER_DOC_CHARS {
                    snippet.truncate(PER_DOC_CHARS);
                    snippet.push('…');
                }
                context.push_str(&format!("## {} (source: {})\n{snippet}\n\n", d.title, d.source));
                sources.push(SourceRef {
                    id: id.clone(),
                    title: d.title.clone(),
                    source: d.source.clone(),
                    score: *score,
                    file_path: d.file_path.clone(),
                });
            }
        }
        context.push_str(&git_ctx);
        emit(&app_bg, &sid, ChatEvent::Sources { sources });

        // 4. Build the chat prompt and stream the answer.
        let system = format!("{SYSTEM_PREAMBLE}\n\n--- PROJECT MEMORY CONTEXT ---\n{context}");
        let prompt = build_qwen_prompt(&system, &turns);

        let mut guard = chat_arc.lock();
        if guard.is_none() {
            match load_chat_model(&app_bg, &gguf_path, &tok_path) {
                Ok(m) => *guard = Some(m),
                Err(e) => {
                    emit(&app_bg, &sid, ChatEvent::Error { message: e });
                    return;
                }
            }
        }
        let model = guard.as_mut().unwrap();
        emit(&app_bg, &sid, ChatEvent::Backend { backend: model.backend().as_str().to_string() });
        let cancel_chk = cancel.clone();
        let app_tok = app_bg.clone();
        let sid_tok = sid.clone();
        let result = model.generate(
            &prompt,
            MAX_TOKENS,
            TEMPERATURE,
            |delta| emit(&app_tok, &sid_tok, ChatEvent::TextDelta { delta: delta.to_string() }),
            || cancel_chk.load(Ordering::Relaxed),
        );
        match result {
            Ok(_) => emit(&app_bg, &sid, ChatEvent::Done),
            Err(e) => emit(&app_bg, &sid, ChatEvent::Error { message: format!("generate: {e}") }),
        }
    })
    .await;

    state.cancels.lock().remove(&stream_id);
    Ok(())
}

#[tauri::command]
pub fn memory_chat_cancel(stream_id: String, state: State<'_, MemoryChatState>) {
    if let Some(flag) = state.cancels.lock().get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveResult {
    /// The full RAG-augmented user prompt (preamble + retrieved context + question)
    /// to send as the final user turn when generating with a BYOK provider.
    prompt: String,
    sources: Vec<SourceRef>,
}

/// Provider-mode retrieval: embed the query, search the memory index, and return
/// a ready-to-send augmented prompt + the sources. Generation then happens via
/// the existing `modelchat_stream` (BYOK), so no local chat model is required —
/// only the embedding model + a built index.
#[tauri::command]
pub async fn memory_chat_retrieve(
    app: AppHandle,
    project_path: String,
    query: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<RetrieveResult, String> {
    let pp = project_path.trim_end_matches('/').to_string();
    if query.trim().is_empty() {
        return Err("empty query".into());
    }
    let retrieve_started = std::time::Instant::now();

    // Shared, load-once MiniLM (also gates on the model being downloaded).
    let embedder = registry
        .provider(&app)
        .await
        .ok_or("Download the embedding model first (Memory ▸ Graph).")?
        .embedder();
    let vmap = load_doc_vectors(&pp);
    let corpus_size = vmap.len() as u64;
    if vmap.is_empty() {
        crate::telemetry::retrieval::record(
            &app, "memory_chat", 0, 0, None,
            retrieve_started.elapsed().as_millis() as u64,
            "ui", Some("empty_index"),
        );
        return Err("No memory index yet — build it in Memory ▸ Graph first.".into());
    }

    let corpus = collect_corpus(&pp).await;
    let mut texts: HashMap<String, DocMeta> = HashMap::new();
    for d in &corpus {
        texts.insert(
            d.id.clone(),
            DocMeta {
                title: d.title.clone(),
                source: d.source.clone(),
                file_path: d.file_path.clone(),
                text: d.text.clone(),
            },
        );
    }
    let git_ctx = git_context(&pp);

    let q = query.clone();
    let app_bg = app.clone();
    let (context, sources) = tokio::task::spawn_blocking(
        move || -> Result<(String, Vec<SourceRef>), String> {
            let qv = embedder
                .embed_one(&q)
                .map_err(|e| format!("embed query: {e}"))?;
            let mut ids: Vec<String> = Vec::with_capacity(vmap.len());
            let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(vmap.len());
            for (id, v) in vmap {
                ids.push(id);
                vectors.push(v);
            }
            let store = BruteForce::new(vectors);
            let hits = store.search(&qv, TOP_K);
            crate::telemetry::retrieval::record(
                &app_bg, "memory_chat", corpus_size,
                hits.len() as u64,
                hits.first().map(|(_, s)| *s),
                retrieve_started.elapsed().as_millis() as u64,
                "ui", None,
            );
            let mut sources: Vec<SourceRef> = Vec::new();
            let mut context = String::new();
            for (i, score) in &hits {
                let id = &ids[*i];
                if let Some(d) = texts.get(id) {
                    let mut snippet = d.text.trim().to_string();
                    if snippet.len() > PER_DOC_CHARS {
                        snippet.truncate(PER_DOC_CHARS);
                        snippet.push('…');
                    }
                    context.push_str(&format!("## {} (source: {})\n{snippet}\n\n", d.title, d.source));
                    sources.push(SourceRef {
                        id: id.clone(),
                        title: d.title.clone(),
                        source: d.source.clone(),
                        score: *score,
                        file_path: d.file_path.clone(),
                    });
                }
            }
            context.push_str(&git_ctx);
            Ok((context, sources))
        },
    )
    .await
    .map_err(|e| format!("retrieve join: {e}"))??;

    let prompt = format!(
        "{SYSTEM_PREAMBLE}\n\n--- PROJECT MEMORY CONTEXT ---\n{context}\n\n--- QUESTION ---\n{query}"
    );
    Ok(RetrieveResult { prompt, sources })
}
