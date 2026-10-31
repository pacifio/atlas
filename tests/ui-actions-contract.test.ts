import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACTIONS } from "@/features/keybindings/lib/actions";

/**
 * Guards the UI action seam (ADR-0012): every tool the UI tool server lists
 * to the model has a case in the window's dispatcher, and the dispatcher has
 * no case the model can never call.
 *
 * The two halves live in two languages and the model only ever sees the Rust
 * list, so a tool added on one side alone either answers "unknown UI action"
 * forever or is dead code — and neither compiler can tell. Read from source
 * like the other contract tests, so there is no list here to keep in step.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function rustTools(): string[] {
  const src = read("src-tauri/src/commands/ui_server/tools.rs");
  const body = src.slice(
    src.indexOf("pub(super) fn tools()"),
    src.indexOf("pub(super) fn tool_names()"),
  );
  return [...body.matchAll(/tool\(\s*"(ui_[a-z_]+)"/g)].map((m) => m[1]);
}

function dispatchedTools(): string[] {
  const src = read("src/features/ui-actions/lib/ui-actions.ts");
  return [...src.matchAll(/case "(ui_[a-z_]+)":/g)].map((m) => m[1]);
}

/** The `enum` of `property` in the schema of Rust tool `name`. */
function rustEnum(name: string, property: string): string[] {
  const src = read("src-tauri/src/commands/ui_server/tools.rs");
  const start = src.indexOf(`"${name}",`);
  const next = src.indexOf("tool(", start);
  const body = src.slice(start, next === -1 ? undefined : next);
  const m = body.match(new RegExp(`"${property}": \\{ "type": "string", "enum": \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`no ${property} enum in ${name}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** The string members of a `const NAME = [ ... ]` or the keys of a
 *  `const NAME: Record<…> = { ... }` in a TS source file. */
function tsList(file: string, name: string): string[] {
  const src = read(file);
  const start = src.indexOf(`const ${name}`);
  if (start === -1) throw new Error(`no ${name} in ${file}`);
  const open = src.slice(start).search(/[[{]/) + start;
  const close = src.indexOf(src[open] === "[" ? "]" : "}", open);
  const body = src.slice(open + 1, close);
  return src[open] === "["
    ? [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1])
    : [...body.matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((x) => x[1]);
}

describe("UI action contract", () => {
  it("finds the tools on both sides", () => {
    expect(rustTools().length).toBeGreaterThanOrEqual(7);
  });

  it("every tool the model is offered is performed by the window, and nothing else", () => {
    expect([...dispatchedTools()].sort()).toEqual([...rustTools()].sort());
  });

  /// The model can only choose from the schema's enums, and the window only
  /// accepts its own lists; a value on one side alone is either refused
  /// forever or never offered.
  it.each([
    [
      "ui_open",
      "section",
      "src/features/settings/stores/settings-nav-store.ts",
      "SETTINGS_SECTIONS",
    ],
    ["ui_open", "type", "src/features/ui-actions/lib/ui-open.ts", "PLAIN_TABS"],
    ["ui_open", "target", "src/features/ui-actions/lib/ui-open.ts", "TARGETS"],
    ["ui_focus", "target", "src/features/ui-actions/lib/ui-focus.ts", "TARGETS"],
    ["ui_focus", "name", "src/features/ui-actions/lib/ui-focus.ts", "PANELS"],
    ["ui_chat", "op", "src/features/ui-actions/lib/ui-chat.ts", "OPS"],
  ])("%s.%s offers exactly what the window accepts", (tool, property, file, list) => {
    const offered = rustEnum(tool, property);
    expect(offered.length, "the schema enum parsed").toBeGreaterThan(1);
    expect([...offered].sort()).toEqual([...tsList(file, list)].sort());
  });

  /// A Space page is opened by two ids that Rust checks before the window is
  /// asked; a key renamed on one side would be refused, or read unchecked.
  it.each(["conversationId", "pageId"])(
    "ui_open's space_page id %s is offered, checked in Rust and read by the window",
    (key) => {
      const rust = read("src-tauri/src/commands/ui_server/tools.rs");
      const start = rust.indexOf('"ui_open",');
      const schema = rust.slice(start, rust.indexOf("tool(", start));
      expect(schema).toContain(`"${key}": { "type": "string" }`);
      const check = rust.slice(rust.indexOf("fn space_page_refusal"));
      expect(check.slice(0, check.indexOf("\n}\n"))).toContain(`"${key}"`);
      expect(read("src/features/ui-actions/lib/ui-open.ts")).toContain(`a.str("${key}")`);
    },
  );
});

/**
 * `ui_command` runs any global keybinding command by id, auto-approved. The
 * ADR-0012 surface is non-destructive by rule, so every global command an
 * agent can reach is listed here, reviewed. A new global command fails this
 * test until someone decides it is safe for an agent — or adds it to
 * `REFUSED` in ui-command.ts with the alternative to use.
 */
const REVIEWED_AGENT_COMMANDS = [
  "workspace.toggleSidebar",
  "app.settings",
  "app.capture",
  // Opens the session's checkout in the user's own editor; changes nothing.
  "app.openInEditor",
  "nav.commandPalette",
  "nav.filePicker",
  "nav.search",
  "nav.newTabPalette",
  "nav.layoutSwitcher",
  "usage.open",
  "hintNav.toggle",
  "panels.left",
  "panels.right",
  "panels.sessionDetails",
  "panels.teamChat",
  "panels.terminal",
  "panels.knowledge",
  "panels.zen",
  "tabs.openSurface",
  "tabs.newChat",
  "tabs.newChatIn",
  "tabs.newTerminal",
  "tabs.newUntitled",
  "tabs.prev",
  "tabs.next",
  "tabs.focus1",
  "tabs.focus2",
  "tabs.focus3",
  "tabs.focus4",
  "tabs.focus5",
  "tabs.focus6",
  "tabs.focus7",
  "tabs.focus8",
  "tabs.focus9",
  "split.new",
  "split.focusLeft",
  "split.focusRight",
  // Moves the column's tabs to its neighbour; closes nothing.
  "split.close",
  // Moves the open session to the Settled shelf; it stays listed, and the
  // same command (or Undo) brings it back. Refused mid-turn by the backend.
  "chat.settleSession",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomReset",
];

function refusedCommands(): string[] {
  const src = read("src/features/ui-actions/lib/ui-command.ts");
  const start = src.indexOf("const REFUSED");
  const body = src.slice(src.indexOf("{", src.indexOf("=", start)) + 1, src.indexOf("\n};", start));
  return [...body.matchAll(/^\s*"([\w.]+)":/gm)].map((m) => m[1]);
}

describe("ui_command reach", () => {
  it("refuses exactly the four ADR-0012 commands", () => {
    expect(refusedCommands().sort()).toEqual(
      ["chat.cycleAgent", "chat.cyclePermissionMode", "tabs.close", "workspace.add"].sort(),
    );
  });

  it("every refused id is a real command (a dead entry is a hole)", () => {
    const ids = new Set(ACTIONS.map((a) => a.id as string));
    for (const id of refusedCommands()) expect(ids.has(id), id).toBe(true);
  });

  it("every global command an agent can run has been reviewed", () => {
    const refused = new Set(refusedCommands());
    const reachable = ACTIONS.filter((a) => a.when === "global")
      .map((a) => a.id as string)
      .filter((id) => !refused.has(id));
    expect([...reachable].sort()).toEqual([...REVIEWED_AGENT_COMMANDS].sort());
  });
});
