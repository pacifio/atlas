// Provider catalog for BYOK (bring-your-own-key). Single-API-key providers
// supported by the Vercel AI SDK and/or LiteLLM. Multi-credential providers
// (AWS Bedrock, Google Vertex) are intentionally omitted — they need more than
// one field and don't fit the single masked-key UX.
//
// `id` doubles as the keychain account name (see Rust `byok.rs`) and must stay
// stable. `env` is the conventional environment variable a consumer injects.

export type ProviderCategory = "Frontier" | "Inference" | "Gateway" | "Embeddings";

export interface ProviderDef {
  id: string;
  name: string;
  /** Conventional env var name for this provider's key. */
  env: string;
  category: ProviderCategory;
  /** Where the user gets the key. */
  docsUrl?: string;
  /** Hint for the key's typical prefix, shown as placeholder. */
  placeholder?: string;
  /**
   * Chat-capable — shows up in the Model-Chat picker. How the provider is
   * actually called (api kind + base URL) lives in Rust
   * (`commands/modelchat.rs::provider_endpoint`), the single source of truth;
   * the frontend only needs this flag.
   */
  chat?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  // ── Frontier labs ────────────────────────────────────────────────
  {
    id: "openai",
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    category: "Frontier",
    docsUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-...",
    chat: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    category: "Frontier",
    docsUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-...",
    chat: true,
  },
  {
    id: "google",
    name: "Google Gemini",
    env: "GOOGLE_GENERATIVE_AI_API_KEY",
    category: "Frontier",
    docsUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza...",
    chat: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    env: "MISTRAL_API_KEY",
    category: "Frontier",
    docsUrl: "https://console.mistral.ai/api-keys",
    chat: true,
  },
  {
    id: "cohere",
    name: "Cohere",
    env: "COHERE_API_KEY",
    category: "Frontier",
    docsUrl: "https://dashboard.cohere.com/api-keys",
    chat: true,
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    env: "XAI_API_KEY",
    category: "Frontier",
    docsUrl: "https://console.x.ai",
    placeholder: "xai-...",
    chat: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    category: "Frontier",
    docsUrl: "https://platform.deepseek.com/api_keys",
    chat: true,
  },
  {
    id: "ai21",
    name: "AI21 Labs",
    env: "AI21_API_KEY",
    category: "Frontier",
    docsUrl: "https://studio.ai21.com/account/api-key",
  },

  // ── Inference / hosting ──────────────────────────────────────────
  {
    id: "groq",
    name: "Groq",
    env: "GROQ_API_KEY",
    category: "Inference",
    docsUrl: "https://console.groq.com/keys",
    placeholder: "gsk_...",
    chat: true,
  },
  {
    id: "together",
    name: "Together AI",
    env: "TOGETHER_API_KEY",
    category: "Inference",
    docsUrl: "https://api.together.xyz/settings/api-keys",
    chat: true,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    env: "FIREWORKS_API_KEY",
    category: "Inference",
    docsUrl: "https://fireworks.ai/account/api-keys",
    chat: true,
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    env: "DEEPINFRA_API_KEY",
    category: "Inference",
    docsUrl: "https://deepinfra.com/dash/api_keys",
    chat: true,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    env: "CEREBRAS_API_KEY",
    category: "Inference",
    docsUrl: "https://cloud.cerebras.ai",
    chat: true,
  },
  {
    id: "replicate",
    name: "Replicate",
    env: "REPLICATE_API_TOKEN",
    category: "Inference",
    docsUrl: "https://replicate.com/account/api-tokens",
    placeholder: "r8_...",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    env: "PERPLEXITY_API_KEY",
    category: "Inference",
    docsUrl: "https://www.perplexity.ai/settings/api",
    placeholder: "pplx-...",
    chat: true,
  },

  // ── Gateways / proxies ───────────────────────────────────────────
  {
    id: "openrouter",
    name: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    category: "Gateway",
    docsUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-...",
    chat: true,
  },
  {
    id: "litellm",
    name: "LiteLLM Proxy",
    env: "LITELLM_API_KEY",
    category: "Gateway",
    docsUrl: "https://docs.litellm.ai/docs/proxy/virtual_keys",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    env: "AZURE_API_KEY",
    category: "Gateway",
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/quickstart",
  },

  // ── Embeddings & audio ───────────────────────────────────────────
  {
    id: "voyage",
    name: "Voyage AI",
    env: "VOYAGE_API_KEY",
    category: "Embeddings",
    docsUrl: "https://dashboard.voyageai.com/api-keys",
    placeholder: "pa-...",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    env: "HF_TOKEN",
    category: "Embeddings",
    docsUrl: "https://huggingface.co/settings/tokens",
    placeholder: "hf_...",
  },
  {
    id: "jina",
    name: "Jina AI",
    env: "JINA_API_KEY",
    category: "Embeddings",
    docsUrl: "https://jina.ai/api-dashboard",
    placeholder: "jina_...",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    env: "ELEVENLABS_API_KEY",
    category: "Embeddings",
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
];

export const PROVIDER_CATEGORIES: ProviderCategory[] = [
  "Frontier",
  "Inference",
  "Gateway",
  "Embeddings",
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Providers that support the Model-Chat panel. */
export const CHAT_PROVIDERS: ProviderDef[] = PROVIDERS.filter((p) => !!p.chat);
