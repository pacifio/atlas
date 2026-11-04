import type { ComponentType, CSSProperties } from "react";
import { Boxes } from "lucide-react";
import {
  AI21Mark,
  AnthropicMark,
  AzureMark,
  CerebrasMark,
  ClaudeMark,
  CohereMark,
  DeepInfraMark,
  DeepSeekMark,
  ElevenLabsMark,
  FireworksMark,
  GeminiMark,
  GoogleMark,
  GroqMark,
  HuggingFaceMark,
  JinaMark,
  KimiMark,
  MetaMark,
  MistralMark,
  OpenAIMark,
  OpenRouterMark,
  PerplexityMark,
  QwenMark,
  ReplicateMark,
  TogetherMark,
  VoyageMark,
  XAIMark,
  ZhipuMark,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import orcaLogo from "@/assets/orcarouter.png";

// Provider marks come from `@tryatlas/design` (Lobe Icons' paths, MIT; see the
// package's THIRD_PARTY_NOTICES.md). Colour where the brand ships a coloured
// glyph, otherwise `currentColor`, which suits Atlas's monochromatic palette.
// OrcaRouter stays a local PNG: there is no vector source or licence for it.

type IconComp = ComponentType<{ width?: number; height?: number; className?: string }>;

function OrcaRouterLogo({
  width = 18,
  height = 18,
  className,
  style,
}: {
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      src={orcaLogo}
      alt=""
      aria-hidden="true"
      width={width}
      height={height}
      className={cn("object-contain select-none pointer-events-none", className)}
      style={{ width, height, ...style }}
    />
  );
}

// Keyed by the BYOK provider id (see features/settings/lib/providers.ts).
const LOGOS: Record<string, IconComp> = {
  openai: OpenAIMark,
  anthropic: AnthropicMark,
  google: GoogleMark,
  mistral: MistralMark,
  cohere: CohereMark,
  xai: XAIMark,
  deepseek: DeepSeekMark,
  ai21: AI21Mark,
  groq: GroqMark,
  together: TogetherMark,
  fireworks: FireworksMark,
  deepinfra: DeepInfraMark,
  cerebras: CerebrasMark,
  replicate: ReplicateMark,
  perplexity: PerplexityMark,
  openrouter: OpenRouterMark,
  azure: AzureMark,
  voyage: VoyageMark,
  huggingface: HuggingFaceMark,
  jina: JinaMark,
  elevenlabs: ElevenLabsMark,
  orcarouter: OrcaRouterLogo,
  // Model families rather than BYOK providers — the composer's model picker
  // groups by these (see `features/chat/lib/model-provider.ts`), and a family
  // reads by its model's mark: Claude's spark, not Anthropic's wordmark.
  claude: ClaudeMark,
  gemini: GeminiMark,
  qwen: QwenMark,
  kimi: KimiMark,
  meta: MetaMark,
  zhipu: ZhipuMark,
};

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
      className={cn("grid place-items-center shrink-0 text-secondary-foreground", className)}
      style={{ width: box, height: box }}
    >
      {Icon ? (
        <Icon width={size} height={size} />
      ) : (
        <Boxes size={Math.round(size * 0.8)} aria-hidden />
      )}
    </span>
  );
}
