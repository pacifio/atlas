// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  openPullRequestTab,
  pullRequestTabId,
  pullRequestTabTitle,
  readPullRequestTabData,
} from "./open-pull-request-tab";

const session = {
  id: "chat-1",
  type: "chat" as const,
  title: "session",
  closable: true,
  dirty: false,
  data: {},
};

const layout = () => useLayoutStore.getState();
const groupOf = (id: string) => layout().tabs.find((t) => t.id === id)?.groupId ?? "main";
const open = (number: number, title?: string) =>
  openPullRequestTab({ repoPath: "/repo", number, title });

beforeEach(() => {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  layout().actions.addTab(session);
});

describe("openPullRequestTab", () => {
  it("opens beside the session, keyed by checkout and number", () => {
    open(42, "Checkout");
    const id = pullRequestTabId("/repo", 42);
    expect(id).toBe("pull-request:/repo:42");
    expect(layout().groupOrder).toHaveLength(2);
    expect(groupOf(id)).not.toBe(groupOf("chat-1"));
    const tab = layout().tabs.find((t) => t.id === id);
    expect(tab?.title).toBe("#42 Checkout");
    expect(tab?.data).toEqual({ repoPath: "/repo", number: 42 });
  });

  it("focuses an open tab instead of opening another", () => {
    open(42);
    layout().actions.setActiveTab("chat-1");
    open(42);
    expect(layout().tabs.filter((t) => t.type === "pull-request")).toHaveLength(1);
    expect(layout().focusedGroupId).toBe(groupOf(pullRequestTabId("/repo", 42)));
  });

  it("puts a second pull request in the first one's column", () => {
    open(42);
    layout().actions.setActiveTab("chat-1");
    open(39);
    expect(layout().groupOrder).toHaveLength(2);
    expect(groupOf(pullRequestTabId("/repo", 39))).toBe(groupOf(pullRequestTabId("/repo", 42)));
  });

  it("uses an empty split before making another", () => {
    layout().actions.addGroup();
    const empty = layout().focusedGroupId;
    layout().actions.setActiveTab("chat-1");
    open(42);
    expect(layout().groupOrder).toHaveLength(2);
    expect(groupOf(pullRequestTabId("/repo", 42))).toBe(empty);
  });
});

describe("tab data", () => {
  it("restores only data that still names a pull request", () => {
    expect(readPullRequestTabData({ repoPath: "/repo", number: 7 })).toEqual({
      repoPath: "/repo",
      number: 7,
    });
    expect(readPullRequestTabData({ repoPath: "/repo", number: "7" })).toEqual({
      repoPath: "/repo",
      number: 7,
    });
    expect(readPullRequestTabData({ repoPath: "/repo", number: 0 })).toBeNull();
    expect(readPullRequestTabData({ number: 7 })).toBeNull();
  });

  it("titles the tab by number until the title is known", () => {
    expect(pullRequestTabTitle(7)).toBe("#7");
    expect(pullRequestTabTitle(7, "Fix")).toBe("#7 Fix");
  });
});
