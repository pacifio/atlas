import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { commitConfigPatch } from "@/features/settings/lib/config-write";
import type { ActionId, Chord } from "../lib/actions";
import {
  bindingToWire,
  overridesFrom,
  presetFrom,
  updateKeymap,
  type KeymapPatch,
  type KeymapWire,
} from "../lib/keymap-api";
import { DEFAULT_PRESET_ID, type PresetId } from "../lib/presets";
import {
  buildLookup,
  resolveKeymap,
  type BindingOverrides,
  type Keymap,
  type KeymapLookup,
} from "../lib/resolve";

/**
 * The live keymap.
 *
 * Holds the two things the user chose — a preset and their overrides — plus
 * the resolved view derived from them. The derivation is eager rather than a
 * selector because the dispatcher needs `lookup` on the keydown path, where
 * recomputing ~50 bindings per keystroke would be the only expensive thing
 * about pressing a key.
 *
 * Writes go through `config.toml` and come back as the truth: this store is
 * the mirror, `config.toml` is the record. The generation those writes are
 * checked against lives in the project store, which owns every other piece of
 * config wire state — one counter for one file.
 */

interface KeybindingsState {
  preset: PresetId;
  overrides: BindingOverrides;
  /** Whether the first-run picker has been answered. Lives in `state.json`
   *  (it records what happened, not what the user wants) and rides in on the
   *  bootstrap payload. */
  onboardingSeen: boolean;
  /** Resolved bindings plus anything in the stored keymap that couldn't be
   *  honoured — surfaced by Settings, never fatal. */
  keymap: Keymap;
  lookup: KeymapLookup;
  actions: {
    /** Adopt what `config.toml` holds — boot, hot reload, or the reply to
     *  this store's own write. */
    hydrate: (wire: KeymapWire) => void;
    hydrateOnboardingSeen: (seen: boolean) => void;
    /** Answer the first-run picker. "Decide later" is an answer: it passes no
     *  preset and the question is not asked again. */
    completeOnboarding: (preset?: PresetId) => Promise<void>;
    setPreset: (preset: PresetId) => Promise<void>;
    /** `null` unbinds the command; use `resetBinding` to go back to the
     *  preset's chord instead. */
    setBinding: (actionId: ActionId, chord: Chord) => Promise<void>;
    /** Several at once, in one write — what resolving a conflict needs, since
     *  moving a chord and freeing it from its previous owner is one decision
     *  and should be one save. */
    setBindings: (changes: Partial<Record<ActionId, Chord>>) => Promise<void>;
    resetBinding: (actionId: ActionId) => Promise<void>;
    /** Drop every override, keeping the preset. */
    resetAllBindings: () => Promise<void>;
    /** Replace preset and overrides wholesale — the import half of
     *  import/export. */
    replaceKeymap: (preset: PresetId, overrides: BindingOverrides) => Promise<void>;
  };
}

function derive(preset: PresetId, overrides: BindingOverrides) {
  const keymap = resolveKeymap(preset, overrides);
  return { preset, overrides, keymap, lookup: buildLookup(keymap.bindings) };
}

/**
 * Write, then adopt what the file actually ends up holding — whether or not
 * this patch was the thing that put it there.
 *
 * Throws on a conflict Rust wouldn't resolve, and on a failed write. Both are
 * for the Settings editor to show against the command the user was editing,
 * where the message means something, rather than as a global banner.
 */
async function commitKeymapPatch(patch: KeymapPatch): Promise<void> {
  const outcome = await commitConfigPatch((generation) => updateKeymap(patch, generation));
  useKeybindingsStore.getState().actions.hydrate(outcome.keymap);
  if (outcome.kind === "conflict") {
    throw new Error("That change conflicted with a concurrent edit to config.toml — try again.");
  }
}

export const useKeybindingsStore = createSelectors(
  create<KeybindingsState>()((set, get) => ({
    ...derive(DEFAULT_PRESET_ID, {}),
    onboardingSeen: false,
    actions: {
      hydrate: (wire: KeymapWire) => set(derive(presetFrom(wire), overridesFrom(wire))),

      hydrateOnboardingSeen: (seen: boolean) => set({ onboardingSeen: seen }),

      completeOnboarding: async (preset?: PresetId) => {
        // Marked seen first, and regardless of what the write does: a failed
        // preset write is worth a retry from Settings, but re-asking the same
        // question on the next launch is not.
        set({ onboardingSeen: true });
        void invoke("mark_keymap_onboarding_seen").catch((e) => {
          console.warn("could not record the keymap onboarding answer:", e);
        });
        if (preset) await get().actions.setPreset(preset);
      },

      setPreset: async (preset: PresetId) => {
        set(derive(preset, get().overrides));
        await commitKeymapPatch({ preset });
      },

      setBinding: (actionId: ActionId, chord: Chord) =>
        get().actions.setBindings({ [actionId]: chord }),

      setBindings: async (changes: Partial<Record<ActionId, Chord>>) => {
        set(derive(get().preset, { ...get().overrides, ...changes }));
        await commitKeymapPatch({
          bindings: Object.fromEntries(
            Object.entries(changes).map(([actionId, chord]) => [
              actionId,
              bindingToWire(chord ?? null),
            ]),
          ),
        });
      },

      resetBinding: async (actionId: ActionId) => {
        const overrides = { ...get().overrides };
        delete overrides[actionId];
        set(derive(get().preset, overrides));
        // `null` deletes the line; `""` would have unbound the command.
        await commitKeymapPatch({ bindings: { [actionId]: null } });
      },

      resetAllBindings: async () => {
        const cleared = Object.fromEntries(Object.keys(get().overrides).map((id) => [id, null]));
        set(derive(get().preset, {}));
        await commitKeymapPatch({ bindings: cleared });
      },

      replaceKeymap: async (preset: PresetId, overrides: BindingOverrides) => {
        // Every current override is cleared in the same patch that writes the
        // new ones, so an import leaves exactly what was imported — a
        // whole-table replace would have taken the user's bindings for
        // commands from a newer Atlas with it.
        const bindings: Record<string, string | string[] | null> = Object.fromEntries(
          Object.keys(get().overrides).map((id) => [id, null]),
        );
        for (const [actionId, chord] of Object.entries(overrides)) {
          bindings[actionId] = bindingToWire(chord);
        }
        set(derive(preset, overrides));
        await commitKeymapPatch({ preset, bindings });
      },
    },
  })),
);
