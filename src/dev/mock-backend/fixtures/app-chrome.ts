// Console triggers for the app chrome: the notification drawer, the Log tab,
// the feedback panel, the update modal and the welcome screen.
//
// None of these surfaces shows anything by sitting still in the default
// scenario: the drawer is empty and closed, the Log is a tab nobody opened,
// the feedback panel and the update modal wait for a user or an updater, and
// the welcome screen needs every tab gone. Each is one call away instead —
// `__atlasMock.actions.<name>()`.

import { useAppStore } from "@/features/app/stores/app-store";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  useNotificationsStore,
  type AppNotification,
} from "@/features/notifications/stores/notifications-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Eight items across four days: every leading-icon shape (agent badges, a
 *  third-party agent, source icons), read and unread, one three-line body. */
export function seedNotifications(): void {
  const now = Date.now();
  const at = (ago: number) => new Date(now - ago).toISOString();
  const items: AppNotification[] = [
    {
      id: "mock-n-1",
      kind: "agent-done",
      source: "agent",
      agentType: "claude-code",
      title: "Refactor the API client onto /v2",
      body: "Finished in 4m 12s — 6 files changed.",
      timestamp: at(5 * 60_000),
      read: false,
    },
    {
      id: "mock-n-2",
      kind: "permission",
      source: "agent",
      agentType: "claude-code",
      title: "Claude wants to run a command",
      body: "bun run test src/lib/api.test.ts",
      timestamp: at(20 * 60_000),
      read: false,
    },
    {
      id: "mock-n-3",
      kind: "agent-failed",
      source: "agent",
      agentType: "codex",
      title: "Turn failed",
      body: "The agent process exited before the turn finished.\nExit code 137 — the process was killed.\nCheck the agent's log for the last tool call it was running.",
      timestamp: at(2 * HOUR),
      read: false,
    },
    {
      id: "mock-n-4",
      kind: "terminal-attention",
      source: "terminal",
      title: "zsh is waiting for input",
      body: "Password:",
      timestamp: at(3 * HOUR),
      read: true,
    },
    {
      id: "mock-n-5",
      kind: "git-op-failed",
      source: "app",
      title: "Push rejected",
      body: "origin/main has 2 commits you do not have. Pull first.",
      timestamp: at(DAY + HOUR),
      read: true,
    },
    {
      id: "mock-n-6",
      kind: "agent-done",
      source: "agent",
      title: "Write the migration notes",
      body: "Done.",
      timestamp: at(DAY + 3 * HOUR),
      read: true,
    },
    {
      id: "mock-n-7",
      kind: "app-update-ready",
      source: "app",
      title: "Atlas 0.4.2 is ready",
      body: "Restart to finish updating.",
      timestamp: at(3 * DAY),
      read: true,
    },
    {
      id: "mock-n-8",
      kind: "model-download-done",
      source: "app",
      title: "Embedding model downloaded",
      body: "nomic-embed-text-v1.5 is ready for local memory.",
      timestamp: at(10 * DAY),
      read: true,
    },
  ];
  useNotificationsStore.setState({ items });
}

export function openNotifications(): void {
  useNotificationsStore.getState().actions.open(useOrgStore.getState().activeOrganisationId);
}

/** What the ⌘T surface menu adds for "Log". */
export function openLogTab(): void {
  useLayoutStore.getState().actions.addTab({
    id: "log",
    type: "log",
    title: "Log",
    closable: true,
    dirty: false,
    data: {},
  });
}

export function openFeedback(): void {
  useFeedbackStore.getState().actions.openPanel("settings");
}

export function updateReady(): void {
  useUpdaterStore.getState().actions.setReady("0.4.2");
}

export function updateError(): void {
  useUpdaterStore.getState().actions.setError("The update signature did not verify.");
}

/** The welcome screen is the centre with no project open, so leave the
 *  project (it stays in the recents list the screen shows). */
export function showWelcome(): void {
  useAppStore.getState().actions.setActiveProject(null);
}
