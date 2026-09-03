/**
 * The portable keymap document — what "export" copies and "import" reads.
 *
 * It carries the preset and the user's overrides, not the ~50 resolved chords.
 * An effective-map export would look more complete and behave worse: pinning
 * every command as an override freezes it against every later change to the
 * defaults, so a keymap shared today would slowly rot as Atlas moves. Sharing
 * the two things the user actually chose reproduces their setup exactly and
 * keeps them on the moving defaults for everything else.
 *
 * JSON rather than a TOML fragment even though `config.toml` is where this
 * ends up: this is a thing people paste into issues and gists, and JSON is
 * what every other editor's keymap export already looks like.
 */

import { ACTION_BY_ID } from "./actions";
import { parseCombo } from "./combo";
import { DEFAULT_PRESET_ID, isPresetId, type PresetId } from "./presets";
import type { BindingOverrides } from "./resolve";

/** Bumped only for a change that an older Atlas could not read correctly.
 *  [`importKeymap`] rejects anything newer rather than guessing. */
export const KEYMAP_FILE_VERSION = 1;

export interface KeymapFile {
  atlasKeymap: number;
  preset: PresetId;
  bindings: BindingOverrides;
}

export function exportKeymap(preset: PresetId, overrides: BindingOverrides): string {
  const file: KeymapFile = {
    atlasKeymap: KEYMAP_FILE_VERSION,
    preset,
    // Sorted so two exports of the same keymap are byte-identical and a diff
    // between two people's keymaps is readable.
    bindings: Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ImportResult =
  | { ok: true; preset: PresetId; overrides: BindingOverrides; skipped: string[] }
  | { ok: false; error: string };

/**
 * Read an exported keymap.
 *
 * Entries naming a command this build doesn't have are skipped and named in
 * `skipped` rather than failing the import — a keymap from a newer Atlas
 * should still bring over everything this one understands. Anything else
 * malformed fails the whole import: a keymap is small enough that partially
 * applying it is more confusing than rejecting it.
 */
export function importKeymap(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "expected a JSON object" };
  }

  const file = parsed as Partial<KeymapFile>;
  if (typeof file.atlasKeymap !== "number") {
    return { ok: false, error: "missing `atlasKeymap` — this isn't an Atlas keymap" };
  }
  if (file.atlasKeymap > KEYMAP_FILE_VERSION) {
    return {
      ok: false,
      error: `keymap format ${file.atlasKeymap} is newer than this Atlas build reads (${KEYMAP_FILE_VERSION})`,
    };
  }

  const preset =
    typeof file.preset === "string" && isPresetId(file.preset) ? file.preset : DEFAULT_PRESET_ID;
  if (file.preset !== undefined && preset !== file.preset) {
    return { ok: false, error: `unknown preset \`${String(file.preset)}\`` };
  }

  if (
    file.bindings !== undefined &&
    (typeof file.bindings !== "object" || file.bindings === null)
  ) {
    return { ok: false, error: "`bindings` must be an object" };
  }

  const overrides: BindingOverrides = {};
  const skipped: string[] = [];
  for (const [actionId, binding] of Object.entries(file.bindings ?? {})) {
    if (binding !== null && typeof binding !== "string") {
      return { ok: false, error: `\`${actionId}\` must be a chord string or null` };
    }
    if (!ACTION_BY_ID.has(actionId)) {
      skipped.push(actionId);
      continue;
    }
    if (binding !== null && !parseCombo(binding)) {
      return { ok: false, error: `\`${actionId}\`: \`${binding}\` isn't a chord Atlas can read` };
    }
    overrides[actionId] = binding;
  }

  return { ok: true, preset, overrides, skipped };
}
