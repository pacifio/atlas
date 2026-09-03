import { invoke } from "@tauri-apps/api/core";
import type { UpdateOutcome } from "@/features/settings/lib/atlas-config-api";
import type { Chord } from "./actions";
import type { BindingOverrides } from "./resolve";
import { DEFAULT_PRESET_ID, isPresetId, type PresetId } from "./presets";

/**
 * The `[keymap]` half of `config.toml` — the same IPC seam
 * `atlas-config-api.ts` is for `[settings]`, and the only place the wire shape
 * of a keymap is translated.
 *
 * Two spellings of "no chord" meet here, and they are not the same thing:
 *
 *   - a binding of `""` on the wire, `null` in `BindingOverrides` — the user
 *     unbound this command and wants it to stay unbound;
 *   - a key that isn't there at all — the command was never overridden and
 *     follows the preset.
 *
 * TOML has no null to tell those apart with, so the file spends the empty
 * string on it. A patch adds a third: `null` on the wire means "delete this
 * override", i.e. go back to the preset's chord.
 */

/** What `[keymap]` looks like on the wire. Mirrors Rust's `KeymapConfig`. */
export interface KeymapWire {
  preset: string;
  bindings: Record<string, string | string[]>;
}

/** Rust's `UNBOUND_BINDING`. Kept identical by a drift test in
 *  `src-tauri/src/state/atlas_config.rs`. */
const UNBOUND = "";

export interface KeymapPatch {
  preset?: PresetId;
  /** Command id → new chord (or chords), `""` to unbind, or `null` to drop the
   *  override and go back to the preset. */
  bindings?: Record<string, string | string[] | null>;
}

export function updateKeymap(
  patch: KeymapPatch,
  expectedGeneration: number,
): Promise<UpdateOutcome> {
  return invoke<UpdateOutcome>("update_atlas_keymap", { patch, expectedGeneration });
}

/** The stored preset, or Atlas's if the file names one this build doesn't
 *  have — the same forgiving read the resolver gives an unknown preset, since
 *  a config written by a newer Atlas must not leave the user with no keymap. */
export function presetFrom(wire: KeymapWire): PresetId {
  return isPresetId(wire.preset) ? wire.preset : DEFAULT_PRESET_ID;
}

export function overridesFrom(wire: KeymapWire): BindingOverrides {
  return Object.fromEntries(
    Object.entries(wire.bindings).map(([action, chord]) => [
      action,
      chord === UNBOUND || (Array.isArray(chord) && chord.length === 0) ? null : chord,
    ]),
  );
}

/** The inverse, for the patch a Settings save sends. A list stays a list — the
 *  file takes an array for a command with more than one chord. */
export function bindingToWire(chord: Chord): string | string[] {
  if (chord === null) return UNBOUND;
  if (typeof chord === "string") return chord;
  return chord.length ? [...chord] : UNBOUND;
}
