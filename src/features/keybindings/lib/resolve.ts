/**
 * Layering and lookup: catalogue defaults → preset → the user's own overrides.
 *
 * Every consumer reads the resolved keymap and nothing else. Settings shows
 * it, the dispatcher matches against it, and `config.toml` stores only the
 * top layer — so a preset that changes in a later Atlas version reaches the
 * user, while the chords they set by hand survive it.
 */

import {
  ACTIONS,
  ACTION_BY_ID,
  type ActionDef,
  type ActionId,
  type Chord,
  type KeybindingScope,
} from "./actions";
import { combosEqual, parseCombo, serializeCombo, type Combo, type Platform } from "./combo";
import { DEFAULT_PRESET_ID, PRESET_BY_ID, type PresetId } from "./presets";

/** Which layer decided a chord. Drives Settings' "reset to default" — a
 *  command is resettable exactly when this is `"user"`. */
export type BindingSource = "default" | "preset" | "user";

export interface ResolvedBinding {
  action: ActionDef;
  /** Every chord that runs this command, in declaration order. Empty = the
   *  command is deliberately unbound, by the preset or by the user. */
  combos: Combo[];
  source: BindingSource;
}

/** The chord shown when one has to stand for the command — the first, which is
 *  the one its defaults and presets lead with. */
export function primaryCombo(binding: ResolvedBinding | undefined): Combo | null {
  return binding?.combos[0] ?? null;
}

/** `null` and `""` both mean unbound; a lone string is a one-chord list. */
function asChordList(chord: Chord): readonly string[] {
  if (chord === null) return [];
  if (typeof chord === "string") return chord === "" ? [] : [chord];
  return chord;
}

/**
 * Something in the stored keymap that could not be honoured. Never fatal: an
 * unreadable entry is dropped and reported, the same way `config.toml` treats
 * a key it doesn't recognize.
 */
export interface KeymapProblem {
  actionId: string;
  /** The text as it was written, so Settings can quote it back. */
  binding: string;
  reason: "unknown-action" | "unparseable";
}

/** The user's layer, as stored: action id → chord (or chords), or null to
 *  unbind a command the default or preset binds. */
export type BindingOverrides = Record<string, Chord>;

export interface Keymap {
  preset: PresetId;
  bindings: readonly ResolvedBinding[];
  problems: readonly KeymapProblem[];
}

export function resolveKeymap(
  preset: PresetId,
  overrides: BindingOverrides,
  platform?: Platform,
): Keymap {
  const presetBindings = (PRESET_BY_ID.get(preset) ?? PRESET_BY_ID.get(DEFAULT_PRESET_ID)!)
    .bindings;
  const problems: KeymapProblem[] = [];

  // An override naming a command this build doesn't have is kept in the file
  // (Rust preserves unknown keys) and reported here rather than dropped: it is
  // usually a typo, but it is also what a config written by a newer Atlas
  // looks like, and deleting the user's line would be the wrong repair for
  // either.
  for (const actionId of Object.keys(overrides)) {
    if (!ACTION_BY_ID.has(actionId)) {
      problems.push({
        actionId,
        binding: asChordList(overrides[actionId]).join(", "),
        reason: "unknown-action",
      });
    }
  }

  const bindings = ACTIONS.map((action): ResolvedBinding => {
    const layers: Array<{ chord: Chord | undefined; source: BindingSource }> = [
      { chord: overrides[action.id], source: "user" },
      { chord: presetBindings[action.id as ActionId], source: "preset" },
      { chord: action.binding, source: "default" },
    ];
    // The topmost layer that says anything wins outright — chords do not merge
    // across layers, or unbinding a command the preset moved would be
    // impossible to express.
    const layer = layers.find((l) => l.chord !== undefined);
    if (!layer) return { action, combos: [], source: "default" };

    const combos: Combo[] = [];
    for (const text of asChordList(layer.chord!)) {
      const combo = parseCombo(text, platform);
      if (combo) combos.push(combo);
      // Dropped rather than falling through to the layer below: a chord the
      // file no longer asks for must not keep firing, and the problem is what
      // tells the user their line was rejected.
      else problems.push({ actionId: action.id, binding: text, reason: "unparseable" });
    }
    return { action, combos, source: layer.source };
  });

  return { preset, bindings, problems };
}

/**
 * Two commands in the same scope on the same chord — ambiguous, and the reason
 * Settings refuses to save until one of them moves.
 *
 * A scoped command sharing a chord with a global one is NOT a conflict: that
 * is the precedence rule working (⌘F is "find in chat" while a chat is
 * focused and "global search" is not bound to it at all). Only same-scope
 * collisions have no answer.
 */
export interface BindingConflict {
  combo: Combo;
  scope: KeybindingScope;
  actionIds: string[];
}

export function findConflicts(bindings: readonly ResolvedBinding[]): BindingConflict[] {
  const seen = new Map<string, { combo: Combo; bindings: ResolvedBinding[] }>();
  for (const binding of bindings) {
    for (const combo of binding.combos) {
      const key = `${binding.action.scope}:${serializeCombo(combo)}`;
      const group = seen.get(key);
      if (group) group.bindings.push(binding);
      else seen.set(key, { combo, bindings: [binding] });
    }
  }
  return [...seen.values()]
    .filter((group) => group.bindings.length > 1)
    .map((group) => ({
      combo: group.combo,
      scope: group.bindings[0].action.scope,
      actionIds: group.bindings.map((b) => b.action.id),
    }));
}

/**
 * Commands whose chord a scoped binding takes over while that surface is
 * focused. Not a problem — it is what scopes are for — but Settings says so,
 * because "⌘F stopped opening global search inside a chat" should be
 * something the user was told, not something they discover.
 */
export interface ShadowedBinding {
  combo: Combo;
  scopedActionId: string;
  globalActionId: string;
}

export function findShadowed(bindings: readonly ResolvedBinding[]): ShadowedBinding[] {
  const globals = bindings.filter((b) => b.action.scope === "global");
  return bindings
    .filter((b) => b.action.scope !== "global")
    .flatMap((scoped) =>
      scoped.combos.flatMap((combo) => {
        const hidden = globals.find((g) => g.combos.some((c) => combosEqual(c, combo)));
        return hidden
          ? [{ combo, scopedActionId: scoped.action.id, globalActionId: hidden.action.id }]
          : [];
      }),
    );
}

/**
 * Chord → command, per scope. Built once per keymap so the keydown path is two
 * map lookups rather than a walk over ~50 bindings on every keystroke.
 */
export type KeymapLookup = ReadonlyMap<KeybindingScope, ReadonlyMap<string, string>>;

export function buildLookup(bindings: readonly ResolvedBinding[]): KeymapLookup {
  const lookup = new Map<KeybindingScope, Map<string, string>>();
  for (const binding of bindings) {
    const scope = lookup.get(binding.action.scope) ?? new Map<string, string>();
    for (const combo of binding.combos) {
      // First declaration wins, so a conflicting pair behaves predictably
      // (catalogue order) instead of by map insertion accident while the user
      // is still deciding how to resolve it.
      if (!scope.has(serializeCombo(combo))) scope.set(serializeCombo(combo), binding.action.id);
    }
    lookup.set(binding.action.scope, scope);
  }
  return lookup;
}

/**
 * The command a chord runs given the focused surface: the scope's own binding
 * if it has one, otherwise the global binding. One level deep because scopes
 * don't nest — a pane is a chat or a terminal, never both.
 */
export function lookupAction(
  lookup: KeymapLookup,
  combo: Combo,
  scope: KeybindingScope | null,
): string | null {
  const key = serializeCombo(combo);
  if (scope) {
    const scoped = lookup.get(scope)?.get(key);
    if (scoped) return scoped;
  }
  return lookup.get("global")?.get(key) ?? null;
}
