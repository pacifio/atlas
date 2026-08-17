// Turn an agent's "I have no credentials" error into something Atlas can FIX
// IN-APP: the BYOK provider whose key it is missing.
//
// Why this exists: most registry agents authenticate only by reading a provider
// key from their environment, and they say so in the error — `gemini` answers
// "Gemini API key is missing or not configured", `qwen-code` answers "requires
// setting the `OPENAI_API_KEY` environment variable". The old response was to
// tell the user to go export a variable in a terminal. Atlas already owns a
// keychain-backed BYOK store and already injects those keys into every agent's
// spawn env, so the whole round trip belongs inside the app: name the provider,
// take the key, respawn.
//
// Pure and table-driven so the matching is testable without a live agent.

/** A BYOK provider Atlas can collect a key for, with the labels the prompt
 *  needs and the strings that identify it in an agent's error text. */
interface ProviderNeed {
  /** BYOK provider id — the key `byok.set` stores under. */
  provider: string;
  label: string;
  /** Where the user gets a key. Shown as text, not a link to click away to. */
  consoleHint: string;
  /** Env var names the agent might name. Matched case-insensitively. */
  envVars: string[];
  /** Looser prose fragments ("gemini api key"), matched case-insensitively.
   *  Kept narrow enough that a generic "api key" alone never matches — that
   *  would attribute a key to the wrong provider. */
  phrases: string[];
}

/** Ordered most-specific first: `GOOGLE_GENERATIVE_AI_API_KEY` must not be
 *  claimed by a substring match on a shorter var from another provider. */
const NEEDS: ProviderNeed[] = [
  {
    provider: "google",
    label: "Google Gemini",
    consoleHint: "aistudio.google.com/apikey",
    envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    phrases: ["gemini api key", "google api key"],
  },
  {
    provider: "openai",
    label: "OpenAI",
    consoleHint: "platform.openai.com/api-keys",
    envVars: ["OPENAI_API_KEY", "OPENAI_KEY"],
    phrases: ["openai api key"],
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    consoleHint: "console.anthropic.com/settings/keys",
    envVars: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    phrases: ["anthropic api key", "claude api key"],
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    consoleHint: "openrouter.ai/keys",
    envVars: ["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"],
    phrases: ["openrouter api key"],
  },
  {
    provider: "xai",
    label: "xAI",
    consoleHint: "console.x.ai",
    envVars: ["XAI_API_KEY", "GROK_API_KEY"],
    phrases: ["xai api key", "grok api key"],
  },
  {
    provider: "mistral",
    label: "Mistral",
    consoleHint: "console.mistral.ai/api-keys",
    envVars: ["MISTRAL_API_KEY"],
    phrases: ["mistral api key"],
  },
  {
    provider: "groq",
    label: "Groq",
    consoleHint: "console.groq.com/keys",
    envVars: ["GROQ_API_KEY"],
    phrases: ["groq api key"],
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    consoleHint: "platform.deepseek.com/api_keys",
    envVars: ["DEEPSEEK_API_KEY"],
    phrases: ["deepseek api key"],
  },
];

export interface AgentKeyNeed {
  provider: string;
  label: string;
  consoleHint: string;
  /** The env var the agent named, when it named one — worth showing so the
   *  user can see Atlas understood the actual request. */
  envVar: string | null;
}

/**
 * Which provider key an agent is asking for, or `null` when its message names
 * none — in which case there is nothing for Atlas to collect and the caller
 * must fall back to the agent's own auth methods.
 *
 * Matches an explicitly named env var first (unambiguous, and it lets Atlas
 * echo the exact var back), then the looser prose forms.
 */
export function detectKeyNeed(message: string): AgentKeyNeed | null {
  const m = message.toLowerCase();
  for (const need of NEEDS) {
    const envVar = need.envVars.find((v) => m.includes(v.toLowerCase()));
    if (envVar) {
      return { provider: need.provider, label: need.label, consoleHint: need.consoleHint, envVar };
    }
  }
  for (const need of NEEDS) {
    if (need.phrases.some((p) => m.includes(p))) {
      return {
        provider: need.provider,
        label: need.label,
        consoleHint: need.consoleHint,
        envVar: null,
      };
    }
  }
  return null;
}
