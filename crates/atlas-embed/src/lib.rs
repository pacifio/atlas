//! `atlas-embed` — on-device text embeddings + a small vector store, isolated
//! in its own crate so the heavy `candle` dependency tree doesn't slow the main
//! app's incremental builds.
//!
//! The embedder loads a sentence-embedding model from a local directory —
//! `config.json`, `tokenizer.json`, `model.safetensors`, and optionally an
//! `atlas-embed.json` [`ModelSpec`] — and produces L2-normalized sentence
//! vectors, so cosine similarity is just a dot product. Three architectures,
//! chosen by `config.json`'s `model_type`: BERT (`all-MiniLM-L6-v2`, memory's
//! model), ModernBERT (Granite Embedding Small R2, the default code model) and
//! NomicBERT (CodeRankEmbed). Texts run as real padded, attention-masked
//! batches; the spec picks the pooling (mean or CLS), the query/document
//! prefixes and the token limit.

mod pool;
mod spec;

pub use spec::{ModelSpec, Pooling, SPEC_FILE};

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{anyhow, Context, Result};
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config as BertConfig, DTYPE};
use candle_transformers::models::modernbert::{Config as ModernConfig, ModernBert};
use candle_transformers::models::nomic_bert::{Config as NomicConfig, NomicBertModel};
use tokenizers::{
    PaddingDirection, PaddingParams, PaddingStrategy, Tokenizer, TruncationDirection,
    TruncationParams, TruncationStrategy,
};

/// Marker file written next to a model when its GPU backend failed on this
/// machine — subsequent loads skip the GPU attempt and go straight to CPU.
/// Per-model-dir, so switching or re-downloading a model retries the GPU.
pub const GPU_INCOMPATIBLE_MARKER: &str = ".metal_incompatible";

/// Longer warm-up text: candle compiles GPU compute pipelines lazily PER
/// KERNEL VARIANT, so warming with a single 1-token forward proved nothing
/// about the kernels a real 300-token document needs — models loaded "fine" on
/// Metal and then died mid-retrieval with "Failed to create pipeline". Warming
/// a short and a long shape catches the incompatibility at load time, where the
/// fallback is clean. (The request-time fallback in `embed_documents` covers
/// whatever this still misses.)
const WARMUP_LONG: &str = "atlas warm-up text exercising the longer attention and pooling kernel \
    shapes that a realistic memory document produces during retrieval indexing \
    so lazy metal pipeline compilation happens here under the load guard and \
    not in the middle of a user visible query answering pass across the app";

/// The network behind an embedder, by `config.json`'s `model_type`.
enum Net {
    Bert(BertModel),
    /// Granite Embedding Small R2, the default code model.
    Modern(ModernBert),
    /// CodeRankEmbed.
    Nomic(NomicBertModel),
}

/// The mutable half of the embedder: swapped wholesale when a GPU backend
/// fails at request time and the model is rebuilt on CPU.
struct EmbedderCore {
    net: Net,
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
    spec: ModelSpec,
    model_type: String,
}

/// The platform's GPU device, per Atlas policy:
/// - macOS → Metal, else CPU (CUDA never applies on Apple Silicon)
/// - Linux/Windows → CUDA, else CPU
///
/// `None` when the platform's GPU feature is off or device init fails (e.g.
/// headless CI). A successful device does NOT guarantee candle's GPU kernels
/// compile/run on this machine — hence the guarded load + request-time
/// fallback.
pub(crate) fn gpu_device() -> Option<Device> {
    #[cfg(test)]
    if let Some(device) = test_seam::fake_gpu_device() {
        return Some(device);
    }
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
    #[cfg(test)]
    if test_seam::fake_gpu() {
        return true;
    }
    cfg!(any(
        all(target_os = "macos", feature = "metal"),
        all(not(target_os = "macos"), feature = "cuda")
    ))
}

/// `config.json`'s `model_type`; a config without one is a BERT checkpoint
/// (the sentence-transformers exports every pre-spec model used).
fn model_type(config: &serde_json::Value) -> String {
    config
        .get("model_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("bert")
        .to_string()
}

/// The output dimension, read the way each architecture names it.
fn hidden_size(config: &serde_json::Value, kind: &str) -> Result<usize> {
    let key = if kind == "nomic_bert" {
        "n_embd"
    } else {
        "hidden_size"
    };
    config
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| anyhow!("config.json has no `{key}` for model_type `{kind}`"))
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
    /// (a short shape, then a padded batch with a long one) so candle's lazy
    /// GPU kernel compilation surfaces here (inside the caller's panic guard)
    /// rather than on the first real embed. Warm-up failures PROPAGATE —
    /// swallowing them was the original bug: a broken-on-GPU embedder got
    /// cached and every later call failed.
    fn load_on(model_dir: &Path, device: Device, on_gpu: bool) -> Result<Self> {
        let config_path = model_dir.join("config.json");
        let tokenizer_path = model_dir.join("tokenizer.json");

        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("read {}", config_path.display()))?;
        let config: serde_json::Value =
            serde_json::from_str(&config_str).context("parse config.json")?;
        let spec = ModelSpec::load(model_dir);
        let kind = model_type(&config);
        let dim = hidden_size(&config, &kind)?;

        let mut tokenizer =
            Tokenizer::from_file(&tokenizer_path).map_err(|e| anyhow!("load tokenizer: {e}"))?;
        // Cap sequence length so long texts don't blow past the model's
        // position-embedding range.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: spec.max_tokens,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| anyhow!("set truncation: {e}"))?;
        // Pad a batch to its longest text, on the right, so the last real
        // token of a row sits at `sum(mask) - 1` (last-token pooling).
        let pad_id = tokenizer.get_padding().map_or(0, |p| p.pad_id);
        let pad_token = tokenizer
            .get_padding()
            .map(|p| p.pad_token.clone())
            .unwrap_or_else(|| PaddingParams::default().pad_token);
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            direction: PaddingDirection::Right,
            pad_id,
            pad_token,
            ..Default::default()
        }));

        let core = Self::build_core(model_dir, &config, &kind, device, on_gpu)?;

        let embedder = Self {
            core: RwLock::new(core),
            tokenizer,
            model_dir: model_dir.to_path_buf(),
            dim,
            spec,
            model_type: kind,
        };
        // Warm-up on two shapes; `?` so a GPU pipeline failure lands in the
        // caller's guarded fallback instead of poisoning the cached embedder.
        embedder.forward_batch(&["warm"])?;
        embedder.forward_batch(&["warm", WARMUP_LONG])?;

        Ok(embedder)
    }

    /// Load the weights onto `device` as the network `kind` names.
    fn build_core(
        model_dir: &Path,
        config: &serde_json::Value,
        kind: &str,
        device: Device,
        on_gpu: bool,
    ) -> Result<EmbedderCore> {
        #[cfg(test)]
        test_seam::fault(on_gpu, test_seam::Fault::PanicInBuild);
        let weights_path = model_dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(std::slice::from_ref(&weights_path), DTYPE, &device)
                .with_context(|| format!("mmap {}", weights_path.display()))?
        };
        let net = match kind {
            "bert" => {
                let c: BertConfig =
                    serde_json::from_value(config.clone()).context("parse BERT config")?;
                Net::Bert(BertModel::load(vb, &c).context("load BERT weights")?)
            }
            "modernbert" => {
                let c: ModernConfig =
                    serde_json::from_value(config.clone()).context("parse ModernBERT config")?;
                // Embedding checkpoints store `layers.*`; candle reads `model.layers.*`.
                let vb = vb.rename_f(|n: &str| n.strip_prefix("model.").unwrap_or(n).to_string());
                Net::Modern(ModernBert::load(vb, &c).context("load ModernBERT weights")?)
            }
            "nomic_bert" => {
                let c: NomicConfig =
                    serde_json::from_value(config.clone()).context("parse NomicBERT config")?;
                Net::Nomic(NomicBertModel::load(vb, &c).context("load NomicBERT weights")?)
            }
            other => anyhow::bail!(
                "unsupported embedding model_type `{other}` (bert, modernbert, nomic_bert)"
            ),
        };
        Ok(EmbedderCore {
            net,
            device,
            on_gpu,
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// How this model is driven (pooling, prefixes, limits).
    pub fn spec(&self) -> &ModelSpec {
        &self.spec
    }

    /// `config.json`'s `model_type` (`bert`, `modernbert`, `nomic_bert`).
    pub fn model_type(&self) -> &str {
        &self.model_type
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

    /// Documents in batches of `spec.batch_size`, with the document prefix.
    /// Returns L2-normalized vectors of length `self.dim`.
    pub fn embed_documents(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let prefixed: Vec<String> = texts
            .iter()
            .map(|t| format!("{}{t}", self.spec.document_prefix))
            .collect();
        let mut out = Vec::with_capacity(texts.len());
        for chunk in prefixed.chunks(self.spec.batch_size.max(1)) {
            let refs: Vec<&str> = chunk.iter().map(String::as_str).collect();
            out.extend(self.forward_with_fallback(&refs)?);
        }
        Ok(out)
    }

    /// A search query, with the query prefix (some models are trained with
    /// an instruction on the query side only).
    pub fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let q = format!("{}{text}", self.spec.query_prefix);
        self.forward_with_fallback(&[q.as_str()])?
            .pop()
            .ok_or_else(|| anyhow!("the model returned no vector"))
    }

    /// Embed a batch of documents (memory's contract: no prefix for a spec
    /// without one, which is every BERT model).
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        self.embed_documents(&refs)
    }

    /// Embed one document.
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        self.embed_documents(&[text])?
            .pop()
            .ok_or_else(|| anyhow!("the model returned no vector"))
    }

    /// One batch, transparently falling back to CPU if the GPU backend fails
    /// at request time (lazy pipeline compilation means a new input shape can
    /// fail long after a clean load — the "Failed to create pipeline" bug).
    /// The rebuilt CPU model replaces the GPU one in place, so the shared
    /// `Arc<Embedder>` every subsystem holds heals for all of them, and the
    /// per-model marker prevents re-poisoning on the next app start.
    fn forward_with_fallback(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        match self.forward_batch(texts) {
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
                self.forward_batch(texts)
            }
        }
    }

    /// One guarded forward pass on whatever device the core currently holds.
    /// Panics inside candle's GPU kernels (metallib mismatches `.unwrap()`
    /// internally) are converted to `Err` so the fallback path sees them too.
    fn forward_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let core = self
            .core
            .read()
            .map_err(|_| anyhow!("embedder core lock poisoned"))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(test)]
            test_seam::fault(core.on_gpu, test_seam::Fault::PanicInForward);
            forward_raw(
                &core.net,
                &core.device,
                &self.tokenizer,
                &self.spec,
                texts,
                self.dim,
            )
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
        let config: serde_json::Value =
            serde_json::from_str(&config_str).context("parse config.json")?;
        *core = Self::build_core(
            &self.model_dir,
            &config,
            &self.model_type,
            Device::Cpu,
            false,
        )?;
        write_gpu_marker(&self.model_dir, "embedder gpu failed at request time");
        Ok(())
    }
}

/// Embed `texts` as one padded, attention-masked batch and pool each row per
/// the spec. Rows are L2-normalized. A batch whose texts all tokenize to
/// nothing comes back as zero vectors.
fn forward_raw(
    net: &Net,
    device: &Device,
    tokenizer: &Tokenizer,
    spec: &ModelSpec,
    texts: &[&str],
    dim: usize,
) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let encs = tokenizer
        .encode_batch(texts.to_vec(), true)
        .map_err(|e| anyhow!("tokenize: {e}"))?;
    let n = encs.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);
    if n == 0 {
        return Ok(vec![vec![0.0; dim]; texts.len()]);
    }
    let ids: Vec<u32> = encs
        .iter()
        .flat_map(|e| e.get_ids().iter().copied())
        .collect();
    let mask: Vec<u32> = encs
        .iter()
        .flat_map(|e| e.get_attention_mask().iter().copied())
        .collect();
    let ids = Tensor::from_vec(ids, (texts.len(), n), device)?;
    let mask = Tensor::from_vec(mask, (texts.len(), n), device)?;
    let hidden = match net {
        Net::Bert(m) => m.forward(&ids, &ids.zeros_like()?, Some(&mask))?,
        Net::Modern(m) => m.forward(&ids, &mask)?,
        Net::Nomic(m) => m.forward(&ids, None, Some(&mask))?,
    };
    let pooled = pool::l2_normalize(&pool::pool(&hidden, &mask, spec.pooling)?)?;
    Ok(pooled.to_dtype(candle_core::DType::F32)?.to_vec2::<f32>()?)
}

/// Best-effort marker write — losing it only costs a retry on next launch.
pub(crate) fn write_gpu_marker(model_dir: &Path, reason: &str) {
    let _ = std::fs::write(
        model_dir.join(GPU_INCOMPATIBLE_MARKER),
        format!("{reason}\n"),
    );
}

/// Test-only stand-in for a GPU, so the load-time and request-time fallbacks
/// can run on a machine (and a build) with no Metal or CUDA.
///
/// With [`FAKE_GPU`](test_seam::FAKE_GPU) set, the build reports a GPU
/// backend and [`gpu_device`] hands back `Device::Cpu` flagged as the GPU,
/// which exercises exactly the code a real GPU would. [`Fault`] then makes
/// the "GPU" core panic where candle's kernels do: while the weights load
/// (the metallib mismatch) or inside a forward pass (lazy pipeline
/// compilation). Every knob is thread-local, so parallel tests cannot see each
/// other's settings; none of it exists outside `cfg(test)`.
#[cfg(test)]
pub(crate) mod test_seam {
    use std::cell::Cell;

    use candle_core::Device;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Fault {
        None,
        PanicInBuild,
        PanicInForward,
    }

    thread_local! {
        pub(crate) static FAKE_GPU: Cell<bool> = const { Cell::new(false) };
        pub(crate) static FAULT: Cell<Fault> = const { Cell::new(Fault::None) };
        /// How many times the load path asked for a GPU device.
        pub(crate) static GPU_ATTEMPTS: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn fake_gpu() -> bool {
        FAKE_GPU.with(Cell::get)
    }

    pub(crate) fn fake_gpu_device() -> Option<Device> {
        if !fake_gpu() {
            return None;
        }
        GPU_ATTEMPTS.with(|n| n.set(n.get() + 1));
        Some(Device::Cpu)
    }

    /// Panic if the core is the (fake) GPU one and `at` is the armed fault.
    pub(crate) fn fault(on_gpu: bool, at: Fault) {
        if on_gpu && FAULT.with(Cell::get) == at {
            panic!("injected GPU kernel panic ({at:?})");
        }
    }
}

#[cfg(test)]
mod tests;

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
