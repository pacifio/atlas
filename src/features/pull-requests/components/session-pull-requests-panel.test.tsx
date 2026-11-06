// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PullRequestLink, ThreadRow } from "@/features/chat/lib/history-api";

const { invoke, openTab, rows } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openTab: vi.fn(),
  rows: { current: [] as unknown[] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../lib/open-pull-request-tab", () => ({ openPullRequestTab: openTab }));
vi.mock("@/features/session-context/lib/session-lineage", () => ({
  useThreadHistory: () => rows.current,
}));

import { resetCheckoutCacheForTests } from "../lib/open-linked-pull-request";
import { resetGhGateForTests } from "../lib/pr-errors";
import { SessionPullRequestsPanel } from "./session-pull-requests-panel";

function link(number: number, head: string, base: string, watching = false): PullRequestLink {
  return {
    repository: "acme/shop",
    number,
    url: `https://github.com/acme/shop/pull/${number}`,
    source: "manual",
    linkedAt: "2026-10-01T00:00:00Z",
    watching,
    snapshot: {
      state: number === 3 ? "merged" : "open",
      title: `Change ${number}`,
      headBranch: head,
      baseBranch: base,
      isDraft: false,
      updatedAt: "2026-10-10T00:00:00Z",
      checksState: number === 1 ? "failing" : null,
      reviewDecision: null,
      commentCount: null,
      syncedAt: "2026-10-20T00:00:00Z",
    },
  };
}

function setLinks(pullRequests: PullRequestLink[]) {
  rows.current = [
    {
      threadId: "t1",
      folderPaths: ["/repo"],
      attachedProjects: [],
      pullRequests,
    } as unknown as ThreadRow,
  ];
}

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionPullRequestsPanel tabId="session-pull-requests:t1" threadId="t1" cwd="/repo" />
    </QueryClientProvider>,
  );
}

invoke.mockImplementation((name: string) => {
  if (name === "pr_provider") {
    return Promise.resolve({
      kind: "github",
      host: "github.com",
      repository: "acme/shop",
      viewer: "me",
      capabilities: { actions: ["close", "merge", "ready", "reopen"] },
    });
  }
  if (name === "pr_list_stats") return Promise.resolve([]);
  if (name === "session_pull_requests_sync") {
    return Promise.resolve({ read: 0, detected: 0, changed: 0, skipped: false });
  }
  return Promise.resolve(null);
});

afterEach(() => {
  cleanup();
  openTab.mockReset();
  resetGhGateForTests();
  resetCheckoutCacheForTests();
});

describe("SessionPullRequestsPanel", () => {
  it("lists the links with chains, the eye and the footer counts", () => {
    setLinks([link(1, "a", "main", true), link(2, "b", "a"), link(3, "z", "main")]);
    renderPanel();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(screen.getByTitle("2 pull requests chained by base branch")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Watching/)).toHaveLength(1);
    expect(screen.getByLabelText("Checks failing")).toBeTruthy();
    expect(screen.getByText(/2 open · 3 linked/)).toBeTruthy();
  });

  it("opens a row in its checkout, with the panel as the back arrow's target", async () => {
    setLinks([link(1, "a", "main")]);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Open pull request #1/ }));
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith({
        repoPath: "/repo",
        number: 1,
        title: "Change 1",
        openedFrom: "session-pull-requests:t1",
      }),
    );
  });

  it("asks for a link when there are none", () => {
    setLinks([]);
    renderPanel();
    expect(screen.getByText("No linked pull requests")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Link pull request/ })).toBeTruthy();
  });
});
