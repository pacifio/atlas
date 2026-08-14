//! `atlas-embed` — on-device text embeddings + a small vector store, isolated
//! in its own crate so the heavy `candle` dependency tree doesn't slow the main
//! app's incremental builds.
//!
//! The embedder loads a BERT-style sentence-transformer (default target:
//! `all-MiniLM-L6-v2`, 384-dim) from a local directory of three files —
//! `config.json`, `tokenizer.json`, `model.safetensors` — and produces
//! L2-normalized mean-pooled sentence vectors. Because vectors are unit-length,
//! cosine similarity is just a dot product.
//!
//! The crate also hosts a small generative counterpart in [`chat`]: a quantized
//! Qwen2.5-Instruct decoder for local RAG answers, sharing the same candle stack.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub mod chat;

use anyhow::{anyhow, Context, Result};
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

/// BERT position embeddings cap; MiniLM/BERT support up to 512 tokens.
const MAX_TOKENS: usize = 512;

/// Marker file written next to a model when its GPU backend failed on this
/// machine — subsequent loads skip the GPU attempt and go straight to CPU.
/// Same name/convention as the chat model's marker (`memory_chat.rs` reads it
/// for the LLM); per-model-dir, so switching or re-downloading a model retries.
pub const GPU_INCOMPATIBLE_MARKER: &str = ".metal_incompatible";

/// Longer warm-up text: candle compiles GPU compute pipelines lazily PER
/// KERNEL VARIANT, so warming with a single 1-token forward proved nothing
/// about the kernels a real 300-token document needs — models loaded "fine" on
/// Metal and then died mid-retrieval with "Failed to create pipeline". Warming
/// a short and a long shape catches the incompatibility at load time, where the
/// fallback is clean. (The request-time fallback in `embed_one` covers whatever
/// this still misses.)
const WARMUP_LONG: &str = "atlas warm-up text exercising the longer attention and pooling kernel \
    shapes that a realistic memory document produces during retrieval indexing \
    so lazy metal pipeline compilation happens here under the load guard and \
    not in the middle of a user visible query answering pass across the app";

/// The mutable half of the embedder: swapped wholesale when a GPU backend
/// fails at request time and the model is rebuilt on CPU.
struct EmbedderCore {
    model: BertModel,
    device: Device,
    /// True when `device` is a GPU (Metal/CUDA) — drives the fallback decision
    /// without matching on cfg-dependent `Device` variants.
    on_gpu: bool,
}

/// A loaded sentence-embedding model. Prefers the platform GPU (macOS: Metal
/// via the `metal` feature; Linux/Windows: CUDA via the `cuda` feature),
/// falling back to CPU both at load time AND at request time: candle compiles
/// GPU compute pipelines lazily per kernel variant, so a device that loaded
/// and warmed up fine can still fail on a new shape mid-session ("Metal error
/// Failed to create pipeline"). When that happens the model is rebuilt on CPU
/// in place, a per-model marker skips the GPU on future loads, and the request
/// is retried — callers never see the transient.
pub struct Embedder {
    core: RwLock<EmbedderCore>,
    tokenizer: Tokenizer,
    model_dir: PathBuf,
    dim: usize,
}

/// The platform's GPU device, per Atlas policy:
/// - macOS → Metal, else CPU (CUDA never applies on Apple Silicon)
/// - Linux/Windows → CUDA, else CPU
///
/// `None` when the platform's GPU feature is off or device init fails (e.g.
/// headless CI). A successful device does NOT guarantee candle's GPU kernels
/// compile/run on this machine — hence the guarded load + request-time
/// fallback. Shared with `chat`.
pub(crate) fn gpu_device() -> Option<Device> {
    #[cfg(all(target_os = "macos", feature = "metal"))]
    {
        match Device::new_metal(0) {
            Ok(d) => return Some(d),
            Err(e) => eprintln!("atlas-embed: Metal init failed ({e}); using CPU"),
        }
    }
    #[cfg(all(not(target_os = "macos"), feature = "cuda"))]
    {
        match Device::new_cuda(0) {
            Ok(d) => return Some(d),
            Err(e) => eprintln!("atlas-embed: CUDA init failed ({e}); using CPU"),
        }
    }
    None
}

/// Whether the platform-appropriate GPU backend is compiled into this build.
pub(crate) fn gpu_compiled() -> bool {
    cfg!(any(
        all(target_os = "macos", feature = "metal"),
        all(not(target_os = "macos"), feature = "cuda")
    ))
}

impl Embedder {
    /// Load from a directory containing `config.json`, `tokenizer.json` and
    /// `model.safetensors`, preferring the platform GPU but resiliently falling
    /// back to CPU.
    ///
    /// Candle can panic OR return `Err` while compiling its GPU kernels (an
    /// OS/toolchain metallib mismatch panics; a pipeline-creation failure is a
    /// plain `Err`). The GPU path is `catch_unwind`-guarded with warm-up
    /// forwards inside `load_on` — and BOTH failure modes retry on CPU.
    /// `ATLAS_EMBED_CPU=1` or a persisted [`GPU_INCOMPATIBLE_MARKER`] in the
    /// model dir skips the GPU attempt entirely.
    pub fn load(model_dir: &Path) -> Result<Self> {
        let force_cpu = std::env::var_os("ATLAS_EMBED_CPU").is_some()
            || model_dir.join(GPU_INCOMPATIBLE_MARKER).exists();

        if gpu_compiled() && !force_cpu {
            if let Some(dev) = gpu_device() {
                let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Self::load_on(model_dir, dev, true)
                }));
                match attempt {
                    Ok(Ok(model)) => return Ok(model),
                    Ok(Err(e)) => eprintln!(
                        "atlas-embed: GPU embedder load failed ({e}); falling back to CPU"
                    ),
                    Err(_) => eprintln!(
                        "atlas-embed: GPU embedder kernels failed to compile \
                         (candle/OS mismatch); falling back to CPU"
                    ),
                }
                // A load-time GPU failure is deterministic on this machine —
                // persist it so future loads skip the doomed attempt.
                write_gpu_marker(model_dir, "embedder load failed on gpu");
                return Self::load_on(model_dir, Device::Cpu, false);
            }
        }

        Self::load_on(model_dir, Device::Cpu, false)
    }

    /// Build the embedder on an explicit device, ending with warm-up forwards
    /// (short + long shape) so candle's lazy GPU kernel compilation surfaces
    /// here (inside the caller's panic guard) rather than on the first real
    /// embed. Warm-up failures PROPAGATE — swallowing them was the original
    /// bug: a broken-on-GPU embedder got cached and every later call failed.
    fn load_on(model_dir: &Path, device: Device, on_gpu: bool) -> Result<Self> {
        let config_path = model_dir.join("config.json");
        let tokenizer_path = model_dir.join("tokenizer.json");

        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("read {}", config_path.display()))?;
        let config: Config = serde_json::from_str(&config_str).context("parse config.json")?;
        let dim = config.hidden_size;

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| anyhow!("load tokenizer: {e}"))?;
        // Cap sequence length so long memory bodies don't blow past the model's
        // position-embedding range.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| anyhow!("set truncation: {e}"))?;

        let core = Self::build_core(model_dir, &config, device, on_gpu)?;

        let embedder = Self {
            core: RwLock::new(core),
            tokenizer,
            model_dir: model_dir.to_path_buf(),
            dim,
        };
        // Warm-up on two shapes; `?` so a GPU pipeline failure lands in the
        // caller's guarded fallback instead of poisoning the cached embedder.
        embedder.forward_current("warm")?;
        embedder.forward_current(WARMUP_LONG)?;

        Ok(embedder)
    }

    /// Load the BERT weights onto `device`.
    fn build_core(
        model_dir: &Path,
        config: &Config,
        device: Device,
        on_gpu: bool,
    ) -> Result<EmbedderCore> {
        let weights_path = model_dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path.clone()], DTYPE, &device)
                .with_context(|| format!("mmap {}", weights_path.display()))?
        };
        let model = BertModel::load(vb, config).context("load BERT weights")?;
        Ok(EmbedderCore {
            model,
            device,
            on_gpu,
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// The compute backend currently in use ("gpu" covers Metal/CUDA — the
    /// distinction is the platform's build-time feature).
    pub fn backend(&self) -> &'static str {
        if self.core.read().map(|c| c.on_gpu).unwrap_or(false) {
            "gpu"
        } else {
            "cpu"
        }
    }

    /// Embed a batch of texts, one forward pass each (no padding needed).
    /// Returns L2-normalized vectors of length `self.dim`.
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        texts.iter().map(|t| self.embed_one(t)).collect()
    }

    /// Embed one text, transparently falling back to CPU if the GPU backend
    /// fails at request time (lazy pipeline compilation means a new input shape
    /// can fail long after a clean load — the "Failed to create pipeline" bug).
    /// The rebuilt CPU model replaces the GPU one in place, so the shared
    /// `Arc<Embedder>` every memory subsystem holds heals for all of them, and
    /// the per-model marker prevents re-poisoning on the next app start.
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        match self.forward_current(text) {
            Ok(v) => Ok(v),
            Err(e) => {
                let on_gpu = self.core.read().map(|c| c.on_gpu).unwrap_or(false);
                if !on_gpu {
                    return Err(e);
                }
                eprintln!(
                    "atlas-embed: GPU embed failed at request time ({e}); \
                     rebuilding on CPU and retrying"
                );
                self.rebuild_on_cpu()?;
                self.forward_current(text)
            }
        }
    }

    /// One guarded forward pass on whatever device the core currently holds.
    /// Panics inside candle's GPU kernels (metallib mismatches `.unwrap()`
    /// internally) are converted to `Err` so the fallback path sees them too.
    fn forward_current(&self, text: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow!("tokenize: {e}"))?;
        let ids = encoding.get_ids().to_vec();
        if ids.is_empty() {
            return Ok(vec![0.0; self.dim]);
        }
        let core = self
            .core
            .read()
            .map_err(|_| anyhow!("embedder core lock poisoned"))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Self::forward_raw(&core.model, &core.device, &ids)
        }))
        .unwrap_or_else(|_| Err(anyhow!("embedding kernel panicked on {}", self.backend())))
    }

    /// Replace the core with a CPU build and persist the incompatibility
    /// marker. Idempotent under races: if another thread already swapped to
    /// CPU, this is a no-op.
    fn rebuild_on_cpu(&self) -> Result<()> {
        let mut core = self
            .core
            .write()
            .map_err(|_| anyhow!("embedder core lock poisoned"))?;
        if !core.on_gpu {
            return Ok(()); // another caller already healed it
        }
        let config_str = std::fs::read_to_string(self.model_dir.join("config.json"))
            .context("re-read config.json for CPU fallback")?;
        let config: Config = serde_json::from_str(&config_str).context("parse config.json")?;
        *core = Self::build_core(&self.model_dir, &config, Device::Cpu, false)?;
        write_gpu_marker(&self.model_dir, "embedder gpu failed at request time");
        Ok(())
    }

    fn forward_raw(model: &BertModel, device: &Device, ids: &[u32]) -> Result<Vec<f32>> {
        let input_ids = Tensor::new(ids, device)?.unsqueeze(0)?; // [1, n]
        let token_type_ids = input_ids.zeros_like()?;
        let attention_mask = Tensor::ones_like(&input_ids)?;

        // [1, n, hidden]
        let ys = model.forward(&input_ids, &token_type_ids, Some(&attention_mask))?;

        // Mean-pool over the token dimension → [1, hidden].
        let (_b, n_tokens, _h) = ys.dims3()?;
        let summed = ys.sum(1)?;
        let mean = (summed / n_tokens as f64)?;

        // L2-normalize so cosine == dot.
        let norm = mean.sqr()?.sum_keepdim(1)?.sqrt()?;
        let normed = mean.broadcast_div(&norm)?;

        Ok(normed.squeeze(0)?.to_vec1::<f32>()?)
    }
}

/// Best-effort marker write — losing it only costs a retry on next launch.
pub(crate) fn write_gpu_marker(model_dir: &Path, reason: &str) {
    let _ = std::fs::write(
        model_dir.join(GPU_INCOMPATIBLE_MARKER),
        format!("{reason}\n"),
    );
}

// ── Vector store ────────────────────────────────────────────────────────────

/// Cosine similarity of two unit vectors == dot product.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Pluggable nearest-neighbor backend. `BruteForce` is exact and ideal at the
/// memory-corpus scale (dozens–hundreds of vectors); a DiskANN-backed impl can
/// drop in behind this trait later for large corpora.
pub trait VectorStore {
    /// Top-`k` (index, score) pairs for `query`, best first.
    fn search(&self, query: &[f32], k: usize) -> Vec<(usize, f32)>;
}

/// Exact O(n) cosine search over in-memory unit vectors.
pub struct BruteForce {
    vectors: Vec<Vec<f32>>,
}

impl BruteForce {
    pub fn new(vectors: Vec<Vec<f32>>) -> Self {
        Self { vectors }
    }

    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }

    /// For each vector, its top-`k` neighbors (excluding itself). Used to build
    /// the similarity graph edges.
    pub fn all_pairs_topk(&self, k: usize) -> Vec<Vec<(usize, f32)>> {
        (0..self.vectors.len())
            .map(|i| {
                let mut scored: Vec<(usize, f32)> = self
                    .vectors
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| *j != i)
                    .map(|(j, v)| (j, cosine(&self.vectors[i], v)))
                    .collect();
                scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                scored.truncate(k);
                scored
            })
            .collect()
    }
}

impl VectorStore for BruteForce {
    fn search(&self, query: &[f32], k: usize) -> Vec<(usize, f32)> {
        let mut scored: Vec<(usize, f32)> = self
            .vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (i, cosine(query, v)))
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(k);
        scored
    }
}
