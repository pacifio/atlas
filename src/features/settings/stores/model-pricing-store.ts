//! Model pricing (USD / 1M tokens) sourced from models.dev, cached by Rust.
//!
//! The Rust side refreshes silently on launch (and on demand); this store reads
//! the cache, reloads on the `atlas:models-pricing-updated` event, and exposes
//! a manual `refresh()` for Settings / the model menu. `loading` is true while a
//! manual refresh is in flight (the UI renders "---" then).

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import { fmtCost } from "@/features/monitor/lib/usage-format";

export interface ModelPrice {
  input: number;
  output: number;
  /** Zero when the provider publishes no cache rate — not every one does. */
  cacheRead: number;
  cacheWrite: number;
  /** What models.dev states it can do; false or 0 when it doesn't say. */
  reasoning?: boolean;
  images?: boolean;
  /** Context window in tokens. */
  context?: number;
}

export type ModelPriceOverrides = Record<
  string,
  Pick<ModelPrice, "input" | "output" | "cacheRead" | "cacheWrite">
>;

interface ModelPricingState {
  catalog: Record<string, ModelPrice>;
  overrides: ModelPriceOverrides;
  prices: Record<string, ModelPrice>;
  loaded: boolean;
  loading: boolean;
  actions: {
    setOverrides: (overrides: ModelPriceOverrides) => void;
    load: () => Promise<void>;
    refresh: () => Promise<void>;
  };
}

let listenerBound = false;

const base = create<ModelPricingState>((set, get) => ({
  catalog: {},
  overrides: {},
  prices: {},
  loaded: false,
  loading: false,
  actions: {
    setOverrides: (overrides) =>
      set({ overrides, prices: applyPriceOverrides(get().catalog, overrides) }),
    load: async () => {
      // Bind the update listener once so a background/foreground refresh on the
      // Rust side reloads the cache here automatically.
      if (!listenerBound) {
        listenerBound = true;
        void listen("atlas:models-pricing-updated", () => void get().actions.load());
      }
      try {
        const prices = await invoke<Record<string, ModelPrice>>("models_pricing_get");
        set({
          catalog: prices,
          prices: applyPriceOverrides(prices, get().overrides),
          loaded: true,
        });
      } catch {
        set({ loaded: true });
      }
    },
    refresh: async () => {
      set({ loading: true });
      try {
        await invoke("models_pricing_refresh");
        const prices = await invoke<Record<string, ModelPrice>>("models_pricing_get");
        set({
          catalog: prices,
          prices: applyPriceOverrides(prices, get().overrides),
          loaded: true,
        });
      } catch {
        // best-effort — keep whatever's cached
      } finally {
        set({ loading: false });
      }
    },
  },
}));

export const useModelPricingStore = createSelectors(base);

/** Mirrors Rust's apply_price_overrides: overrides win before catalog lookup. */
export function applyPriceOverrides(
  catalog: Record<string, ModelPrice>,
  overrides: ModelPriceOverrides,
): Record<string, ModelPrice> {
  return Object.fromEntries([
    ...Object.entries(catalog).map(([model, price]) => [
      model,
      { ...price, ...priceForModel(overrides, model) },
    ]),
    ...Object.entries(overrides).map(([model, override]) => [
      model,
      { ...priceForModel(catalog, model), ...override },
    ]),
  ]);
}

/** Look up a model's price, trying `provider/model` then the bare model id. */
export function priceFor(
  prices: Record<string, ModelPrice>,
  provider: string,
  model: string,
): ModelPrice | null {
  return prices[`${provider}/${model}`] ?? priceForModel(prices, model);
}

/**
 * Look up a price from a recorded model id alone, with no provider to help.
 *
 * Mirrors the Rust `price_for` (`src-tauri/src/commands/usage.rs`).
 * Atlas records context-window variants as
 * `claude-opus-5[1m]`, and the bracket has to come off before the id matches
 * anything models.dev publishes.
 *
 * A miss returns null rather than a guess. A session then shows its tokens
 * with no cost, which is the honest reading of "we do not know this model".
 */
export function priceForModel(
  prices: Record<string, ModelPrice>,
  model: string | null | undefined,
): ModelPrice | null {
  const raw = model?.trim();
  if (!raw) return null;
  for (const key of candidateKeys(raw)) {
    const price = Object.prototype.hasOwnProperty.call(prices, key) ? prices[key] : null;
    if (price) return price;
  }
  return null;
}

/** `anthropic/claude-opus-5[1m]-20250514` → every id that might be the key. */
function candidateKeys(model: string): string[] {
  const keys = new Set<string>();
  const add = (id: string) => {
    keys.add(id);
    // A provider prefix, then a dated release — `claude-opus-4-20250514` is
    // the same model models.dev lists as `claude-opus-4`.
    const bare = id.slice(id.lastIndexOf("/") + 1);
    keys.add(bare);
    keys.add(bare.replace(/-\d{8}$/, ""));
  };
  add(model);
  add(model.replace(/\[.*?\]/g, ""));
  return Array.from(keys);
}

/** Tokens a session spent, by class — the shape [[costOf]] prices. */
export interface TokenSpend {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * What those tokens cost, in USD.
 *
 * The frontend mirror of Rust's `cost_usd`, and it has to price all four
 * classes for the same reason: a Claude Code session is ~99.5% cache traffic,
 * so charging input and output alone reports approximately nothing.
 */
export function costOf(spend: TokenSpend, price: ModelPrice | null): number | null {
  if (!price) return null;
  return (
    (spend.input * price.input +
      spend.output * price.output +
      spend.cacheWrite * price.cacheWrite +
      spend.cacheRead * price.cacheRead) /
    1_000_000
  );
}

/** Compact display: `$3 / $15` (input / output per 1M tokens). */
export function formatPrice(p: ModelPrice | null, loading: boolean): string {
  if (loading || !p) return "---";
  const fmt = (n: number) => fmtCost(n, "USD", Number.isInteger(n) ? 0 : 2);
  return `${fmt(p.input)} / ${fmt(p.output)}`;
}
