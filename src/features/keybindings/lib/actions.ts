/**
 * The action registry — the single source of truth for every rebindable
 * shortcut: its stable id, title, category, default chord(s) and the focus
 * context (`when`) it fires in. Settings → Keybindings renders this list, the
 * dispatchers resolve against it, and every shortcut label in the app reads
 * from it via `useActionShortcut`.
 *
 * Order here is display order and the dispatch precedence when two actions in
 * the same scope share a chord (first wins — allowed, but flagged as a
 * conflict in the editor).
 *
 * NOT in the registry (fixed, not user-rebindable): the CodeMirror keymap
 * (`editor-panel.tsx`), Tiptap's editing shortcuts, xterm's copy/paste handler,
 * the terminal readline keys (`terminal-keymap.ts`), the native menu bar
 * (`src-tauri/src/menu.rs`), arrow-key navigation inside palettes/lists, and
 * the Escape-to-close handlers.
 */

export type When =
  | "global"
  | "terminalFocus"
  | "chatFocus"
  | "knowledgePanel"
  | "knowledgeFocus"
  | "pdfFocus"
  | "canvasFocus";

export type ActionCategory =
  | "Workspace"
  | "Navigation"
  | "Panels"
  | "Tabs"
  | "Splits"
  | "View"
  | "Chat"
  | "Terminal"
  | "Knowledge"
  | "PDF"
  | "Canvas";

export interface ActionDef {
  id: string;
  title: string;
  category: ActionCategory;
  when: When;
  /** String-form combos (see `combo.ts`). Empty = unbound by default. */
  defaults: readonly string[];
}

/** Human label for a `when` context, as shown in the editor's When column. */
export const WHEN_LABELS: Record<When, string> = {
  global: "",
  terminalFocus: "terminalFocus",
  chatFocus: "chatFocus",
  knowledgePanel: "knowledgeOpen",
  knowledgeFocus: "knowledgeFocus",
  pdfFocus: "pdfFocus",
  canvasFocus: "canvasFocus",
};

const focusTab = (n: number): ActionDef => ({
  id: `tabs.focus${n}`,
  title: n === 9 ? "Focus last tab" : `Focus tab ${n}`,
  category: "Tabs",
  when: "global",
  defaults: [`cmd+${n}`],
});

export const ACTIONS = [
  // ── Workspace ──
  {
    id: "workspace.add",
    title: "Add workspace…",
    category: "Workspace",
    when: "global",
    defaults: ["cmd+shift+n"],
  },
  {
    id: "workspace.toggleSidebar",
    title: "Toggle workspace sidebar",
    category: "Workspace",
    when: "global",
    defaults: ["cmd+shift+."],
  },
  {
    id: "app.settings",
    title: "Open Settings",
    category: "Workspace",
    when: "global",
    defaults: ["cmd+,"],
  },
  {
    id: "app.capture",
    title: "Open Session Capture",
    category: "Workspace",
    when: "global",
    defaults: ["cmd+alt+c"],
  },
  // ── Navigation ──
  {
    id: "nav.commandPalette",
    title: "Command palette",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+k"],
  },
  {
    id: "nav.filePicker",
    title: "Go to file",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+p"],
  },
  {
    id: "nav.search",
    title: "Global search",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+shift+f"],
  },
  {
    id: "nav.newTabPalette",
    title: "New tab palette",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+alt+n"],
  },
  {
    id: "nav.layoutSwitcher",
    title: "Switch layout",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+alt+l"],
  },
  {
    id: "hintNav.toggle",
    title: "Hint navigation",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+alt+space"],
  },
  // ── Panels ──
  {
    id: "panels.left",
    title: "Toggle left panel",
    category: "Panels",
    when: "global",
    defaults: ["cmd+b"],
  },
  {
    id: "panels.right",
    title: "Toggle right panel (Source Control)",
    category: "Panels",
    when: "global",
    defaults: ["cmd+shift+b"],
  },
  {
    id: "panels.teamChat",
    title: "Toggle team chat",
    category: "Panels",
    when: "global",
    defaults: ["cmd+shift+c"],
  },
  {
    id: "panels.terminal",
    title: "Toggle terminal",
    category: "Panels",
    when: "global",
    defaults: ["cmd+j"],
  },
  {
    id: "panels.bottom",
    title: "Toggle status bar",
    category: "Panels",
    when: "global",
    defaults: ["cmd+alt+b"],
  },
  {
    id: "panels.agentSidebar",
    title: "Toggle agent sidebar",
    category: "Panels",
    when: "global",
    defaults: ["cmd+alt+j"],
  },
  {
    id: "panels.tabBar",
    title: "Toggle tab bar",
    category: "Panels",
    when: "global",
    defaults: ["cmd+alt+t"],
  },
  {
    id: "panels.knowledge",
    title: "Open Knowledge",
    category: "Panels",
    when: "global",
    defaults: ["alt+j"],
  },
  { id: "panels.zen", title: "Zen mode", category: "Panels", when: "global", defaults: ["alt+z"] },
  // ── Tabs ──
  {
    id: "tabs.newChat",
    title: "New agent chat",
    category: "Tabs",
    when: "global",
    defaults: ["cmd+t"],
  },
  {
    id: "tabs.newTerminal",
    title: "New terminal tab",
    category: "Tabs",
    when: "global",
    defaults: ["cmd+shift+t"],
  },
  {
    id: "tabs.newUntitled",
    title: "New untitled editor",
    category: "Tabs",
    when: "global",
    defaults: ["cmd+n"],
  },
  { id: "tabs.close", title: "Close tab", category: "Tabs", when: "global", defaults: ["cmd+w"] },
  {
    id: "tabs.prev",
    title: "Previous tab",
    category: "Tabs",
    when: "global",
    defaults: ["cmd+shift+["],
  },
  {
    id: "tabs.next",
    title: "Next tab",
    category: "Tabs",
    when: "global",
    defaults: ["cmd+shift+]"],
  },
  ...Array.from({ length: 9 }, (_, i) => focusTab(i + 1)),
  // ── Splits ──
  {
    id: "split.new",
    title: "Split right",
    category: "Splits",
    when: "global",
    defaults: ["cmd+\\"],
  },
  {
    id: "split.focusLeft",
    title: "Focus split left",
    category: "Splits",
    when: "global",
    defaults: ["alt+;"],
  },
  {
    id: "split.focusRight",
    title: "Focus split right",
    category: "Splits",
    when: "global",
    defaults: ["alt+'"],
  },
  {
    id: "split.close",
    title: "Close split",
    category: "Splits",
    when: "global",
    defaults: ["alt+w"],
  },
  // ── View ──
  {
    id: "view.zoomIn",
    title: "Zoom in",
    category: "View",
    when: "global",
    defaults: ["cmd+=", "cmd+shift+="],
  },
  { id: "view.zoomOut", title: "Zoom out", category: "View", when: "global", defaults: ["cmd+-"] },
  {
    id: "view.zoomReset",
    title: "Reset zoom",
    category: "View",
    when: "global",
    defaults: ["cmd+0"],
  },
  // ── Chat ──
  {
    id: "chat.cycleAgent",
    title: "Cycle coding agent",
    category: "Chat",
    when: "global",
    defaults: ["alt+/"],
  },
  {
    id: "chat.cyclePermissionMode",
    title: "Cycle permission mode",
    category: "Chat",
    when: "chatFocus",
    defaults: ["shift+tab"],
  },
  {
    id: "chat.find",
    title: "Find in chat",
    category: "Chat",
    when: "chatFocus",
    defaults: ["cmd+f"],
  },
  // ── Terminal ──
  {
    id: "terminal.prevTab",
    title: "Previous terminal tab",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+;"],
  },
  {
    id: "terminal.nextTab",
    title: "Next terminal tab",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+'"],
  },
  {
    id: "terminal.closeTab",
    title: "Close terminal tab",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+w"],
  },
  // ── Knowledge ──
  {
    id: "kb.toggleSidebar",
    title: "Toggle Knowledge sidebar",
    category: "Knowledge",
    when: "knowledgePanel",
    defaults: ["cmd+;"],
  },
  {
    id: "kb.toggleInspector",
    title: "Toggle Knowledge inspector",
    category: "Knowledge",
    when: "knowledgePanel",
    defaults: ["cmd+'"],
  },
  {
    id: "kb.focusFinder",
    title: "Find in Knowledge",
    category: "Knowledge",
    when: "knowledgeFocus",
    defaults: ["cmd+f"],
  },
  {
    id: "kb.save",
    title: "Save note",
    category: "Knowledge",
    when: "knowledgePanel",
    defaults: ["cmd+s"],
  },
  // ── PDF / Canvas ──
  {
    id: "pdf.save",
    title: "Save annotations",
    category: "PDF",
    when: "pdfFocus",
    defaults: ["cmd+s"],
  },
  {
    id: "canvas.undo",
    title: "Undo",
    category: "Canvas",
    when: "canvasFocus",
    defaults: ["cmd+z"],
  },
  {
    id: "canvas.redo",
    title: "Redo",
    category: "Canvas",
    when: "canvasFocus",
    defaults: ["cmd+shift+z", "cmd+y"],
  },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]["id"];

export const ACTION_BY_ID: Record<ActionId, ActionDef> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a]),
) as Record<ActionId, ActionDef>;

export const ACTION_IDS = new Set<string>(ACTIONS.map((a) => a.id));

export function isActionId(id: string): id is ActionId {
  return ACTION_IDS.has(id);
}

export const CATEGORY_ORDER: readonly ActionCategory[] = [
  "Workspace",
  "Navigation",
  "Panels",
  "Tabs",
  "Splits",
  "View",
  "Chat",
  "Terminal",
  "Knowledge",
  "PDF",
  "Canvas",
];
