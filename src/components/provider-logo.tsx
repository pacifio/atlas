import type { ComponentType, CSSProperties } from "react";
import { Boxes } from "lucide-react";
import { cn } from "@/lib/utils";

// Real brand logos from @lobehub/icons. We DEEP-import only the `Color`/`Mono`
// variant components — importing the package's named index (e.g. `OpenAI`)
// eagerly pulls in its `.Avatar` member, which drags `@lobehub/ui` (antd +
// emotion) into the bundle. The Color/Mono files are plain SVGs with no deps.
//
// Color where the brand ships a colored glyph; otherwise the monochrome glyph
// (renders in `currentColor`, which suits Atlas's monochromatic palette).
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import Google from "@lobehub/icons/es/Google/components/Color";
import Mistral from "@lobehub/icons/es/Mistral/components/Color";
import Cohere from "@lobehub/icons/es/Cohere/components/Color";
import XAI from "@lobehub/icons/es/XAI/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color";
import Ai21 from "@lobehub/icons/es/Ai21/components/Mono";
import Groq from "@lobehub/icons/es/Groq/components/Mono";
import Together from "@lobehub/icons/es/Together/components/Color";
import Fireworks from "@lobehub/icons/es/Fireworks/components/Color";
import DeepInfra from "@lobehub/icons/es/DeepInfra/components/Color";
import Cerebras from "@lobehub/icons/es/Cerebras/components/Color";
import Replicate from "@lobehub/icons/es/Replicate/components/Mono";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Color";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Mono";
import Azure from "@lobehub/icons/es/Azure/components/Color";
import Voyage from "@lobehub/icons/es/Voyage/components/Color";
import HuggingFace from "@lobehub/icons/es/HuggingFace/components/Color";
import Jina from "@lobehub/icons/es/Jina/components/Mono";
import ElevenLabs from "@lobehub/icons/es/ElevenLabs/components/Mono";

type IconComp = ComponentType<{
  size?: number;
  style?: CSSProperties;
  className?: string;
}>;

// Keyed by the BYOK provider id (see features/settings/lib/providers.ts).
const LOGOS: Record<string, IconComp> = {
  openai: OpenAI,
  anthropic: Anthropic,
  google: Google,
  mistral: Mistral,
  cohere: Cohere,
  xai: XAI,
  deepseek: DeepSeek,
  ai21: Ai21,
  groq: Groq,
  together: Together,
  fireworks: Fireworks,
  deepinfra: DeepInfra,
  cerebras: Cerebras,
  replicate: Replicate,
  perplexity: Perplexity,
  openrouter: OpenRouter,
  azure: Azure,
  voyage: Voyage,
  huggingface: HuggingFace,
  jina: Jina,
  elevenlabs: ElevenLabs,
};

export function hasProviderLogo(id: string): boolean {
  return id in LOGOS;
}

/**
 * Renders a provider's brand logo by BYOK id, centered in a fixed box so rows
 * align. Falls back to a neutral lucide glyph for providers without a brand
 * icon (e.g. LiteLLM). Reusable anywhere a provider needs an avatar.
 */
export function ProviderLogo({
  id,
  size = 18,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const Icon = LOGOS[id];
  const box = size + 6;
  return (
    <span
      className={cn("grid place-items-center shrink-0 text-text-secondary", className)}
      style={{ width: box, height: box }}
    >
      {Icon ? <Icon size={size} /> : <Boxes size={Math.round(size * 0.8)} aria-hidden />}
    </span>
  );
}
