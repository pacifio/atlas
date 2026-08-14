//! `chat` — a small on-device quantized instruct model for local RAG answers.
//!
//! Sibling to the BERT `Embedder`: same candle stack, but a generative decoder
//! instead of an encoder. Loads a GGUF Qwen3 checkpoint + its `tokenizer.json`,
//! then streams tokens for a fully-formatted prompt. Runs on the Apple-Silicon
//! GPU via candle's Metal backend when the `metal` feature is compiled in
//! (`src-tauri` enables it for macOS), falling back to CPU otherwise — a 0.6B
//! model at Q4 answers a short RAG query in a second or two, which is the point:
//! no API key, no network, the codebase's own memory answered locally.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::quantized_qwen3::ModelWeights;
use tokenizers::Tokenizer;

use crate::write_gpu_marker;

/// Qwen3 ChatML control tokens. Generation stops at either.
const STOP_TOKENS: [&str; 2] = ["<|im_end|>", "<|endoftext|>"];

/// Which compute backend the loaded model actually runs on. Surfaced to the UI
/// so it can show a "Metal" vs "CPU" pill.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatBackend {
    /// Apple-Silicon GPU via candle's Metal backend.
    Metal,
    /// CPU — either no GPU, forced off, or Metal kernel-compile fell back.
    Cpu,
}

impl ChatBackend {
    /// Stable lowercase tag for IPC (`"metal"` / `"cpu"`).
    pub fn as_str(self) -> &'static str {
        match self {
            ChatBackend::Metal => "metal",
            ChatBackend::Cpu => "cpu",
        }
    }
}

pub struct QuantizedChatModel {
    model: ModelWeights,
    tokenizer: Tokenizer,
    device: Device,
    stop_ids: Vec<u32>,
    backend: ChatBackend,
    /// Retained so a request-time GPU failure can rebuild on CPU in place.
    gguf_path: PathBuf,
    tokenizer_path: PathBuf,
}

impl QuantizedChatModel {
    /// Load a GGUF checkpoint + its tokenizer, preferring the Apple-Silicon GPU
    /// but resiliently falling back to CPU. `gguf_path` is a quantized Qwen3
    /// file; `tokenizer_path` the matching `tokenizer.json`.
    ///
    /// The Metal path is panic-guarded: candle compiles its quantized-matmul
    /// Metal kernels lazily and `.unwrap()`s the result *inside*
    /// `candle-metal-kernels`, so an OS/toolchain metallib mismatch (the "AIR
    /// builtin ... no definition was found" CompilerError) panics rather than
    /// returning an `Err`. We catch that panic (and any `Err`), then retry on
    /// CPU — the 0.6B Q4 model is perfectly usable there.
    ///
    /// Set `force_cpu` (e.g. from a persisted "Metal incompatible" marker or the
    /// `ATLAS_EMBED_CPU` env var) to skip the Metal attempt entirely. Returns the
    /// model plus `fell_back = true` when a Metal attempt was tried and failed,
    /// so the caller can persist that decision.
    pub fn load(gguf_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        Self::load_with(gguf_path, tokenizer_path, false).map(|(m, _)| m)
    }

    /// Like [`load`] but exposes the force-CPU switch and whether a Metal attempt
    /// fell back. `force_cpu` OR the `ATLAS_EMBED_CPU` env var skips Metal.
    pub fn load_with(
        gguf_path: &Path,
        tokenizer_path: &Path,
        force_cpu: bool,
    ) -> Result<(Self, bool)> {
        let env_cpu = std::env::var_os("ATLAS_EMBED_CPU").is_some();

        if crate::gpu_compiled() && !force_cpu && !env_cpu {
            // Platform GPU policy (crate::gpu_device): macOS → Metal else CPU;
            // Linux/Windows → CUDA else CPU.
            if let Some(dev) = crate::gpu_device() {
                // candle's kernel-compile panic lives inside catch_unwind;
                // AssertUnwindSafe because candle types aren't UnwindSafe.
                let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Self::load_on(gguf_path, tokenizer_path, dev, ChatBackend::Metal)
                }));
                match attempt {
                    Ok(Ok(model)) => return Ok((model, false)),
                    Ok(Err(e)) => eprintln!(
                        "atlas-embed: GPU chat-model load failed ({e}); falling back to CPU"
                    ),
                    Err(_) => eprintln!(
                        "atlas-embed: GPU chat-model kernels failed to compile \
                         (candle/OS metallib mismatch); falling back to CPU"
                    ),
                }
                // Reached only on GPU failure: retry on CPU, flagged as fallback.
                let model =
                    Self::load_on(gguf_path, tokenizer_path, Device::Cpu, ChatBackend::Cpu)?;
                return Ok((model, true));
            }
        }

        let model = Self::load_on(gguf_path, tokenizer_path, Device::Cpu, ChatBackend::Cpu)?;
        Ok((model, false))
    }

    /// Build the model on an explicit device. Ends with a one-token warm-up
    /// forward so candle's lazy Metal kernel compilation surfaces here (inside
    /// the caller's panic guard) rather than mid-generation.
    fn load_on(
        gguf_path: &Path,
        tokenizer_path: &Path,
        device: Device,
        backend: ChatBackend,
    ) -> Result<Self> {
        let mut file = std::fs::File::open(gguf_path)
            .with_context(|| format!("open {}", gguf_path.display()))?;
        let content = gguf_file::Content::read(&mut file)
            .map_err(|e| anyhow!("read gguf header: {e}"))?;
        let mut model = ModelWeights::from_gguf(content, &mut file, &device)
            .map_err(|e| anyhow!("load gguf weights: {e}"))?;

        // Warm-up: force any lazily-compiled matmul kernels to build now.
        let warm = Tensor::new(&[0u32], &device)?.unsqueeze(0)?;
        let _ = model.forward(&warm, 0)?;
        model.clear_kv_cache();

        let tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| anyhow!("load tokenizer: {e}"))?;

        let stop_ids = STOP_TOKENS
            .iter()
            .filter_map(|t| tokenizer.token_to_id(t))
            .collect::<Vec<_>>();

        Ok(Self {
            model,
            tokenizer,
            device,
            stop_ids,
            backend,
            gguf_path: gguf_path.to_path_buf(),
            tokenizer_path: tokenizer_path.to_path_buf(),
        })
    }

    /// The compute backend this model is actually running on.
    pub fn backend(&self) -> ChatBackend {
        self.backend
    }

    /// Stream a completion for an already chat-templated `prompt`. `on_token` is
    /// called with each decoded text delta; `should_stop` is polled to support
    /// cooperative cancellation. Returns the full generated text.
    ///
    /// Resilient to request-time GPU failures: candle compiles Metal compute
    /// pipelines lazily per kernel variant, so a model that loaded and warmed up
    /// cleanly can still fail ("Metal error Failed to create pipeline") on a new
    /// shape mid-generation. On a GPU error OR panic this rebuilds the model on
    /// CPU in place, persists the per-model incompatibility marker (so the next
    /// load skips the GPU), and — if no tokens were streamed yet — transparently
    /// retries. If tokens were already streamed, it returns a clear error asking
    /// for a resend rather than duplicating the partial answer.
    ///
    /// Blocking + CPU-heavy — run under `spawn_blocking`.
    pub fn generate<F, S>(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        temperature: f64,
        mut on_token: F,
        should_stop: S,
    ) -> Result<String>
    where
        F: FnMut(&str),
        S: Fn() -> bool,
    {
        let mut emitted = false;
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.generate_inner(
                prompt,
                max_tokens,
                temperature,
                &mut |s| {
                    emitted = true;
                    on_token(s);
                },
                &should_stop,
            )
        }));
        let err = match attempt {
            Ok(Ok(text)) => return Ok(text),
            Ok(Err(e)) => e,
            Err(_) => anyhow!("generation kernel panicked on {}", self.backend.as_str()),
        };
        if self.backend != ChatBackend::Metal {
            return Err(err);
        }

        eprintln!("atlas-embed: GPU generation failed at request time ({err}); rebuilding on CPU");
        if let Some(dir) = self.gguf_path.parent() {
            write_gpu_marker(dir, "chat model gpu failed at request time");
        }
        *self = Self::load_on(
            &self.gguf_path.clone(),
            &self.tokenizer_path.clone(),
            Device::Cpu,
            ChatBackend::Cpu,
        )?;

        if emitted {
            // Part of the answer already streamed to the UI — a silent retry
            // would duplicate it. Fail loud once; the model is on CPU now.
            return Err(anyhow!(
                "the local model's GPU backend failed mid-answer; switched to CPU — please resend"
            ));
        }
        self.generate_inner(prompt, max_tokens, temperature, &mut on_token, &should_stop)
    }

    fn generate_inner(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        temperature: f64,
        on_token: &mut dyn FnMut(&str),
        should_stop: &dyn Fn() -> bool,
    ) -> Result<String> {
        let encoding = self
            .tokenizer
            .encode(prompt, true)
            .map_err(|e| anyhow!("encode prompt: {e}"))?;
        let prompt_ids = encoding.get_ids().to_vec();
        if prompt_ids.is_empty() {
            return Ok(String::new());
        }

        let mut sampler = LogitsProcessor::new(42, Some(temperature), Some(0.9));

        // The model is cached across turns and Qwen3's ConcatKvCache *appends*
        // every forward (it is NOT reset by offset==0). Clear it before each turn
        // so the new prompt's kv length matches the freshly-built causal mask —
        // otherwise the second message fails with a broadcast_add shape mismatch.
        self.model.clear_kv_cache();

        // Prompt pass: offset 0 starts a fresh sequence on the cleared cache.
        let input = Tensor::new(prompt_ids.as_slice(), &self.device)?.unsqueeze(0)?;
        let mut logits = self.model.forward(&input, 0)?.squeeze(0)?;
        let mut pos = prompt_ids.len();

        let mut generated: Vec<u32> = Vec::new();
        // Decode the whole generated run each step and emit the new suffix — robust
        // to multi-byte tokens that a per-token decode would split.
        let mut prev = String::new();

        for _ in 0..max_tokens {
            if should_stop() {
                break;
            }
            let next = sampler.sample(&logits)?;
            if self.stop_ids.contains(&next) {
                break;
            }
            generated.push(next);

            let decoded = self.tokenizer.decode(&generated, true).unwrap_or_default();
            // Defensive: suppress any reasoning the model emits. The prompt already
            // pre-closes an empty <think> block (non-thinking mode), but if a quant
            // ignores that, strip <think>…</think> so reasoning never reaches the UI.
            let visible = strip_think(&decoded);
            if visible.len() > prev.len() && visible.starts_with(&prev) {
                on_token(&visible[prev.len()..]);
            }
            prev = visible;

            let input = Tensor::new(&[next], &self.device)?.unsqueeze(0)?;
            logits = self.model.forward(&input, pos)?.squeeze(0)?;
            pos += 1;
        }

        Ok(prev)
    }
}

/// Remove `<think>…</think>` reasoning from generated text. Complete blocks are
/// dropped entirely; an unclosed trailing `<think>` suppresses everything from it
/// onward (so partial reasoning is never streamed). Leading whitespace left by a
/// removed block is trimmed so the visible answer starts clean.
fn strip_think(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        match rest.find("<think>") {
            Some(start) => {
                out.push_str(&rest[..start]);
                let after = &rest[start + "<think>".len()..];
                match after.find("</think>") {
                    Some(end) => rest = &after[end + "</think>".len()..],
                    None => break, // unclosed — drop the rest
                }
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    out.trim_start().to_string()
}

/// Build a Qwen3 ChatML prompt from a system message + alternating user/assistant
/// turns. The final turn must be a user message.
///
/// Qwen3 is a hybrid reasoning model; for fast RAG we want **non-thinking** mode.
/// Rather than let it emit a `<think>…</think>` block (which would have to be
/// streamed then stripped), we PRE-FILL an empty, already-closed think block after
/// the assistant tag — exactly what Qwen3's `enable_thinking=false` template does —
/// so generation starts directly at the answer.
pub fn build_qwen_prompt(system: &str, turns: &[(String, String)]) -> String {
    let mut out = String::new();
    out.push_str("<|im_start|>system\n");
    out.push_str(system);
    out.push_str("\n<|im_end|>\n");
    for (role, content) in turns {
        out.push_str("<|im_start|>");
        out.push_str(role);
        out.push('\n');
        out.push_str(content);
        out.push_str("\n<|im_end|>\n");
    }
    out.push_str("<|im_start|>assistant\n<think>\n\n</think>\n\n");
    out
}
