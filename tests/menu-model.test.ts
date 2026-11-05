import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_BY_ID, isActionId } from "@/features/keybindings/lib/actions";
import { MENU_COMMAND_IDS } from "@/features/menu/lib/run-menu-item";
import { inWindowMenus, MENU_COMMANDS, MENU_EVENT, MENUS } from "@/features/menu/lib/menu-model";

/**
 * The app menu bar has one source, `src-tauri/menu.json`: Rust builds the
 * native macOS menu from it and the Windows/Linux titlebar draws it. Item ids
 * are opaque strings to both compilers — a renamed keybinding action, or a
 * command with no handler, leaves a menu item that compiles clean and does
 * nothing when clicked. This suite is what notices.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

const items = MENUS.flatMap((menu) => menu.items);

describe("menu model", () => {
  it("names only global keybinding actions", () => {
    for (const item of items) {
      if (item.type !== "action") continue;
      expect(isActionId(item.id), item.id).toBe(true);
      if (isActionId(item.id)) expect(ACTION_BY_ID[item.id].when, item.id).toBe("global");
    }
  });

  it("has a handler for every command, and a command for every handler", () => {
    const commands = items.flatMap((item) => (item.type === "command" ? [item.id] : []));
    expect([...commands].sort()).toEqual([...MENU_COMMANDS].sort());
    expect([...MENU_COMMAND_IDS].sort()).toEqual([...MENU_COMMANDS].sort());
  });

  it("uses only the roles menu.rs knows", () => {
    const rust = read("src-tauri/src/menu.rs");
    const block = rust.slice(
      rust.indexOf("pub enum Role {"),
      rust.indexOf("}", rust.indexOf("pub enum Role {")),
    );
    const known = new Set(
      [...block.matchAll(/^\s+([A-Z]\w*),/gm)].map((m) => m[1][0].toLowerCase() + m[1].slice(1)),
    );
    for (const item of items)
      if (item.type === "role") expect(known.has(item.role), item.role).toBe(true);
  });

  it("emits on the channel the renderer listens to", () => {
    expect(read("src-tauri/src/menu.rs")).toContain(
      `pub const MENU_EVENT: &str = "${MENU_EVENT}";`,
    );
  });

  it("keeps Cmd+W a Close Tab item, never the window's", () => {
    expect(items.some((item) => item.type === "action" && item.id === "tabs.close")).toBe(true);
    expect(items.some((item) => item.type === "role" && item.role === "close")).toBe(false);
  });

  it("drops native roles and stray separators from the in-window bar", () => {
    const bar = inWindowMenus([
      {
        id: "x",
        label: "X",
        items: [
          { type: "role", role: "hide" },
          { type: "separator" },
          { type: "command", id: "help.docs", label: "Docs" },
          { type: "separator" },
          { type: "role", role: "quit" },
          { type: "separator" },
        ],
      },
      { id: "edit", label: "Edit", items: [{ type: "role", role: "copy" }] },
    ]);
    expect(bar).toEqual([
      { id: "x", label: "X", items: [{ type: "command", id: "help.docs", label: "Docs" }] },
    ]);
  });
});
