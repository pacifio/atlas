// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../lib/open-pull-request-tab", () => ({ openPullRequestTab: vi.fn() }));
// happy-dom lays nothing out, so the virtualizer would draw no rows: every
// item is "on screen", which is the worst case for the prefetch effect.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; getItemKey: (i: number) => string | number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: opts.getItemKey(index),
        start: index * 40,
        size: 40,
      })),
    getTotalSize: () => opts.count * 40,
  }),
}));

import { resetGhGateForTests } from "../lib/pr-errors";
import type { PrListEntry, PrListResult, PrProvider } from "../lib/pull-requests-types";
import { AUTO_PAGES_WHILE_FILTERED, PullRequestListPanel } from "./pull-request-list-panel";

const provider = {
  kind: "github",
  host: "github.com",
  repository: "acme/shop",
  viewer: "me",
  capabilities: {},
} as unknown as PrProvider;

function entry(number: number): PrListEntry {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    author: { login: "someone" },
    headBranch: `b${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    reviewDecision: null,
    checksState: null,
    commentCount: 0,
  } as unknown as PrListEntry;
}

function page(numbers: number[], nextCursor: string | null): PrListResult {
  return { provider, entries: numbers.map(entry), nextCursor };
}

const listCalls = () => invoke.mock.calls.filter(([name]) => name === "pr_list");
const lastListQuery = () => {
  const calls = listCalls();
  return calls[calls.length - 1]?.[1].query;
};

function renderPanel() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PullRequestListPanel repoPath="/repo" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  resetGhGateForTests();
});

describe("PullRequestListPanel paging", () => {
  it("does not ask for a failed next page again on its own, and offers Retry", async () => {
    invoke.mockImplementation(async (name: string, args: { query?: { cursor?: string } }) => {
      if (name === "pr_provider") return provider;
      if (name === "pr_list") {
        if (!args.query?.cursor) return page([1, 2, 3], "p2");
        throw { kind: "failed", message: "boom" };
      }
      return null;
    });
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    // Long enough for a loop to have spun many times over.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listCalls()).toHaveLength(2);

    fireEvent.click(retry);
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(listCalls()).toHaveLength(3);
  });

  it("pages on its own at most a few times while a review or checks filter is on", async () => {
    localStorage.setItem(
      "atlas.pullRequests.listPreferences",
      JSON.stringify({ filters: { checks: "failing" } }),
    );
    let served = 0;
    invoke.mockImplementation(async (name: string) => {
      if (name === "pr_provider") return provider;
      if (name === "pr_list") {
        served += 1;
        // Nothing matches the filter, so the end of the list stays in view.
        return page([served * 10], `p${served + 1}`);
      }
      return null;
    });
    renderPanel();
    await waitFor(() => expect(listCalls()).toHaveLength(AUTO_PAGES_WHILE_FILTERED), {
      timeout: 4000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listCalls()).toHaveLength(AUTO_PAGES_WHILE_FILTERED);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(listCalls()).toHaveLength(AUTO_PAGES_WHILE_FILTERED + 1));
  });
});

describe("PullRequestListPanel search qualifiers", () => {
  it("sends typed labels, exclusions and draft to the host, and the words as the search", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "pr_provider") return provider;
      if (name === "pr_list") return page([1], null);
      return [];
    });
    renderPanel();
    await screen.findByRole("list", { name: "Pull requests" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search pull requests" }), {
      target: { value: "cart label:bug,ui label:api -label:wip draft:false review:approved" },
    });
    await waitFor(
      () =>
        expect(lastListQuery()).toMatchObject({
          search: "cart",
          labels: ["api"],
          labelGroups: [["bug", "ui"]],
          excludedLabels: ["wip"],
          draft: "hide",
        }),
      { timeout: 2000 },
    );
    expect(lastListQuery()).not.toHaveProperty("review");
  });

  it("reads the line-count breakdowns for the rows on screen in one batch", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "pr_provider") return provider;
      if (name === "pr_list") return page([5, 6, 7], null);
      return [];
    });
    renderPanel();
    await screen.findByRole("list", { name: "Pull requests" });
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([name]) => name === "pr_list_stats")).toHaveLength(1),
    );
    const [, args] = invoke.mock.calls.find(([name]) => name === "pr_list_stats")!;
    expect([...args.numbers].sort()).toEqual([5, 6, 7]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Rows that were answered for are not asked about again.
    expect(invoke.mock.calls.filter(([name]) => name === "pr_list_stats")).toHaveLength(1);
  });

  it("paints the last list at once on reopen, then asks the host again", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "pr_provider") return provider;
      if (name === "pr_list") return page([41, 42], null);
      return [];
    });
    const first = renderPanel();
    await screen.findByRole("button", { name: /#41/ });
    first.unmount();

    let answer: (value: PrListResult) => void = () => {};
    invoke.mockImplementation(async (name: string) => {
      if (name === "pr_provider") return provider;
      if (name === "pr_list") return new Promise<PrListResult>((resolve) => (answer = resolve));
      return [];
    });
    renderPanel();
    expect(await screen.findByRole("button", { name: /#42/ })).toBeTruthy();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));
    answer(page([43], null));
    expect(await screen.findByRole("button", { name: /#43/ })).toBeTruthy();
  });
});
