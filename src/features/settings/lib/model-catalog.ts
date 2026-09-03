// Curated coding-model catalog for BYOK model pickers.
//
// Picking a model for a coding task means we don't dump every model a
// provider's `/models` endpoint returns (embeddings, TTS, image, etc.).
// Instead we keep a per-provider preference list of strong coding models —
// these rank first and double as the offline fallback when the live list is
// unavailable — then append any other genuinely coding-capable live models,
// capped.
//
// This also fixes a class of 404s: model selection is now per-provider, so a
// model id chosen for one provider can never leak into a request to another
// (e.g. an Anthropic id sent to Google's endpoint).

/** Best-first preferred coding models per provider. Also the offline fallback. */
const PREFERRED: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-4-1", "claude-sonnet-4-5"],
  openai: ["gpt-5.1", "gpt-5", "o4-mini", "gpt-4.1", "gpt-4o"],
  google: ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  xai: ["grok-4", "grok-code-fast-1", "grok-3"],
  deepseek: ["deepseek-reasoner", "deepseek-chat"],
  mistral: ["mistral-large-latest", "codestral-latest"],
  groq: ["moonshotai/kimi-k2-instruct", "qwen-3-coder-480b", "llama-3.3-70b-versatile"],
  together: [
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "deepseek-ai/DeepSeek-V3",
    "moonshotai/Kimi-K2-Instruct",
  ],
  fireworks: ["accounts/fireworks/models/qwen3-coder-480b-a35b-instruct"],
  deepinfra: ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "deepseek-ai/DeepSeek-V3"],
  cerebras: ["qwen-3-coder-480b", "llama-3.3-70b"],
  openrouter: ["anthropic/claude-sonnet-4.6", "google/gemini-3.1-pro", "qwen/qwen3-coder"],
  perplexity: ["sonar-reasoning-pro", "sonar-pro"],
  cohere: ["command-a-03-2025"],
  empero: ["glm-5.3-flash"],
};

const MAX_MODELS = 18;

/** Substrings that mark a model as NOT a chat/coding model — filtered out. */
const NON_CODING = [
  "embed",
  "embedding",
  "tts",
  "whisper",
  "transcribe",
  "audio",
  "speech",
  "image",
  "dall-e",
  "dalle",
  "vision-only",
  "rerank",
  "moderation",
  "guard",
  "ocr",
  "imagen",
  "veo",
  "stable-diffusion",
];

/** Whether `id` looks like a usable text/coding model (vs an embedding/TTS/etc.). */
function isCodingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CODING.some((bad) => lower.includes(bad));
}

/**
 * Build the model list to offer for `provider`. `liveIds` is the (possibly
 * empty) result of the provider's `/models` call. Preferred coding models that
 * are actually available come first; other coding-capable live models follow;
 * the whole thing is capped. Falls back to the preferred list when no live
 * data is available.
 */
export function curateModels(provider: string, liveIds: string[]): string[] {
  const preferred = PREFERRED[provider] ?? [];

  if (liveIds.length === 0) {
    return preferred.length > 0 ? preferred : [];
  }

  const liveSet = new Set(liveIds);
  const seen = new Set<string>();
  const out: string[] = [];

  // 1. Preferred models that the provider actually offers.
  for (const id of preferred) {
    if (liveSet.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  // 2. Other coding-capable live models.
  for (const id of liveIds) {
    if (!seen.has(id) && isCodingModel(id)) {
      seen.add(id);
      out.push(id);
    }
  }

  // 3. If nothing survived (id drift between preferred + live), still show the
  //    preferred list so the picker isn't empty.
  if (out.length === 0) return preferred;

  return out.slice(0, MAX_MODELS);
}

/** Best-first preferred (coding-friendly) models for `provider`. These are the
 *  ones pinned + starred at the top of a model picker. */
export function preferredModels(provider: string): string[] {
  return PREFERRED[provider] ?? [];
}

/** Whether `id` is one of `provider`'s preferred coding-friendly models. */
export function isPreferredModel(provider: string, id: string): boolean {
  return (PREFERRED[provider] ?? []).includes(id);
}

/** The default model to select for a provider given its curated list. */
export function defaultModelFor(provider: string, curated: string[]): string | null {
  const preferred = PREFERRED[provider] ?? [];
  // Prefer the first available preferred model, else the first curated one.
  const firstPreferred = preferred.find((id) => curated.includes(id));
  return firstPreferred ?? curated[0] ?? preferred[0] ?? null;
}
