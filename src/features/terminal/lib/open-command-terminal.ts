// Open a terminal tab that runs a command.
//
// An agent's terminal-auth command goes to the workspace terminal rather than
// being spawned directly. The reason is stdin: a login CLI that
// asks a question — a provider picker, a device-code confirmation, a y/n —
// cannot be answered by a process spawned with pipes, and Atlas spawns auth
// runs with stdin closed outright. A real PTY can be typed into.
//
// The command is QUEUED rather than exec'd: the tab is created here, its PTY is
// created later by the panel, and the terminal writes the queued line into the
// user's own interactive shell once it exists.

import { groupOf, useLayoutStore } from "@/features/layout/stores/layout-store";
import { useTerminalStore } from "../stores/terminal-store";

/** POSIX-quote a token so a path with spaces survives reaching a shell. */
export function shellQuote(token: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

/** A name that can appear to the left of `=` in a shell assignment.
 *
 *  These names come out of the AGENT's own JSON and land in a line that is
 *  typed into a real shell, so a name is not a string to be quoted but a syntax
 *  position to be validated. Quoting cannot save it: `'X; rm -rf ~'=1` is not
 *  an assignment at all, it is a command. Anything that is not a plain
 *  identifier is dropped. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Render a program, its arguments and its environment as one shell line.
 *
 *  The environment here is only what the AGENT DECLARED for this login, never
 *  the environment the agent is spawned with — that one carries the user's
 *  whole environment and their BYOK keys, and this string is displayed, copied
 *  and typed into a shell that records its history. See `TerminalAuthCommand`.
 */
export function shellLine(
  command: string,
  args: string[] = [],
  env: [string, string][] = [],
): string {
  const assignments = env
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [...assignments, command, ...args]
    .map((part, i) => (i < assignments.length ? part : shellQuote(part)))
    .join(" ");
}

/** A terminal opened to run one command, and enough to take it away again. */
export interface CommandTerminal {
  /** The layout tab the command landed in. */
  tabId: string;
  /** The terminal minted for the command — the one to close. */
  terminalId: string;
  /** Whether that tab was CREATED for this command. When it was, closing it
   *  whole is right; when the user already had a terminal tab open, only our
   *  own terminal may be taken. */
  createdTab: boolean;
}

/** Open a terminal and run `command` in it, or `null` when no terminal could be
 *  reached.
 *
 *  Deliberately reads back which tab is active instead of trusting the id it
 *  asked for. A terminal tab is a SINGLETON PER COLUMN: when one is already
 *  open, `addTab` focuses that one and never creates the requested tab, and
 *  even when it does create one it rewrites the id to keep it unique. Queuing
 *  against the id we asked for therefore usually queued against a tab that
 *  would never exist — the terminal opened, and nothing ran in it.
 */
export function openCommandTerminal(
  command: string,
  title: string,
  opts?: { execute?: boolean },
): CommandTerminal | null {
  const before = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
  useLayoutStore.getState().actions.addTab({
    id: `terminal-${Date.now()}`,
    type: "terminal",
    title,
    closable: true,
    dirty: false,
    data: {},
  });

  const after = useLayoutStore.getState();
  const tab = after.tabs.find((t) => t.id === after.activeTabId);
  if (!tab || tab.type !== "terminal") return null;

  // A terminal of its own, even in a tab that already has one: the existing
  // shell may be mid-command, and typing into it would interleave.
  // The mirror's owner; the panel records it again on mount if this is
  // unknown here. (No project-store import: that module registers Tauri
  // listeners at load, which this pure-ish helper's tests cannot host.)
  const terminalId = useTerminalStore
    .getState()
    .actions.addTerminalForCommand(tab.id, after.currentViewWsId ?? undefined);
  useTerminalStore.getState().actions.setPendingCommand(terminalId, command, opts);
  useTerminalStore.getState().actions.requestTerminalFocus(tab.id);
  return { tabId: tab.id, terminalId, createdTab: !before.has(tab.id) };
}

/** Take back what `openCommandTerminal` opened.
 *
 *  For a cancelled login this is not tidiness: the CLI is still ALIVE, mid-TUI,
 *  and the surface that could answer it has just gone away. Closing the
 *  terminal unmounts it, and that cleanup closes the PTY — the shell gets its
 *  HUP and the login dies with it, rather than sitting there holding a prompt
 *  nobody can reach.
 */
export function closeCommandTerminal(t: CommandTerminal): void {
  const terminal = useTerminalStore.getState().actions;
  if (t.createdTab) {
    // Ours to begin with — take the whole tab. Close the layout tab FIRST so
    // the panel unmounts: dropping the terminal tree while it is still mounted
    // makes it re-seed itself with a fresh shell (`initTab`).
    useLayoutStore.getState().actions.closeTab(t.tabId);
    terminal.removeTabs([t.tabId]);
    return;
  }
  // The tab was already the user's — only the terminal we added goes.
  terminal.closeTerminalById(t.terminalId);
}

/** Where a command terminal stands relative to the screen.
 *
 *  `"hidden"` is the one that matters: the tab is still open, just not the one
 *  showing in its column. `"closed"` and `"visible"` are deliberately NOT
 *  merged with it — a caller that hides UI while the terminal is out of sight
 *  must still show that UI when the terminal is gone outright, or the user is
 *  left with no way to finish or cancel whatever the terminal was for. */
export type CommandTerminalPresence = "visible" | "hidden" | "closed";

/**
 * Whether a command terminal is the tab currently showing in its column.
 *
 * Per COLUMN, not per window: Atlas splits into up to three, each with its own
 * active tab (`activeByGroup`). A terminal in the right-hand column is on
 * screen while the user types in a chat on the left, so keying this off the
 * focused tab would hide things about a terminal the user can plainly see.
 */
export function useCommandTerminalPresence(t: CommandTerminal | null): CommandTerminalPresence {
  return useLayoutStore((s) => {
    if (!t) return "closed";
    const tab = s.tabs.find((candidate) => candidate.id === t.tabId);
    if (!tab) return "closed";
    return s.activeByGroup[groupOf(tab)] === tab.id ? "visible" : "hidden";
  });
}
