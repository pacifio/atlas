// How the model picker names and marks a model's provider.
//
// The provider is what the agent STATED — the gateway's `publisher`
// ("anthropic"), or the name of the group an ACP agent listed the model under
// ("Anthropic", "OpenAI"). Nothing here infers a provider from a model id: a
// model whose agent said nothing has no provider, and the picker files it
// under the agent itself (ADR-0002 — what an agent offers is what it sends).
//
// This table only decides how a stated provider READS: its label and its mark.
// An unknown provider still gets a row of its own, labelled as stated, with
// the neutral mark.

/** A provider as the picker shows it. `logo` is a `ProviderLogo` id; `key`
 *  is the rail entry it files under — one per provider, whatever alias the
 *  agent stated it by. */
export interface ProviderDisplay {
  key: string;
  label: string;
  logo: string;
}

const KNOWN: Record<string, Omit<ProviderDisplay, "key">> = {
  anthropic: { label: "Claude", logo: "claude" },
  claude: { label: "Claude", logo: "claude" },
  openai: { label: "OpenAI", logo: "openai" },
  google: { label: "Gemini", logo: "gemini" },
  gemini: { label: "Gemini", logo: "gemini" },
  xai: { label: "Grok", logo: "xai" },
  deepseek: { label: "DeepSeek", logo: "deepseek" },
  mistral: { label: "Mistral", logo: "mistral" },
  mistralai: { label: "Mistral", logo: "mistral" },
  meta: { label: "Llama", logo: "meta" },
  metallama: { label: "Llama", logo: "meta" },
  moonshot: { label: "Kimi", logo: "kimi" },
  moonshotai: { label: "Kimi", logo: "kimi" },
  zai: { label: "GLM", logo: "zhipu" },
  zhipu: { label: "GLM", logo: "zhipu" },
  zhipuai: { label: "GLM", logo: "zhipu" },
  qwen: { label: "Qwen", logo: "qwen" },
  alibaba: { label: "Qwen", logo: "qwen" },
};

/** "x-ai", "X AI" and "xAI" are one provider. */
function normalise(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A stated provider as the picker shows it; `null` when none was stated. */
export function providerDisplay(provider: string | null | undefined): ProviderDisplay | null {
  const stated = provider?.trim();
  if (!stated) return null;
  const key = normalise(stated);
  if (!key) return null;
  // A known provider keys by its mark, so its aliases ("anthropic" from the
  // gateway, "Claude" from an ACP group) share one rail entry.
  const known = KNOWN[key];
  if (known) return { key: known.logo, ...known };
  // As stated — but a bare lowercase id ("cloudflare") reads better titled.
  const label = /^[a-z0-9-]+$/.test(stated)
    ? stated.charAt(0).toUpperCase() + stated.slice(1)
    : stated;
  return { key, label, logo: key };
}
