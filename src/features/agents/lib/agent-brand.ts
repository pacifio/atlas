/**
 * The first-party agents' own brand hues.
 *
 * NOT theme keys, deliberately. There used to be eighteen — `agent.claude.*`,
 * `agent.gpt.*`, `agent.gemini.*`, `agent.amp.*` and so on — and eight of them
 * named agents that do not exist in Atlas, while three more were overridden by
 * hardcoded CSS before they ever rendered. Two things make the whole family
 * wrong as a theme surface:
 *
 *  - **ADR-0002.** No agent gets special treatment. A theme file that can name
 *    Claude and Cursor but not the agent you installed this morning is a list
 *    of favourites.
 *  - **The set is discovered at runtime.** An author cannot enumerate what they
 *    are theming, so the keys could never be complete.
 *
 * What is left is `agent.chip.foreground` / `agent.chip.background`: one
 * neutral pair the chip falls back to, which is what lets a monochrome theme
 * (Atlas Mono, Vesper) flatten every identity to its own palette. These
 * constants are the vendors' marks — a third party's colour, not Atlas's, and
 * not something a theme should be able to restate.
 */
import type { FirstPartyAgent } from "@/types/agent";

/**
 * Brand colour per first-party identity, or `null` where the mark carries its
 * own colours (Atlas's native agent draws `AtlasIcon`) and the glyph must not
 * be tinted at all.
 */
const CLAUDE = "#c98263";
const CODEX = "#10a37f";
const OPENCODE = "#9ca3af";
const CURSOR = "#d9b56e";
const KILO = "#f0c53d";

/**
 * Two more vendors that ship MODELS but no Atlas agent, so they have no entry
 * in `BRAND` above and nothing else in the app would name them. Same argument
 * as the rest of this file: Google's blue and the open-weights lilac are not
 * Atlas's colours to restate, which is why they are constants here rather than
 * theme keys. The lilac stands for the whole local/open-weights family — Llama,
 * Mistral, Qwen, DeepSeek, Phi, Gemma — which has no single vendor to borrow a
 * mark from, so it is the one hue here Atlas did choose.
 */
const GEMINI = "#7aa7e8";
const LOCAL = "#b8a3df";

const BRAND: Record<FirstPartyAgent, string | null> = {
  "claude-code": CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
  cursor: CURSOR,
  kilo: KILO,
  "atlas-agent": null,
};

/**
 * The same hues, keyed by the family a MODEL belongs to rather than by agent
 * id. A model chip and its vendor's agent mark read the same colour because
 * they are the same constant — a second table would drift the first time one
 * of them was touched.
 */
const MODEL_VENDOR = {
  claude: CLAUDE,
  codex: CODEX,
  gemini: GEMINI,
  local: LOCAL,
  cursor: CURSOR,
  kilo: KILO,
} as const;

export type ModelVendor = keyof typeof MODEL_VENDOR;

/** The brand hue for a model family. Total — the caller classifies first. */
export function modelVendorColor(vendor: ModelVendor): string {
  return MODEL_VENDOR[vendor];
}

/**
 * Which family a model id belongs to, or `null` for one we cannot place. Used
 * by the usage tables' tints and by `ModelVendorMark` / `ModelChip`, so a model
 * reads the same vendor everywhere it appears.
 */
export function modelVendorOf(model: string): ModelVendor | null {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return "claude";
  if (/gpt|codex|\bo[134]\b/.test(m)) return "codex";
  if (/gemini|palm/.test(m)) return "gemini";
  if (/llama|mistral|qwen|deepseek|phi|gemma/.test(m)) return "local";
  if (/cursor/.test(m)) return "cursor";
  if (/kilo/.test(m)) return "kilo";
  return null;
}

/**
 * The tint for an agent's brand mark, or `undefined` to leave it inheriting
 * the surrounding colour — which is also what an external agent gets, since
 * its icon comes from its own manifest SVG.
 */
export function agentBrandColor(id: string): string | undefined {
  for (const [agent, color] of Object.entries(BRAND)) {
    if (color && id.includes(agent === "claude-code" ? "claude" : agent)) return color;
  }
  return undefined;
}
