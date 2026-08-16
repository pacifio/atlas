// BYOK provider-key store. Holds only NON-secret metadata (which providers are
// configured + last-4 + when). The raw keys never enter this store — they live
// in the OS keychain and are fetched on demand via `byok.get` by consumers that
// need to inject them (see Rust `byok.rs`).

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { byok, type EnvKeyMeta, type ProviderKeyMeta } from "../lib/byok-api";

interface ByokState {
  /** provider id → metadata, for configured providers only. */
  keys: Record<string, ProviderKeyMeta>;
  /** provider id → key imported from the user's environment. Env keys WIN
   *  over stored keys when both exist (the table flags the conflict). */
  envKeys: Record<string, EnvKeyMeta>;
  loaded: boolean;
  /** provider id currently being saved/deleted (for inline busy state). */
  pending: string | null;
  actions: {
    load: () => Promise<void>;
    save: (provider: string, key: string) => Promise<void>;
    remove: (provider: string) => Promise<void>;
  };
}

export const useByokStore = createSelectors(
  create<ByokState>((set) => ({
    keys: {},
    envKeys: {},
    loaded: false,
    pending: null,
    actions: {
      load: async () => {
        try {
          const list = await byok.list();
          const keys: Record<string, ProviderKeyMeta> = {};
          for (const m of list) keys[m.provider] = m;
          set({ keys, loaded: true });
        } catch (err) {
          console.error("byok.load failed", err);
          set({ loaded: true });
        }
        // Separately and best-effort: the env probe can take a few seconds on
        // first call (login shell), so it must never gate the stored list.
        try {
          const envList = await byok.envList();
          const envKeys: Record<string, EnvKeyMeta> = {};
          for (const m of envList) envKeys[m.provider] = m;
          set({ envKeys });
        } catch (err) {
          console.error("byok.envList failed", err);
        }
      },

      save: async (provider, key) => {
        const trimmed = key.trim();
        if (!trimmed) return;
        set({ pending: provider });
        try {
          await byok.set(provider, trimmed);
          set((s) => ({
            keys: {
              ...s.keys,
              [provider]: {
                provider,
                last4: trimmed.slice(-4),
                addedAt: new Date().toISOString(),
              },
            },
          }));
        } catch (err) {
          console.error("byok.save failed", err);
          throw err;
        } finally {
          set({ pending: null });
        }
      },

      remove: async (provider) => {
        set({ pending: provider });
        try {
          await byok.delete(provider);
          set((s) => {
            const next = { ...s.keys };
            delete next[provider];
            return { keys: next };
          });
        } catch (err) {
          console.error("byok.remove failed", err);
          throw err;
        } finally {
          set({ pending: null });
        }
      },
    },
  })),
);
