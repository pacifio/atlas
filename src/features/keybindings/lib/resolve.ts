/**
 * Resolution = registry defaults ⊕ the active profile's overrides.
 * Pure functions so the store can recompute synchronously on every mutation
 * and the dispatchers can read a flat, pre-parsed list.
 */
import { ACTIONS, type ActionDef, type ActionId, type When, isActionId } from "./actions";
import { type Combo, comboEquals, parseCombo, serializeCombo } from "./combo";
import type { KeybindingProfile } from "./types";

export interface ResolvedBinding {
  actionId: ActionId;
  combo: Combo;
  /** Kept alongside the parsed form so the editor can show the exact
   *  string without re-serialising. */
  serialized: string;
  when: When;
  source: "default" | "user";
}

export interface ResolvedActionState {
  /** True when the profile overrides this action (even to the same chords). */
  overridden: boolean;
  /** Combos that failed to parse in the profile — shown as warnings. */
  invalid: string[];
}

export interface ResolvedState {
  /** Every live binding in registry order — the dispatch list. */
  list: ResolvedBinding[];
  byAction: Map<ActionId, ResolvedBinding[]>;
  perAction: Map<ActionId, ResolvedActionState>;
  /** Keys in the profile no registry entry knows about (a newer build wrote
   *  them, or a typo). Preserved on save; surfaced in the editor. */
  unknownActionIds: string[];
}

export function resolveProfile(profile: KeybindingProfile | undefined): ResolvedState {
  const list: ResolvedBinding[] = [];
  const byAction = new Map<ActionId, ResolvedBinding[]>();
  const perAction = new Map<ActionId, ResolvedActionState>();
  const overrides = profile?.bindings ?? {};

  for (const def of ACTIONS as readonly ActionDef[]) {
    const id = def.id as ActionId;
    const override = Object.prototype.hasOwnProperty.call(overrides, id)
      ? overrides[id]
      : undefined;
    const overridden = override !== undefined;
    const strings: readonly string[] = override === undefined ? def.defaults : (override ?? []);
    const invalid: string[] = [];
    const combos: ResolvedBinding[] = [];
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
        source: overridden ? "user" : "default",
      });
    }
    byAction.set(id, combos);
    perAction.set(id, { overridden, invalid });
    list.push(...combos);
  }

  const unknownActionIds = Object.keys(overrides).filter((k) => !isActionId(k));
  return { list, byAction, perAction, unknownActionIds };
}

export type ConflictKind = "hard" | "soft";

export interface Conflict {
  /** Serialized combo the group shares. */
  serialized: string;
  kind: ConflictKind;
  bindings: ResolvedBinding[];
}

/**
 * Same chord, same scope → hard conflict (first in registry order wins, the
 * rest never fire). Same chord, one global + one scoped → soft: the scoped
 * handler legitimately shadows the global one while its surface has focus
 * (terminal ⌘W vs. close-tab ⌘W is the canonical example).
 */
export function findConflicts(list: ResolvedBinding[]): Map<string, Conflict> {
  const groups = new Map<string, ResolvedBinding[]>();
  for (const b of list) {
    const arr = groups.get(b.serialized);
    if (arr) arr.push(b);
    else groups.set(b.serialized, [b]);
  }
  const out = new Map<string, Conflict>();
  for (const [serialized, bindings] of groups) {
    if (bindings.length < 2) continue;
    const scopes = new Map<When, number>();
    for (const b of bindings) scopes.set(b.when, (scopes.get(b.when) ?? 0) + 1);
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
  return list.filter((b) => b.actionId !== exceptActionId && comboEquals(b.combo, combo));
}
