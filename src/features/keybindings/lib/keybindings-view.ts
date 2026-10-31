/**
 * What Settings → Keybindings draws, worked out without React: one row per
 * action, the search over them, the category grouping, and each row's clash.
 * The page component only renders what this returns.
 */

import {
  ACTIONS,
  type ActionCategory,
  type ActionDef,
  type ActionId,
  CATEGORY_ORDER,
  type When,
} from "./actions";
import { type Combo, comboEquals, displayLabel, parseCombo } from "./combo";
import { type Conflict, type ResolvedBinding, type ResolvedState, conflictKey } from "./resolve";

export interface KeybindingRow {
  def: ActionDef;
  id: ActionId;
  bindings: ResolvedBinding[];
  /** The active profile overrides this action — what the reset button undoes. */
  changed: boolean;
  invalid: string[];
  /** The condition it fires under ("" = always), as the editor shows it. */
  whenExpr: string;
  invalidWhen: string | null;
}

export interface RowGroup {
  title: ActionCategory;
  rows: KeybindingRow[];
}

/** Which rows to show besides the search. */
export type RowFilter = "all" | "changed" | "clashes";

/** Where a shortcut works, in words, for a row's second line. Global
 *  shortcuts say nothing: "everywhere" is what a shortcut is by default. */
export const WHEN_PHRASES: Record<When, string> = {
  global: "",
  terminalFocus: "In the terminal",
  chatFocus: "In a chat",
  editorFocus: "In a file",
  knowledgePanel: "While Knowledge is open",
  knowledgeFocus: "In Knowledge",
  pdfFocus: "In a PDF",
  canvasFocus: "On a canvas",
  diffFocus: "In the review diff",
  pullRequestFocus: "In a pull request",
  modelPicker: "While the model picker is open",
};

export function buildRows(resolved: ResolvedState): KeybindingRow[] {
  return (ACTIONS as readonly ActionDef[]).map((def) => {
    const id = def.id as ActionId;
    const state = resolved.perAction.get(id);
    return {
      def,
      id,
      bindings: resolved.byAction.get(id) ?? [],
      changed: (state?.overridden || state?.whenOverridden) ?? false,
      invalid: state?.invalid ?? [],
      whenExpr: state?.whenExpr ?? "",
      invalidWhen: state?.invalidWhen ?? null,
    };
  });
}

/**
 * The clash a row should show, if any. `hard`: another action in the SAME
 * context shares a chord, so one of them can never fire. `soft`: a chord the
 * user chose is also bound in another context. Atlas's own cross-context
 * overlaps (the terminal's ⌘W shadowing close-tab) are by design and stay
 * quiet unless the user has touched one side.
 */
export function rowClash(
  row: KeybindingRow,
  conflicts: Map<string, Conflict>,
): { kind: "hard" | "soft"; with: ActionId[]; combo: Combo } | null {
  const others = row.bindings.flatMap((b) =>
    (conflicts.get(conflictKey(b.combo))?.bindings ?? [])
      .filter((o) => o.actionId !== row.id)
      .map((o) => ({ other: o, combo: b.combo })),
  );
  const own = row.whenExpr;
  const hard = others.filter(({ other }) => other.whenExpr === own);
  const soft = others.filter(
    ({ other }) =>
      other.whenExpr !== own &&
      (row.changed ||
        row.bindings.some((b) => b.source !== "default") ||
        other.source !== "default"),
  );
  const shown = hard.length ? hard : soft;
  if (!shown.length) return null;
  return {
    kind: hard.length ? "hard" : "soft",
    with: [...new Set(shown.map(({ other }) => other.actionId))],
    combo: shown[0]!.combo,
  };
}

/**
 * The search: every word must appear in the title, id, category, context or
 * a shortcut (its stored form `cmd+k` or its label `⌘K`). A query that reads
 * as a whole shortcut ("cmd k", "cmd+shift+p") instead matches exactly the
 * rows bound to it, so "k" alone does not light up every row with a K.
 * `pressed` is the record-keys search: a chord the user pressed.
 */
export function filterRows(
  rows: KeybindingRow[],
  { query, pressed, filter }: { query: string; pressed: Combo | null; filter: RowFilter },
  conflicts: Map<string, Conflict>,
): KeybindingRow[] {
  let out = rows;
  if (filter === "changed") out = out.filter((r) => r.changed);
  if (filter === "clashes") out = out.filter((r) => rowClash(r, conflicts) !== null);
  if (pressed) return out.filter((r) => r.bindings.some((b) => comboEquals(b.combo, pressed)));

  const q = query.trim().toLowerCase();
  if (!q) return out;
  const asCombo = queryCombo(q);
  if (asCombo) return out.filter((r) => r.bindings.some((b) => comboEquals(b.combo, asCombo)));

  const terms = q.split(/\s+/);
  return out.filter((r) => {
    const hay = [
      r.def.title,
      r.id,
      r.def.category,
      WHEN_PHRASES[r.def.when],
      r.whenExpr,
      ...r.bindings.flatMap((b) => [b.serialized, displayLabel(b.combo)]),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** "cmd k" / "cmd+k" / "shift cmd p" as a shortcut — only when it names at
 *  least one modifier, so a plain word ("tab", "zen") stays a text search. */
function queryCombo(q: string): Combo | null {
  const combo = parseCombo(q.replace(/\s+/g, "+"));
  if (!combo || !combo.code) return null;
  return combo.meta || combo.ctrl || combo.alt || combo.shift ? combo : null;
}

export function groupRows(rows: KeybindingRow[]): RowGroup[] {
  return CATEGORY_ORDER.map((title) => ({
    title,
    rows: rows.filter((r) => r.def.category === title),
  })).filter((g) => g.rows.length > 0);
}
