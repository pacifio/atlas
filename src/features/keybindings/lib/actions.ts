/**
 * The catalogue of every command a keybinding can be attached to.
 *
 * One entry per command, and the entry is the only place its id, label,
 * default chord and scope are written down. Before this existed the same
 * shortcut was declared three times — the `useHotkeys` array in `App.tsx`, the
 * `shortcut:` strings in the command palette, and the printed table in
 * Settings — and they had already drifted (Settings documented ⌘⌥B as "Toggle
 * Status Bar"; it toggles the bottom panel).
 *
 * Ids are kebab-case and dot-free on purpose: they are the literal keys of the
 * `[keymap.bindings]` table in `config.toml`, and a dot there would make TOML
 * read `tabs.close` as a nested table rather than a key someone can type.
 */

import type { TabType } from "@/lib/constants";

/**
 * Where a binding is live.
 *
 * `global` fires anywhere; the rest fire only while their surface holds the
 * focused pane, which is what lets ⌘F mean "find in this chat", "find in this
 * terminal" and "find in this page" without any of them knowing about the
 * others.
 */
export type KeybindingScope = "global" | "editor" | "chat" | "terminal" | "knowledge";

/**
 * The scope a tab type puts on the stack while it is the focused column's
 * active tab. Tab types absent here (browser, tasks, settings, …) have no
 * scoped commands, so only `global` bindings are live over them.
 *
 * Deliberately keyed off the layout store's active tab rather than
 * `document.activeElement`: clicking a non-focusable element inside a pane
 * moves *pane* focus without moving DOM focus, and a focus-element check would
 * then leave the keyboard with the pane the user just left — the bug
 * `usePaneFind` documents and works around today.
 */
const SCOPE_BY_TAB_TYPE: Partial<Record<TabType, KeybindingScope>> = {
  chat: "chat",
  editor: "editor",
  diff: "editor",
  terminal: "terminal",
  knowledge: "knowledge",
};

export function scopeForTabType(type: TabType | undefined): KeybindingScope | null {
  return type ? (SCOPE_BY_TAB_TYPE[type] ?? null) : null;
}

export interface ActionDef {
  id: string;
  /** Shown in Settings, and in the command palette for the entries that have
   *  one. */
  label: string;
  /** Settings grouping — display only, never persisted. */
  group: string;
  scope: KeybindingScope;
  /** Atlas's own default chord in wire format (see `combo.ts`), or null for a
   *  command that ships unbound and exists so a preset or a user can bind it.
   *
   *  An array binds several chords to the one command, which some commands
   *  genuinely need: on a US layout ⌘+ arrives as ⇧=, and an editor that only
   *  binds one of the two is an editor where zoom sometimes doesn't work. */
  binding: Chord;
}

/** A command's chord, chords, or deliberate absence of one. */
export type Chord = string | readonly string[] | null;

/**
 * Commands, grouped. `group` and `scope` are declared once per group rather
 * than per command: every command in a group shares both, and repeating them
 * on all ~50 entries only creates places for them to disagree.
 */
const CATALOGUE = [
  {
    group: "General",
    scope: "global",
    actions: [
      { id: "command-palette", label: "Command Palette", binding: "mod+k" },
      { id: "file-picker", label: "Go to File", binding: "mod+p" },
      { id: "global-search", label: "Global Search", binding: "mod+shift+f" },
      { id: "open-settings", label: "Settings", binding: "mod+," },
      { id: "open-capture", label: "Open Session Capture", binding: "mod+alt+c" },
      { id: "new-tab-palette", label: "New Tab Palette", binding: "mod+alt+n" },
      { id: "layout-switcher", label: "Switch Layout", binding: "mod+alt+l" },
      { id: "zoom-in", label: "Zoom In", binding: ["mod+=", "mod+shift+="] },
      { id: "zoom-out", label: "Zoom Out", binding: "mod+-" },
      { id: "zoom-reset", label: "Reset Zoom", binding: "mod+0" },
    ],
  },
  {
    group: "Workspaces",
    scope: "global",
    actions: [
      { id: "workspace-add", label: "Add Workspace", binding: "mod+shift+n" },
      // ⌘. alone is the macOS system "Cancel" chord and never reaches the
      // webview, which is why the default carries Shift.
      { id: "workspace-toggle-sidebar", label: "Toggle Workspace Sidebar", binding: "mod+shift+." },
    ],
  },
  {
    group: "Tabs",
    scope: "global",
    actions: [
      { id: "new-chat", label: "New Chat", binding: "mod+t" },
      { id: "new-terminal", label: "New Terminal", binding: "mod+shift+t" },
      { id: "new-editor", label: "New Untitled Editor", binding: "mod+n" },
      { id: "close-tab", label: "Close Tab", binding: "mod+w" },
      { id: "previous-tab", label: "Previous Tab", binding: "mod+shift+[" },
      { id: "next-tab", label: "Next Tab", binding: "mod+shift+]" },
      { id: "activate-tab-1", label: "Go to Tab 1", binding: "mod+1" },
      { id: "activate-tab-2", label: "Go to Tab 2", binding: "mod+2" },
      { id: "activate-tab-3", label: "Go to Tab 3", binding: "mod+3" },
      { id: "activate-tab-4", label: "Go to Tab 4", binding: "mod+4" },
      { id: "activate-tab-5", label: "Go to Tab 5", binding: "mod+5" },
      { id: "activate-tab-6", label: "Go to Tab 6", binding: "mod+6" },
      { id: "activate-tab-7", label: "Go to Tab 7", binding: "mod+7" },
      { id: "activate-tab-8", label: "Go to Tab 8", binding: "mod+8" },
      // ⌘9 is "last tab", not "ninth tab" — the browser convention Atlas
      // already followed before any of this was configurable.
      { id: "activate-last-tab", label: "Go to Last Tab", binding: "mod+9" },
    ],
  },
  {
    group: "Splits",
    scope: "global",
    actions: [
      { id: "split-right", label: "Split Right", binding: "mod+\\" },
      { id: "focus-split-left", label: "Focus Split Left", binding: "alt+;" },
      { id: "focus-split-right", label: "Focus Split Right", binding: "alt+'" },
      { id: "close-split", label: "Close Split", binding: "alt+w" },
      { id: "toggle-zen-mode", label: "Toggle Zen Mode", binding: "alt+z" },
    ],
  },
  {
    group: "Panels",
    scope: "global",
    actions: [
      { id: "toggle-left-panel", label: "Toggle Left Panel", binding: "mod+b" },
      { id: "toggle-right-panel", label: "Toggle Right Panel", binding: "mod+shift+b" },
      // Shares the right slot with source control: this swaps the occupant
      // rather than opening a second panel.
      { id: "toggle-team-chat", label: "Toggle Team Chat", binding: "mod+shift+c" },
      { id: "toggle-bottom-panel", label: "Toggle Bottom Panel", binding: "mod+alt+b" },
      { id: "toggle-terminal", label: "Toggle Terminal", binding: "mod+j" },
      { id: "toggle-agent-sidebar", label: "Toggle Agent Sidebar", binding: "mod+alt+j" },
      { id: "toggle-tab-bar", label: "Toggle Tab Bar", binding: "mod+alt+t" },
      { id: "open-knowledge", label: "Open Knowledge Base", binding: "alt+j" },
    ],
  },
  {
    group: "Chat",
    scope: "chat",
    actions: [
      { id: "chat-find", label: "Find in Chat", binding: "mod+f" },
      { id: "chat-cycle-permission-mode", label: "Cycle Permission Mode", binding: "shift+tab" },
      { id: "chat-cycle-agent", label: "Cycle Coding Agent", binding: "alt+/" },
    ],
  },
  {
    group: "Editor",
    scope: "editor",
    actions: [{ id: "editor-save", label: "Save File", binding: "mod+s" }],
  },
  {
    group: "Knowledge Base",
    scope: "knowledge",
    actions: [
      { id: "knowledge-toggle-sidebar", label: "Toggle Sidebar", binding: "mod+;" },
      { id: "knowledge-toggle-inspector", label: "Toggle Inspector", binding: "mod+'" },
      { id: "knowledge-find", label: "Find in Page", binding: "mod+f" },
      { id: "knowledge-save", label: "Save Note", binding: "mod+s" },
    ],
  },
  {
    group: "Terminal",
    scope: "terminal",
    actions: [
      { id: "terminal-copy", label: "Copy Selection", binding: "mod+c" },
      { id: "terminal-paste", label: "Paste", binding: "mod+v" },
      { id: "terminal-select-all", label: "Select All", binding: "mod+a" },
      { id: "terminal-find", label: "Find in Terminal", binding: "mod+f" },
    ],
  },
] as const satisfies ReadonlyArray<{
  group: string;
  scope: KeybindingScope;
  actions: ReadonlyArray<{ id: string; label: string; binding: Chord }>;
}>;

export type ActionId = (typeof CATALOGUE)[number]["actions"][number]["id"];

/** The catalogue as Settings lists it: groups in declaration order, commands
 *  in theirs. */
export const ACTION_GROUPS: ReadonlyArray<{ group: string; actions: readonly ActionDef[] }> =
  CATALOGUE.map((g) => ({
    group: g.group,
    actions: g.actions.map((a) => ({ ...a, group: g.group, scope: g.scope })),
  }));

export const ACTIONS: readonly ActionDef[] = ACTION_GROUPS.flatMap((g) => g.actions);

export const ACTION_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.id, a]));

export function isActionId(id: string): id is ActionId {
  return ACTION_BY_ID.has(id);
}
