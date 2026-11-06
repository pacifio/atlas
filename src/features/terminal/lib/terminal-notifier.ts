/**
 * Terminal notifications: the terminal's source adapter onto the shared
 * notification pipeline (`@/features/notifications/lib`).
 *
 * Input is the parser's typed event stream (`TerminalEvent`), tagged with the
 * terminal's identity. `decideTerminalNotification` (pure, in
 * `terminal-notifier-rules.ts`) classifies it into a catalog kind and lets the
 * shared decision pick the channels — center, toast, OS banner, badge, sound;
 * `deliverNotification` performs them.
 *
 * Rules (defaults from Settings; see `prefsFromSettings`):
 *  - a command that exits non-zero → "failed", always (unless Ctrl-C);
 *  - a command that ran ≥ `minDurationMs` → "done";
 *  - a password prompt, a bell, or an OSC 9/777 message → "attention", which
 *    persists longer and marks the terminal as needing input until the command
 *    finishes or the user types into it;
 *  - a command that took the alternate screen (vim, htop) is a session, not a
 *    long command — never "done".
 * OS banners fire only when the user is away (window unfocused, or focused
 * and idle for 2 minutes). Suppression: nothing is shown when the terminal is on screen, the window is
 * focused and the user has interacted within the last 30 s — they are looking
 * at it. Failures and attention still land in the center as a record.
 *
 * Organisation-wide: every item carries the owning project and organisation,
 * so the center and the bell filter by the active org and a click can route to
 * the exact pane across projects (`jumpToTerminal`).
 */
import { create } from "zustand";
import { deliverNotification } from "@/features/notifications/lib/deliver";
import { computeAway, type NotificationEnv } from "@/features/notifications/lib/decide";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { projectIdForTab } from "@/features/chat/lib/tab-project";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import type { TerminalEvent, TerminalEventSink } from "./shell-integration";
import { collectPanes, findTerminal, useTerminalStore } from "../stores/terminal-store";
import { decideTerminalNotification, type TerminalCtx } from "./terminal-notifier-rules";

export {
  classifyTerminalEvent,
  decideTerminalNotification,
  type TerminalCtx,
  type TerminalNotificationKind,
} from "./terminal-notifier-rules";

// ── Live attention state (drives the bell's pulsing dot) ───────────────────

interface AttentionState {
  /** terminalId → kind, while a command is waiting on the user. */
  attention: Record<string, TerminalEvent extends { kind: infer K } ? K : string>;
  actions: {
    set: (terminalId: string, kind: string) => void;
    clear: (terminalId: string) => void;
  };
}

export const useTerminalAttention = create<AttentionState>((set) => ({
  attention: {},
  actions: {
    set: (terminalId, kind) => set((s) => ({ attention: { ...s.attention, [terminalId]: kind } })),
    clear: (terminalId) =>
      set((s) => {
        if (!(terminalId in s.attention)) return s;
        const next = { ...s.attention };
        delete next[terminalId];
        return { attention: next };
      }),
  },
}));

/** Any terminal, any project, waiting on the user. */
export const anyTerminalNeedsAttention = (s: AttentionState) => Object.keys(s.attention).length > 0;

// ── Environment ────────────────────────────────────────────────────────────

/** On screen = owning project is active AND the tab is the active tab of its
 *  column AND the terminal is the active one in its pane. Every pane of a
 *  split counts as visible. */
export function isTerminalVisible(tabId: string, terminalId: string, projectId?: string): boolean {
  const ws = useProjectStore.getState();
  if (projectId && projectId !== ws.activeProjectId) return false;
  const layout = useLayoutStore.getState();
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  if (layout.activeByGroup[tab.groupId ?? "main"] !== tabId) return false;
  const term = useTerminalStore.getState();
  const loc = findTerminal(term.tabs, terminalId);
  if (!loc || loc.tabId !== tabId) return false;
  const t = term.tabs[tabId];
  if (!t) return false;
  const pane = collectPanes(t.root).find((p) => p.id === loc.paneId);
  return !!pane && pane.activeTerminalId === terminalId;
}

// ── Sink + delivery ────────────────────────────────────────────────────────

/** One bell per terminal per 2 s. */
const lastBell = new Map<string, number>();
const BELL_INTERVAL_MS = 2_000;

/**
 * Build the parser's event sink for one terminal. Resolves the project and
 * organisation at EVENT time — the tab may not have been committed to a
 * project view when the parser was constructed.
 */
export function createTerminalEventSink(base: {
  terminalId: string;
  tabId: string;
}): TerminalEventSink {
  return (e) => {
    try {
      handleEvent(e, base);
    } catch (err) {
      console.warn("terminal notifier failed:", err);
    }
  };
}

function handleEvent(e: TerminalEvent, base: { terminalId: string; tabId: string }): void {
  // Attention bookkeeping first — it is independent of the notify rules.
  if (e.type === "commandFinished" || e.type === "commandStarted") {
    useTerminalAttention.getState().actions.clear(base.terminalId);
  } else if (e.type === "attention") {
    if (e.kind === "bell") {
      const now = Date.now();
      const last = lastBell.get(base.terminalId) ?? 0;
      if (now - last < BELL_INTERVAL_MS) return;
      lastBell.set(base.terminalId, now);
    }
    useTerminalAttention.getState().actions.set(base.terminalId, e.kind);
  }

  const { settings } = useSettingsStore.getState();
  if (!settings.notificationsEnabled) return;

  const ws = useProjectStore.getState();
  const projectId = projectIdForTab(base.tabId) ?? undefined;
  const project = projectId ? ws.projects.find((w) => w.id === projectId) : undefined;
  const ctx: TerminalCtx = {
    ...base,
    projectId,
    projectName: project?.name,
    orgId: project?.orgId,
  };
  const windowFocused = isWindowFocused();
  const sinceInputMs = Date.now() - lastInteraction();
  const env: NotificationEnv = {
    targetVisible: isTerminalVisible(base.tabId, base.terminalId, projectId),
    windowFocused,
    sinceInputMs,
    projectActive: !projectId || projectId === ws.activeProjectId,
    away: computeAway(windowFocused, sinceInputMs),
  };
  const decision = decideTerminalNotification(e, ctx, env, settings);
  if (decision) deliverNotification(decision);
}
