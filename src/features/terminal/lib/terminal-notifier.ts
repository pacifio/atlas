/**
 * Terminal notifications: what to say, where to say it, and when to stay quiet.
 *
 * Input is the parser's typed event stream (`TerminalEvent`), tagged with the
 * terminal's identity. Output is up to four channels — the in-app notification
 * center, a toast, a native macOS notification, a chime — chosen by a PURE
 * decision function (`decideTerminalNotification`) that is unit-tested on its
 * own. Everything with a side effect sits in `deliver()`.
 *
 * Rules (defaults from Settings; see `terminalNotificationPrefs`):
 *  - a command that exits non-zero → "failed", always (unless Ctrl-C);
 *  - a command that ran ≥ `minDurationMs` → "done";
 *  - a password prompt, a bell, or an OSC 9/777 message → "attention", which
 *    persists longer and marks the terminal as needing input until the command
 *    finishes or the user types into it;
 *  - a command that took the alternate screen (vim, htop) is a session, not a
 *    long command — never "done".
 * Suppression: nothing is shown when the terminal is on screen, the window is
 * focused and the user has interacted within the last 30 s — they are looking
 * at it. Failures and attention still land in the center as a record.
 *
 * Organisation-wide: every item carries the owning workspace and organisation,
 * so the center and the bell filter by the active org and a click can route to
 * the exact pane across workspaces (`jumpToTerminal`).
 */
import { toast } from "sonner";
import { create } from "zustand";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { workspaceIdForTab } from "@/features/chat/lib/tab-workspace";
import { terminalNotificationPrefs } from "@/features/settings/lib/app-settings";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import { sendNativeNotification } from "@/lib/native-notify";
import { playChime } from "@/lib/chime";
import { setDockBadge } from "@/lib/dock-badge";
import type { TerminalEvent, TerminalEventSink } from "./block-parser";
import { collectPanes, findTerminal, useTerminalStore } from "../stores/terminal-store";
import { jumpToTerminal } from "./jump-to-terminal";

export {
  decideTerminalNotification,
  type Decision,
  type NotifierEnv,
  type TerminalCtx,
  type TerminalNotificationKind,
} from "./terminal-notifier-rules";
import {
  decideTerminalNotification,
  type Decision,
  type NotifierEnv,
  type TerminalCtx,
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

/** Any terminal, any workspace, waiting on the user. */
export const anyTerminalNeedsAttention = (s: AttentionState) => Object.keys(s.attention).length > 0;

// ── Environment ────────────────────────────────────────────────────────────

/** On screen = owning workspace is active AND the tab is the active tab of its
 *  column AND the terminal is the active one in its pane. Every pane of a
 *  split counts as visible. */
export function isTerminalVisible(
  tabId: string,
  terminalId: string,
  workspaceId?: string,
): boolean {
  const ws = useWorkspaceStore.getState();
  if (workspaceId && workspaceId !== ws.activeWorkspaceId) return false;
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

/** Bounded memory of what has already been announced. */
const announced = new Set<string>();
const ANNOUNCED_CAP = 500;
/** One bell per terminal per 2 s. */
const lastBell = new Map<string, number>();
const BELL_INTERVAL_MS = 2_000;

/**
 * Build the parser's event sink for one terminal. Resolves the workspace and
 * organisation at EVENT time — the tab may not have been committed to a
 * workspace view when the parser was constructed.
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

  const prefs = terminalNotificationPrefs(useProjectStore.getState().settings);
  if (!prefs.enabled) return;

  const ws = useWorkspaceStore.getState();
  const workspaceId = workspaceIdForTab(base.tabId) ?? undefined;
  const workspace = workspaceId ? ws.workspaces.find((w) => w.id === workspaceId) : undefined;
  const ctx: TerminalCtx = {
    ...base,
    workspaceId,
    workspaceName: workspace?.name,
    orgId: workspace?.orgId,
  };
  const env: NotifierEnv = {
    terminalVisible: isTerminalVisible(base.tabId, base.terminalId, workspaceId),
    windowFocused: isWindowFocused(),
    interactedWithinMs: Date.now() - lastInteraction(),
    workspaceActive: !workspaceId || workspaceId === ws.activeWorkspaceId,
  };
  const decision = decideTerminalNotification(e, ctx, env, prefs);
  if (!decision) return;
  if (announced.has(decision.dedupeKey)) return;
  announced.add(decision.dedupeKey);
  if (announced.size > ANNOUNCED_CAP) {
    const first = announced.values().next().value;
    if (first) announced.delete(first);
  }
  deliver(decision, ctx);
}

function deliver(d: Decision, ctx: TerminalCtx): void {
  if (d.channels.store) {
    useNotificationsStore.getState().actions.add({
      kind: d.kind,
      source: "terminal",
      title: d.title,
      body: d.body,
      tabId: ctx.tabId,
      terminalId: ctx.terminalId,
      workspaceId: ctx.workspaceId,
      orgId: ctx.orgId,
    });
    if (!isWindowFocused()) {
      const unread = useNotificationsStore.getState().items.filter((i) => !i.read).length;
      setDockBadge(unread);
    }
  }
  if (d.channels.toast) {
    const open = () =>
      void jumpToTerminal({
        tabId: ctx.tabId,
        terminalId: ctx.terminalId,
        workspaceId: ctx.workspaceId,
      });
    const opts = {
      id: `bg-terminal-${d.dedupeKey}`,
      description: d.body,
      duration: d.persistMs,
      action: { label: "Open", onClick: open },
    };
    if (d.kind === "terminal-failed") toast.error(d.title, opts);
    else if (d.kind === "terminal-done") toast.success(d.title, opts);
    else toast(d.title, opts);
  }
  if (d.channels.native) {
    void sendNativeNotification({
      title: `Atlas: ${ctx.workspaceName ?? "Terminal"}`,
      body: `${d.title} — ${d.body}`,
      sound: d.channels.sound ? "Ping" : undefined,
    });
  } else if (d.channels.sound) {
    playChime();
  }
}
