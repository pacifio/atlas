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

export interface ModelPrice {
  input: number;
  output: number;
}

interface ModelPricingState {
  prices: Record<string, ModelPrice>;
  loaded: boolean;
  loading: boolean;
  actions: {
    load: () => Promise<void>;
    refresh: () => Promise<void>;
  };
}

let listenerBound = false;

const base = create<ModelPricingState>((set, get) => ({
  prices: {},
  loaded: false,
  loading: false,
  actions: {
    load: async () => {
      // Bind the update listener once so a background/foreground refresh on the
      // Rust side reloads the cache here automatically.
      if (!listenerBound) {
        listenerBound = true;
        void listen(
          "atlas:models-pricing-updated",
          () => void get().actions.load(),
        );
      }
      try {
        const prices =
          await invoke<Record<string, ModelPrice>>("models_pricing_get");
        set({ prices, loaded: true });
      } catch {
        set({ loaded: true });
      }
    },
    refresh: async () => {
      set({ loading: true });
      try {
        await invoke("models_pricing_refresh");
        const prices =
          await invoke<Record<string, ModelPrice>>("models_pricing_get");
        set({ prices, loaded: true });
      } catch {
        // best-effort — keep whatever's cached
      } finally {
        set({ loading: false });
      }
    },
  },
}));

export const useModelPricingStore = createSelectors(base);

/** Look up a model's price, trying `provider/model` then the bare model id. */
export function priceFor(
  prices: Record<string, ModelPrice>,
  provider: string,
  model: string,
): ModelPrice | null {
  return prices[`${provider}/${model}`] ?? prices[model] ?? null;
}

/** Compact display: `$3 / $15` (input / output per 1M tokens). */
export function formatPrice(p: ModelPrice | null, loading: boolean): string {
  if (loading || !p) return "---";
  const fmt = (n: number) =>
    Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
  return `${fmt(p.input)} / ${fmt(p.output)}`;
}
