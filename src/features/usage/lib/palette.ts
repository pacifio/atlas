/**
 * The Usage tab's series palette, from the active theme.
 *
 * Every colour here is handed to a `style` prop as a VALUE — the glyph chart's
 * stacked segments, the inline bars in the top list and the tables — so none
 * of it can be a `var(--…)` and all of it is resolved (decision 14).
 *
 * The palette is the theme's `chart-1..5`, which is exactly what those five
 * shadcn base tokens are for: a theme author picks five colours that read as a
 * set against their own background, and every chart in Atlas follows. This
 * file used to hold ten hand-picked greys chosen for one AMOLED-black theme;
 * on Rosé Pine Dawn they were invisible.
 *
 * Five tokens, more series than that: `seriesColor` cycles them and pulls each
 * further lap toward the background or the foreground — alternating which,
 * lap over lap — so an eleventh project is still separable without inventing
 * an eleventh token (decision 18 — role tokens only). Alternating the target
 * instead of just deepening the same fade means two laps can share a fade
 * *amount* without sharing a resolved colour, so the cycle doesn't visibly
 * repeat until far past any table Atlas renders.
 *
 * Read it through `useSeriesPalette()`. The hook subscribes to
 * `atlas:theme-applied`, so a chart repaints on a theme switch; the
 * module-level constants this replaced could not.
 */
import { useMemo } from "react";
import {
  modelVendorColor,
  modelVendorOf,
  type ModelVendor,
} from "@/features/agents/lib/agent-brand";
import { NATIVE_AGENT_ID } from "@/types/agent";
import { themeBase, themeColor, useThemeVersion } from "@/features/theme/theme-values";
import { mix, withAlpha } from "@tryatlas/design/theme";

/** The five series tokens, in the order a theme author sees them. */
const SERIES_TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

/** How far each extra pair of laps pulls the base colour toward its target. */
const PASS_FADE = 0.22;
/** Cap on that pull — short of the target colour, so a series is never lost. */
const MAX_PASS_FADE = 0.55;

export interface SeriesPalette {
  /** Stable colour for the nth series, cycling `chart-1..5`. */
  seriesColor: (index: number) => string;
  /** The tint the "Other" bucket draws in — quieter than any named series. */
  otherColor: string;
}

function buildSeriesPalette(): SeriesPalette {
  const background = themeBase("background");
  const foreground = themeBase("foreground");
  const series = SERIES_TOKENS.map((token) => themeBase(token));

  return {
    seriesColor: (index) => {
      const color = series[index % series.length];
      const lap = Math.floor(index / series.length);
      if (lap === 0) return color;
      // Odd laps darken toward the background, even laps lighten toward the
      // foreground; `pass` only advances every two laps, so consecutive laps
      // land on opposite sides of the base colour instead of the same fade
      // getting deeper each time. Two laps land on the same `amount` well
      // before they land on the same resolved colour.
      const pass = Math.ceil(lap / 2);
      const amount = Math.min(pass * PASS_FADE, MAX_PASS_FADE);
      const target = lap % 2 === 1 ? background : foreground;
      return mix(color, target, amount);
    },
    // "Other" is the bucket the reader is meant to look past, which is the
    // same instruction `text.disabled` carries everywhere else.
    otherColor: themeColor("text.disabled"),
  };
}

export function useSeriesPalette(): SeriesPalette {
  // `version` is the whole dependency: it changes on `atlas:theme-applied` and
  // on nothing else, which is exactly when the resolved values move.
  const version = useThemeVersion();
  return useMemo(buildSeriesPalette, [version]);
}

// ── Identity tints ─────────────────────────────────────────────────────────

/**
 * The colours a model or agent chip wears in the tables, keyed by the family
 * it belongs to.
 *
 * A grey chip per row told you a model existed and nothing else; with a tint
 * you can see at a glance that a window was mostly Claude, or that one project
 * is the only thing still on a local model. Families, not individual models —
 * a colour per model id would be a new hue every release.
 *
 * The hue is the vendor's own, from `agents/lib/agent-brand.ts`, so the chip
 * carries the colour that vendor already has everywhere else in the app rather
 * than a fourth palette invented for this table. It is deliberately NOT a theme
 * key: a theme that could restate Anthropic's terracotta would be a theme lying
 * about someone else's brand (the 2026-09-18 audit that cut the eighteen
 * `agent.*` keys to two). The fill is the same hue at a tenth, which is what
 * the old `--agent-*-chip-bg` pairs were.
 *
 * The fallback, for a model nobody recognises, is the one pair that IS
 * themeable: `agent.chip.background` — the app's own "identity chip with no
 * identity" fill, and what `.amark` draws — under `muted-foreground`. Quiet on
 * purpose, so an unrecognised model does not end up the loudest thing in the
 * table.
 */
export interface Tint {
  fg: string;
  bg: string;
}

/** The same question for an agent id. The native agent is Atlas itself, so it
 *  wears the app's own identity chip (the neutral pair below) rather than a
 *  vendor's hue — the same choice `agent-brand.ts` makes for it. */
function agentVendor(agent: string): ModelVendor | null {
  const a = agent.toLowerCase();
  if (a === NATIVE_AGENT_ID) return null;
  if (a.includes("claude")) return "claude";
  if (a.includes("codex")) return "codex";
  if (a.includes("cursor")) return "cursor";
  if (a.includes("kilo")) return "kilo";
  return null;
}

export interface IdentityTints {
  /** The tint a model id wears. Falls back to neutral rather than guessing. */
  modelTint: (model: string) => Tint;
  /** The tint an agent wears in a table cell, by the same families. */
  agentTint: (agent: string) => Tint;
}

/**
 * Read once per table, not once per row: the neutral pair is resolved from the
 * theme, and resolving it is a `getComputedStyle` read that a virtualised list
 * would otherwise repeat for every visible cell.
 */
export function useIdentityTints(): IdentityTints {
  const version = useThemeVersion();
  return useMemo(() => {
    const neutral: Tint = {
      fg: themeBase("muted-foreground"),
      bg: themeColor("agent.chip.background"),
    };
    const tintOf = (vendor: ModelVendor | null): Tint => {
      if (vendor === null) return neutral;
      const hue = modelVendorColor(vendor);
      return { fg: hue, bg: withAlpha(hue, 0.1) };
    };
    return {
      modelTint: (model) => tintOf(modelVendorOf(model)),
      agentTint: (agent) => tintOf(agentVendor(agent)),
    };
    // `version` is the dependency for the same reason as above: the neutral
    // pair moves on a theme switch and the brand hues never do.
  }, [version]);
}
