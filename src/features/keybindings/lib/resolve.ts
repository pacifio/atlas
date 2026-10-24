/**
 * Resolution = registry defaults ⊕ the profile's preset ⊕ its overrides.
 * Pure functions so the store can recompute synchronously on every mutation
 * and the dispatchers can read a flat, pre-parsed list.
 */
import { ACTIONS, type ActionDef, type ActionId, type When, isActionId } from "./actions";
import { type Combo, comboEquals, effectiveCombo, parseCombo, serializeCombo } from "./combo";
import { PRESET_BY_ID, type Preset } from "./presets";
import type { KeybindingProfile } from "./types";
import { defaultWhenExpression, parseWhen, whenToExpression, type WhenNode } from "./when";

export interface ResolvedBinding {
  actionId: ActionId;
  combo: Combo;
  /** Kept alongside the parsed form so the editor can show the exact
   *  string without re-serialising. */
  serialized: string;
  /** The action's registry context: which panel's handler runs it. */
  when: When;
  /** The condition it fires under, canonical text ("" = always) and parsed. */
  whenExpr: string;
  whenAst: WhenNode | undefined;
  source: "default" | "preset" | "user";
}

export interface ResolvedActionState {
  /** True when the profile overrides this action (even to the same chords). */
  overridden: boolean;
  /** Combos that failed to parse in the profile — shown as warnings. */
  invalid: string[];
  /** The profile replaces this action's `when`. */
  whenOverridden: boolean;
  /** The profile's `when` for this action didn't parse; the default applies. */
  invalidWhen: string | null;
  /** The condition it fires under — also for an action with no chord. */
  whenExpr: string;
  whenAst: WhenNode | undefined;
}

export interface ResolvedState {
  /** Every live binding in registry order — the dispatch list. */
  list: ResolvedBinding[];
  byAction: Map<ActionId, ResolvedBinding[]>;
  perAction: Map<ActionId, ResolvedActionState>;
  /** Keys in the profile no registry entry knows about (a newer build wrote
   *  them, or a typo). Preserved on save; surfaced in the editor. */
  unknownActionIds: string[];
  /** The profile's preset, or null for none / an id this build doesn't know. */
  preset: Preset | null;
  /** `basedOn` named a preset this build doesn't have (a newer build wrote
   *  it, or a typo). The profile resolves as if it had none. */
  unknownPresetId: string | null;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** What an action resolves to before the profile's own override: the
 *  preset's chords if it names the action, else the registry default. */
export function baseChords(def: ActionDef, preset: Preset | null): readonly string[] {
  if (preset && has(preset.bindings, def.id)) return preset.bindings[def.id as ActionId] ?? [];
  return def.defaults;
}

export function resolveProfile(profile: KeybindingProfile | undefined): ResolvedState {
  const list: ResolvedBinding[] = [];
  const byAction = new Map<ActionId, ResolvedBinding[]>();
  const perAction = new Map<ActionId, ResolvedActionState>();
  const overrides = profile?.bindings ?? {};
  const whenOverrides = profile?.when ?? {};
  const presetId = profile?.basedOn;
  const preset = (presetId && PRESET_BY_ID.get(presetId)) || null;

  for (const def of ACTIONS as readonly ActionDef[]) {
    const id = def.id as ActionId;
    const override = has(overrides, id) ? overrides[id] : undefined;
    const overridden = override !== undefined;
    const fromPreset = !overridden && !!preset && has(preset.bindings, id);
    const strings: readonly string[] = overridden ? (override ?? []) : baseChords(def, preset);
    const invalid: string[] = [];
    const combos: ResolvedBinding[] = [];
    const rawWhen = has(whenOverrides, id) ? whenOverrides[id] : undefined;
    const parsedWhen = rawWhen?.trim() ? parseWhen(rawWhen) : undefined;
    const invalidWhen = rawWhen?.trim() && !parsedWhen ? rawWhen : null;
    const whenOverridden = rawWhen !== undefined && !invalidWhen;
    const whenAst = whenOverridden
      ? (parsedWhen ?? undefined)
      : (parseWhen(defaultWhenExpression(def.when)) ?? undefined);
    const whenExpr = whenToExpression(whenAst);
    for (const s of strings) {
      const combo = parseCombo(s);
      if (!combo) {
        invalid.push(s);
        continue;
      }
      if (combos.some((c) => comboEquals(c.combo, combo))) continue;
      combos.push({
        actionId: id,
        combo,
        serialized: serializeCombo(combo),
        when: def.when,
        whenExpr,
        whenAst,
        source: overridden ? "user" : fromPreset ? "preset" : "default",
      });
    }
    byAction.set(id, combos);
    perAction.set(id, { overridden, invalid, whenOverridden, invalidWhen, whenExpr, whenAst });
    list.push(...combos);
  }

  const unknownActionIds = [
    ...new Set([...Object.keys(overrides), ...Object.keys(whenOverrides)]),
  ].filter((k) => !isActionId(k));
  return {
    list,
    byAction,
    perAction,
    unknownActionIds,
    preset,
    unknownPresetId: presetId && !preset ? presetId : null,
  };
}

/** The key `findConflicts` groups by — look a binding's group up with this,
 *  not with `serialized`. */
export function conflictKey(combo: Combo, mac?: boolean): string {
  return serializeCombo(effectiveCombo(combo, mac));
}

export type ConflictKind = "hard" | "soft";

export interface Conflict {
  /** Serialized combo the group shares. */
  serialized: string;
  kind: ConflictKind;
  bindings: ResolvedBinding[];
}

/**
 * Same chord, same condition → hard conflict (first in registry order wins,
 * the rest never fire). Same chord, different conditions → soft: the scoped
 * handler legitimately shadows the global one while its surface has focus
 * (terminal ⌘W vs. close-tab ⌘W is the canonical example). Conditions are
 * compared as written, so two that can overlap in ways the text doesn't show
 * stay soft.
 *
 * "Same chord" is the platform-effective chord: off macOS `cmd+k` and
 * `ctrl+k` are one key, and grouping by the written string would miss that.
 * One action bound twice to the same effective chord is not a conflict.
 */
export function findConflicts(list: ResolvedBinding[], mac?: boolean): Map<string, Conflict> {
  const groups = new Map<string, ResolvedBinding[]>();
  for (const b of list) {
    const key = conflictKey(b.combo, mac);
    const arr = groups.get(key);
    if (!arr) groups.set(key, [b]);
    else if (!arr.some((o) => o.actionId === b.actionId)) arr.push(b);
  }
  const out = new Map<string, Conflict>();
  for (const [serialized, bindings] of groups) {
    if (bindings.length < 2) continue;
    const scopes = new Map<string, number>();
    for (const b of bindings) scopes.set(b.whenExpr, (scopes.get(b.whenExpr) ?? 0) + 1);
    const hard = [...scopes.values()].some((n) => n > 1);
    out.set(serialized, { serialized, kind: hard ? "hard" : "soft", bindings });
  }
  return out;
}

/** Other actions bound to `combo` — for the recorder's "N existing commands
 *  have this keybinding" line. */
export function bindingsForCombo(
  list: ResolvedBinding[],
  combo: Combo,
  exceptActionId?: ActionId,
): ResolvedBinding[] {
  const want = effectiveCombo(combo);
  return list.filter(
    (b) => b.actionId !== exceptActionId && comboEquals(effectiveCombo(b.combo), want),
  );
}
