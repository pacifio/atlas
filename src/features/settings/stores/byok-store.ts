// BYOK store — a mirror of the user's shell environment, not a vault.
//
// Atlas stores no keys (see Rust `byok.rs`). `keys` is derived from the
// environment and answers one question for the rest of the app: which providers
// are usable right now. Consumers only ever test membership, so the shape stayed
// `Record<provider, …>` when the source moved from a private JSON store to the
// shell profile.
//
// `entries` is the richer per-variable view the Settings editor renders (file,
// line, editable). Only `last4` is ever held here — full values are fetched one
// at a time via `byok.reveal`.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import { byok, type EnvEntry, type EnvKeyMeta, type ProfileInfo } from "../lib/byok-api";

// The env probe is two-phase in Rust: the process env answers instantly, the
// login-shell pass lands seconds later and fires this event. It also fires after
// every edit. Refetch so pills and rows stay live without a manual reload.
// Module-level once-guard — the store is a singleton, the listener should be too.
let envListenerArmed = false;
function armEnvUpdateListener(refetch: () => void): void {
  if (envListenerArmed) return;
  envListenerArmed = true;
  void listen("atlas:byok-env-updated", refetch).catch(() => {
    envListenerArmed = false; // not in a Tauri context (tests) — retry later
  });
}

interface ByokState {
  /** provider id → env key. Membership = "this provider is usable". */
  keys: Record<string, EnvKeyMeta>;
  /** Kept as an alias of `keys` so existing "from env" call sites still read. */
  envKeys: Record<string, EnvKeyMeta>;
  /** Per-variable editor rows. */
  entries: EnvEntry[];
  profile: ProfileInfo | null;
  loaded: boolean;
  /** env var currently being written/removed (inline busy state). */
  pending: string | null;
  actions: {
    load: () => Promise<void>;
    save: (envVar: string, value: string) => Promise<string>;
    remove: (envVar: string) => Promise<void>;
  };
}

export const useByokStore = createSelectors(
  create<ByokState>((set) => {
    const refresh = async () => {
      try {
        const [list, entries] = await Promise.all([byok.envList(), byok.entries()]);
        const keys: Record<string, EnvKeyMeta> = {};
        for (const m of list) keys[m.provider] = m;
        set({ keys, envKeys: keys, entries });
      } catch (err) {
        console.error("byok refresh failed", err);
      }
    };

    return {
      keys: {},
      envKeys: {},
      entries: [],
      profile: null,
      loaded: false,
      pending: null,
      actions: {
        load: async () => {
          armEnvUpdateListener(() => void refresh());
          await refresh();
          try {
            set({ profile: await byok.profileInfo() });
          } catch (err) {
            console.error("byok profileInfo failed", err);
          }
          set({ loaded: true });
        },

        save: async (envVar, value) => {
          const trimmed = value.trim();
          if (!trimmed) throw new Error("Value is empty.");
          set({ pending: envVar });
          try {
            const file = await byok.set(envVar, trimmed);
            await refresh();
            return file;
          } finally {
            set({ pending: null });
          }
        },

        remove: async (envVar) => {
          set({ pending: envVar });
          try {
            await byok.unset(envVar);
            await refresh();
          } finally {
            set({ pending: null });
          }
        },
      },
    };
  }),
);
