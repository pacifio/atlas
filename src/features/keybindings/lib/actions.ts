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
 * NOT in the registry (fixed, not user-rebindable): the file view editor's
 * own keymap (undo, indent, find next…; `@pierre/diffs`), Tiptap's editing
 * shortcuts, xterm's copy/paste handler,
 * the terminal readline keys (`terminal-keymap.ts`), the native menu bar's
 * AppKit items (Copy, Paste, Hide, Quit…), arrow-key navigation inside
 * palettes/lists, and the Escape-to-close handlers.
 *
 * The menu bar's other items ARE these actions (`src-tauri/menu.json`): they
 * run through `runAction` and show the chord bound here, so renaming an id
 * used there fails `tests/menu-model.test.ts`.
 */

export type When =
  | "global"
  | "terminalFocus"
  | "chatFocus"
  | "editorFocus"
  | "knowledgePanel"
  | "knowledgeFocus"
  | "pdfFocus"
  | "canvasFocus"
  | "diffFocus"
  | "pullRequestFocus"
  | "modelPicker";

export type ActionCategory =
  | "Project"
  | "Navigation"
  | "Panels"
  | "Tabs"
  | "Splits"
  | "View"
  | "Session"
  | "File"
  | "Terminal"
  | "Knowledge"
  | "PDF"
  | "Canvas"
  | "Review";

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
  editorFocus: "editorFocus",
  knowledgePanel: "knowledgeOpen",
  knowledgeFocus: "knowledgeFocus",
  pdfFocus: "pdfFocus",
  canvasFocus: "canvasFocus",
  diffFocus: "diffFocus",
  pullRequestFocus: "pullRequestFocus",
  modelPicker: "modelPickerOpen",
};

/** ⌘N picks the Nth visible row while the composer's model picker is open —
 *  the same chord as focusing tab N, which the open picker shadows. */
const modelPickerJump = (n: number): ActionDef => ({
  id: `modelPicker.jump${n}`,
  title: `Pick model ${n}`,
  category: "Session",
  when: "modelPicker",
  defaults: [`cmd+${n}`],
});

const focusTab = (n: number): ActionDef => ({
  id: `tabs.focus${n}`,
  title: n === 9 ? "Focus last tab" : `Focus tab ${n}`,
  category: "Tabs",
  when: "global",
  defaults: [`cmd+${n}`],
});

export const ACTIONS = [
  // ── Project ──
  // The two `workspace.*` ids are STORAGE KEYS, not concepts: a user's custom
  // bindings are keyed by action id in `keybindings.json`, so renaming one
  // silently drops their shortcut. Atlas calls these projects.
  {
    id: "workspace.add",
    title: "Add project…",
    category: "Project",
    when: "global",
    defaults: ["cmd+shift+n"],
  },
  {
    id: "workspace.toggleSidebar",
    title: "Toggle sidebar",
    category: "Project",
    when: "global",
    // ⌘⌥J was the session sidebar's; the sessions live in this one now.
    defaults: ["cmd+shift+.", "cmd+alt+j"],
  },
  {
    id: "app.settings",
    title: "Open Settings",
    category: "Project",
    when: "global",
    defaults: ["cmd+,"],
  },
  {
    id: "app.capture",
    title: "Open Session Capture",
    category: "Project",
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
  { id: "usage.open", title: "Open Usage", category: "Navigation", when: "global", defaults: [] },
  {
    id: "hintNav.toggle",
    title: "Hint navigation",
    category: "Navigation",
    when: "global",
    defaults: ["cmd+alt+space"],
  },
  // ── Panels ──
  {
    // The id predates the Files surface (it toggled the left file panel); it
    // is kept so a user's rebinding of ⌘B still applies. Same as `panels.right`.
    id: "panels.left",
    title: "Toggle Files",
    category: "Panels",
    when: "global",
    defaults: ["cmd+b"],
  },
  {
    id: "panels.right",
    title: "Toggle source control",
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
    id: "panels.knowledge",
    title: "Open Knowledge",
    category: "Panels",
    when: "global",
    defaults: ["alt+j"],
  },
  { id: "panels.zen", title: "Zen mode", category: "Panels", when: "global", defaults: ["alt+z"] },
  // ── Tabs ──
  // ⌘T opens a surface rather than one fixed kind of tab —
  // a pane beside a single column, or the focused column's `+` menu once the
  // window is split — and a bare letter then picks (⌘T A is a new agent).
  {
    id: "tabs.openSurface",
    title: "Open a surface",
    category: "Tabs",
    when: "global",
    defaults: ["cmd+t"],
  },
  {
    id: "tabs.newChat",
    title: "New session",
    category: "Tabs",
    when: "global",
    defaults: [],
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
    category: "Session",
    when: "global",
    defaults: ["alt+/"],
  },
  {
    // ⌘⌥S: ⌘⇧S is the model picker's pin, and while the picker is open it
    // would shadow this one.
    id: "chat.settleSession",
    title: "Settle or un-settle the open session",
    category: "Session",
    when: "global",
    defaults: ["cmd+alt+s"],
  },
  {
    id: "chat.cyclePermissionMode",
    title: "Cycle permission mode",
    category: "Session",
    when: "chatFocus",
    defaults: ["shift+tab"],
  },
  {
    id: "chat.find",
    title: "Find in session",
    category: "Session",
    when: "chatFocus",
    defaults: ["cmd+f"],
  },
  {
    id: "chat.toggleModelPicker",
    title: "Open model picker",
    category: "Session",
    when: "chatFocus",
    defaults: ["cmd+shift+m"],
  },
  {
    id: "modelPicker.previousProvider",
    title: "Previous agent in model picker",
    category: "Session",
    when: "modelPicker",
    defaults: ["cmd+shift+up"],
  },
  {
    id: "modelPicker.nextProvider",
    title: "Next agent in model picker",
    category: "Session",
    when: "modelPicker",
    defaults: ["cmd+shift+down"],
  },
  {
    // ⌘⇧S: "stick" (pin). Unbound anywhere else, and the reference ships no default.
    id: "modelPicker.toggleFavorite",
    title: "Pin or unpin the highlighted model",
    category: "Session",
    when: "modelPicker",
    defaults: ["cmd+shift+s"],
  },
  modelPickerJump(1),
  modelPickerJump(2),
  modelPickerJump(3),
  modelPickerJump(4),
  modelPickerJump(5),
  modelPickerJump(6),
  modelPickerJump(7),
  modelPickerJump(8),
  modelPickerJump(9),
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
  {
    id: "terminal.splitRight",
    title: "Split terminal right",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+d"],
  },
  {
    id: "terminal.splitDown",
    title: "Split terminal down",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+shift+d"],
  },
  {
    id: "terminal.closePane",
    title: "Close terminal pane",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+shift+w"],
  },
  {
    id: "terminal.focusPaneLeft",
    title: "Focus terminal pane to the left",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+alt+left"],
  },
  {
    id: "terminal.focusPaneRight",
    title: "Focus terminal pane to the right",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+alt+right"],
  },
  {
    id: "terminal.focusPaneUp",
    title: "Focus terminal pane above",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+alt+up"],
  },
  {
    id: "terminal.focusPaneDown",
    title: "Focus terminal pane below",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+alt+down"],
  },
  {
    id: "terminal.focusNextPane",
    title: "Focus next terminal pane",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+alt+]"],
  },
  {
    id: "terminal.focusPrevPane",
    title: "Focus previous terminal pane",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+alt+["],
  },
  {
    id: "terminal.zoomPane",
    title: "Zoom terminal pane",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+shift+enter"],
  },
  {
    id: "terminal.find",
    title: "Find in terminal",
    category: "Terminal",
    when: "terminalFocus",
    defaults: ["cmd+f"],
  },
  // ── File ──
  {
    id: "editor.save",
    title: "Save file",
    category: "File",
    when: "editorFocus",
    defaults: ["cmd+s"],
  },
  {
    // The file's own find and replace: the editor's panel, over the whole
    // document rather than the rows on screen.
    id: "editor.find",
    title: "Find in file",
    category: "File",
    when: "editorFocus",
    defaults: ["cmd+f"],
  },
  // ── Review ──
  {
    // The review diff's own find: matches across every changed file, folded
    // ones included. Its tab, not the session beside it, owns ⌘F.
    id: "diff.find",
    title: "Find in diff",
    category: "Review",
    when: "diffFocus",
    defaults: ["cmd+f"],
  },
  {
    // A pull request tab's ⋯ menu shows both. ⇧⌘C is team chat everywhere
    // else; a pull request tab shadows it while it is the active tab.
    id: "pullRequest.copyLink",
    title: "Copy pull request link",
    category: "Review",
    when: "pullRequestFocus",
    defaults: ["cmd+shift+c"],
  },
  {
    id: "pullRequest.copyNumber",
    title: "Copy pull request number",
    category: "Review",
    when: "pullRequestFocus",
    defaults: ["cmd+shift+k"],
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
  "Project",
  "Navigation",
  "Panels",
  "Tabs",
  "Splits",
  "View",
  "Session",
  "File",
  "Terminal",
  "Knowledge",
  "PDF",
  "Canvas",
  "Review",
];
