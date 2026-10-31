// @vitest-environment happy-dom
//
// A pull request watch wake notifies unless its session is the one in view —
// including a session no tab shows, which is named from its history row and
// opens from there.

import { beforeEach, describe, expect, it, vi } from "vitest";

const threadProjects = vi.hoisted(() => vi.fn());
const deliverNotification = vi.hoisted(() => vi.fn((_decision: unknown) => true));
vi.mock("@/features/chat/lib/history-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  threadProjects,
}));
vi.mock("./deliver", () => ({
  deliverNotification,
  notificationToastId: vi.fn(),
  openNotificationTarget: vi.fn(),
}));
vi.mock("@/lib/window-focus", () => ({
  isWindowFocused: () => true,
  lastInteraction: () => Date.now(),
}));

import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { notifyPullRequestWatch } from "./agent-notifier";

const wake = {
  sessionId: "acp-1",
  threadId: "thread-1",
  summary: "#12: checks failed",
  at: "2026-10-24T10:00:00Z",
};

const historyRow = {
  threadId: "thread-1",
  sessionId: "acp-1",
  agentId: "claude-acp",
  title: "Fix the build",
  folderPaths: ["/work/atlas"],
};

function setSettings(over: Record<string, unknown>) {
  const { settings } = useSettingsStore.getState();
  useSettingsStore.setState({ settings: { ...settings, ...over } });
}

beforeEach(() => {
  deliverNotification.mockClear();
  threadProjects.mockReset();
  threadProjects.mockResolvedValue([
    { name: "atlas", paths: ["/work/atlas"], isCurrent: true, threads: [historyRow] },
  ]);
  useOrgStore.setState({ activeOrganisationId: "org-1" });
  useProjectStore.setState({
    projects: [{ id: "p-1", name: "atlas", path: "/work/atlas", orgId: "org-1" }],
    activeProjectId: "p-1",
  });
  useLayoutStore.setState({ tabs: [], activeTabId: null });
  useChatStore.setState({ sessions: {} });
  setSettings({ notificationsEnabled: true });
});

describe("notifyPullRequestWatch", () => {
  it("notifies for a session with no tab, named from history, opening by thread id", async () => {
    await notifyPullRequestWatch(wake);
    expect(deliverNotification).toHaveBeenCalledTimes(1);
    const decision = deliverNotification.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(decision).toMatchObject({
      kind: "pull-request-watch",
      title: expect.stringContaining("Fix the build"),
      body: "Pull request #12: checks failed — the agent is looking into it",
      target: {
        type: "session",
        tabId: "",
        sessionId: "acp-1",
        threadId: "thread-1",
        projectId: "p-1",
        orgId: "org-1",
      },
    });
  });

  it("still notifies when history does not list the session yet", async () => {
    threadProjects.mockResolvedValue([]);
    await notifyPullRequestWatch(wake);
    expect(deliverNotification).toHaveBeenCalledTimes(1);
    const decision = deliverNotification.mock.calls[0]![0] as unknown as {
      target: Record<string, unknown>;
    };
    expect(decision.target).toMatchObject({ tabId: "", threadId: "thread-1" });
  });

  it("stays quiet for the session in view", async () => {
    useLayoutStore.setState({
      tabs: [{ id: "chat-1", type: "chat", title: "Fix", closable: true, dirty: false, data: {} }],
      activeTabId: "chat-1",
    } as never);
    useChatStore.setState({
      sessions: { "chat-1": { acpSessionId: "acp-1", agentType: "claude-acp", title: "Fix" } },
    } as never);
    await notifyPullRequestWatch(wake);
    expect(deliverNotification).not.toHaveBeenCalled();
    expect(threadProjects).not.toHaveBeenCalled();
  });

  it("treats a session whose tab was closed as having no tab", async () => {
    // The chat store keeps a closed tab's session; only the layout knows.
    useChatStore.setState({
      sessions: { "chat-gone": { acpSessionId: "acp-1", agentType: "claude-acp", title: "x" } },
    } as never);
    useLayoutStore.setState({ tabs: [], activeTabId: "chat-gone" } as never);
    await notifyPullRequestWatch(wake);
    expect(deliverNotification).toHaveBeenCalledTimes(1);
  });

  it("respects the notification settings", async () => {
    setSettings({ notificationsEnabled: false });
    await notifyPullRequestWatch(wake);
    expect(deliverNotification).not.toHaveBeenCalled();
  });
});
