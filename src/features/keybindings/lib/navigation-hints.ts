import type { ActionId } from "./actions";
import { codeToToken, effectiveCombo, matchesCombo, serializeCombo, type Combo } from "./combo";
import type { ResolvedBinding, ResolvedState } from "./resolve";
import { reservedReason } from "./reserved";

export const NAVIGATION_TARGET_ATTR = "data-navigation-actions";
export const NAVIGATION_OVERLAY_ATTR = "data-navigation-hints";
export const NAVIGATION_HINT_DELAY = 400;

export type HeldModifiers = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** Only actions with a destination represented by the tab strip or panel controls. */
function isNavigationAction(id: ActionId): boolean {
  return (
    /^tabs\.focus[1-9]$/.test(id) ||
    id === "tabs.prev" ||
    id === "tabs.next" ||
    id === "split.focusLeft" ||
    id === "split.focusRight" ||
    id === "workspace.toggleSidebar" ||
    id === "panels.left" ||
    id === "panels.right"
  );
}

/** Match the layout store: indices are local to a split, and 9 means its last tab. */
export function tabNavigationActions(
  index: number,
  count: number,
  activeIndex: number,
): ActionId[] {
  if (index < 0 || index >= count) return [];
  const actions: ActionId[] = [];
  if (index < 8) actions.push(("tabs.focus" + (index + 1)) as ActionId);
  if (index === count - 1) actions.push("tabs.focus9");
  if (count > 1) {
    const current = Math.max(0, activeIndex);
    if (index === (current - 1 + count) % count) actions.push("tabs.prev");
    if (index === (current + 1) % count) actions.push("tabs.next");
  }
  return actions;
}

/** Adjacent-pane focus is clamped at either end, unlike tab cycling. */
export function splitNavigationActions(
  groupId: string,
  groupOrder: readonly string[],
  focusedGroupId: string,
): ActionId[] {
  const current = groupOrder.indexOf(focusedGroupId);
  const target = groupOrder.indexOf(groupId);
  if (current < 0 || target < 0) return [];
  if (target === current - 1) return ["split.focusLeft"];
  if (target === current + 1) return ["split.focusRight"];
  return [];
}

/**
 * Follow global dispatch order, platform folding and live rebindings. Active
 * scoped handlers and hint navigation can claim a chord before global dispatch.
 * Reserved chords are deliberately not advertised even if a profile binds one.
 */
export function navigationBindings(
  resolved: ResolvedState,
  mac: boolean,
  registered?: ReadonlySet<ActionId>,
  scopedActions: ReadonlySet<ActionId> = new Set(),
): ResolvedBinding[] {
  const claimed = new Set(
    resolved.list
      .filter((b) => scopedActions.has(b.actionId) || b.actionId === "hintNav.toggle")
      .map((b) => serializeCombo(effectiveCombo(b.combo, mac))),
  );
  const seen = new Set<string>();
  const result: ResolvedBinding[] = [];
  for (const binding of resolved.list) {
    if (binding.when !== "global" || (registered && !registered.has(binding.actionId))) continue;
    const key = serializeCombo(effectiveCombo(binding.combo, mac));
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      isNavigationAction(binding.actionId) &&
      !claimed.has(key) &&
      !reservedReason(binding.combo, mac)
    ) {
      result.push(binding);
    }
  }
  return result;
}

/** A cap names just the follow-up key: all of its modifiers must already be held. */
export function bindingForTarget(
  actions: readonly ActionId[],
  bindings: readonly ResolvedBinding[],
  held: HeldModifiers,
  mac: boolean,
): ResolvedBinding | undefined {
  for (const action of actions) {
    const binding = bindings.find(
      (b) =>
        b.actionId === action &&
        matchesCombo({ ...held, code: b.combo.code } as KeyboardEvent, b.combo, mac),
    );
    if (binding) return binding;
  }
  return undefined;
}

/** aria-keyshortcuts uses names, not the glyphs drawn on the visual keycaps. */
export function ariaShortcut(combo: Combo, mac: boolean): string {
  const effective = effectiveCombo(combo, mac);
  const keys: string[] = [];
  if (mac ? effective.ctrl : effective.meta) keys.push("Control");
  if (effective.alt) keys.push("Alt");
  if (effective.shift) keys.push("Shift");
  if (mac ? effective.meta : effective.ctrl) keys.push("Meta");
  const token = codeToToken(combo.code);
  keys.push(token.length === 1 ? token.toUpperCase() : combo.code);
  return keys.join("+");
}
