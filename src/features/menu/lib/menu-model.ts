/**
 * The app menu bar, as data. The one copy is `src-tauri/menu.json`: Rust
 * builds the native macOS menu from it (`src-tauri/src/menu.rs`) and the
 * Windows/Linux titlebar draws it (`menu-bar.tsx`), so the two can't list
 * different items. `tests/menu-model.test.ts` pins the ids to the keybinding
 * registry and to {@link MENU_COMMANDS}.
 */

import model from "../../../../src-tauri/menu.json";
import { isActionId, type ActionId } from "@/features/keybindings/lib/actions";

/** The event a native menu item emits; the payload is the item's id. */
export const MENU_EVENT = "atlas:menu-command";

/** Menu-only commands — destinations with no keybinding action. */
export const MENU_COMMANDS = [
  "app.about",
  "app.checkUpdates",
  "help.docs",
  "help.shortcuts",
  "help.feedback",
  "help.github",
  "help.discord",
] as const;

export type MenuCommandId = (typeof MENU_COMMANDS)[number];

export type MenuItemDef =
  | { type: "action"; id: string; label: string }
  | { type: "command"; id: string; label: string }
  | { type: "role"; role: string }
  | { type: "separator" };

export interface MenuDef {
  id: string;
  label: string;
  items: MenuItemDef[];
}

export const MENUS: readonly MenuDef[] = (model as { menus: MenuDef[] }).menus;

/** A menu item that runs something in the renderer (not a native role). */
export type RunnableItem = Extract<MenuItemDef, { type: "action" | "command" }>;

/**
 * The menus the in-window bar can draw: native roles dropped (they are AppKit
 * selectors with no web equivalent), then the separators that leaves at an
 * edge or doubled, then any menu with nothing left.
 */
export function inWindowMenus(menus: readonly MenuDef[] = MENUS): MenuDef[] {
  const out: MenuDef[] = [];
  for (const menu of menus) {
    const items: MenuItemDef[] = [];
    const lastIsSeparator = () => items[items.length - 1]?.type === "separator";
    for (const item of menu.items) {
      if (item.type === "role") continue;
      if (item.type === "separator" && (items.length === 0 || lastIsSeparator())) continue;
      items.push(item);
    }
    while (lastIsSeparator()) items.pop();
    if (items.length > 0) out.push({ ...menu, items });
  }
  return out;
}

/** Every action item's id, in menu order. An id the registry doesn't know is
 *  dropped here and failed by the test. */
export function menuActionIds(menus: readonly MenuDef[] = MENUS): ActionId[] {
  return menus.flatMap((menu) =>
    menu.items.flatMap((item) => (item.type === "action" && isActionId(item.id) ? [item.id] : [])),
  );
}
