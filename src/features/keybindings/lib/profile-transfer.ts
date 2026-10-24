/**
 * The portable form of ONE keybinding profile — what "Copy profile" puts on
 * the clipboard and "Import profile" reads back as a new profile.
 *
 * It carries the preset and the overrides, never the resolved chords.
 * Pinning every command as an override would freeze the whole keymap against
 * later changes to Atlas's defaults, so a profile shared today would slowly
 * rot; sharing what the user actually chose keeps them on the moving defaults
 * for everything else.
 *
 * `atlasKeybindings` is the format version, bumped only for a change an older
 * build could not read correctly. A newer version is rejected rather than
 * guessed at. Unknown action ids and an unknown preset are KEPT, exactly as
 * `keybindings.json` keeps them: a profile exported from a newer build should
 * lose nothing by passing through this one.
 */

import { isActionId } from "./actions";
import { parseCombo } from "./combo";
import { isPresetId } from "./presets";
import type { KeybindingProfile } from "./types";
import { parseWhen } from "./when";

export const PROFILE_TRANSFER_VERSION = 1;

export interface ProfileTransfer {
  atlasKeybindings: number;
  name: string;
  basedOn?: string;
  bindings: KeybindingProfile["bindings"];
  when?: Record<string, string>;
}

export function exportProfile(profile: KeybindingProfile): string {
  const doc: ProfileTransfer = {
    atlasKeybindings: PROFILE_TRANSFER_VERSION,
    name: profile.name,
    ...(profile.basedOn ? { basedOn: profile.basedOn } : {}),
    // Sorted so two exports of the same profile are byte-identical and a diff
    // between two people's keymaps is readable.
    bindings: sorted(profile.bindings),
    ...(profile.when && Object.keys(profile.when).length ? { when: sorted(profile.when) } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export type ImportResult =
  | {
      ok: true;
      profile: Pick<KeybindingProfile, "name" | "basedOn" | "bindings" | "when">;
      /** Kept, but this build can't run them — worth telling the user. */
      unknownActionIds: string[];
      unknownPresetId: string | null;
    }
  | { ok: false; error: string };

/** Read an exported profile. Anything malformed fails the whole import: a
 *  profile is small enough that half-applying one is worse than refusing. */
export function importProfile(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const doc = parsed as Partial<Record<keyof ProfileTransfer, unknown>>;
  if (typeof doc.atlasKeybindings !== "number") {
    return { ok: false, error: "missing `atlasKeybindings`, so this isn't an Atlas profile" };
  }
  if (doc.atlasKeybindings > PROFILE_TRANSFER_VERSION) {
    return {
      ok: false,
      error: `profile format ${doc.atlasKeybindings} is newer than this Atlas reads (${PROFILE_TRANSFER_VERSION})`,
    };
  }
  const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : "Imported";
  if (doc.basedOn !== undefined && (typeof doc.basedOn !== "string" || !doc.basedOn.trim())) {
    return { ok: false, error: "`basedOn` must be a preset id" };
  }
  const basedOn = doc.basedOn as string | undefined;
  const raw = doc.bindings ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "`bindings` must be an object" };
  }

  const bindings: KeybindingProfile["bindings"] = {};
  for (const [actionId, value] of Object.entries(raw)) {
    if (value === null) {
      bindings[actionId] = null;
      continue;
    }
    if (!Array.isArray(value) || value.some((c) => typeof c !== "string")) {
      return { ok: false, error: `\`${actionId}\` must be a list of chords or null` };
    }
    const bad = (value as string[]).find((c) => !parseCombo(c));
    if (bad !== undefined) {
      return { ok: false, error: `\`${actionId}\`: \`${bad}\` isn't a chord Atlas can read` };
    }
    bindings[actionId] = value as string[];
  }

  const rawWhen = doc.when ?? {};
  if (typeof rawWhen !== "object" || rawWhen === null || Array.isArray(rawWhen)) {
    return { ok: false, error: "`when` must be an object" };
  }
  const when: Record<string, string> = {};
  for (const [actionId, value] of Object.entries(rawWhen)) {
    if (typeof value !== "string" || (value.trim() && !parseWhen(value))) {
      return {
        ok: false,
        error: `\`${actionId}\`: \`${String(value)}\` isn't a condition Atlas can read`,
      };
    }
    when[actionId] = value.trim();
  }

  return {
    ok: true,
    profile: {
      name,
      ...(basedOn ? { basedOn } : {}),
      bindings,
      ...(Object.keys(when).length ? { when } : {}),
    },
    unknownActionIds: [...new Set([...Object.keys(bindings), ...Object.keys(when)])].filter(
      (k) => !isActionId(k),
    ),
    unknownPresetId: basedOn && !isPresetId(basedOn) ? basedOn : null,
  };
}
