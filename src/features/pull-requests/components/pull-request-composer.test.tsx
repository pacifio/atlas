// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useLayoutStore } from "@/features/layout/stores/layout-store";

import { watchPullRequestTabDrafts } from "../lib/pull-request-tab-drafts";
import { pullRequestKeys } from "../lib/pull-requests-queries";
import type { PrDetail, PrDiffResult } from "../lib/pull-requests-types";
import { reviewKeyOf, usePullRequestReviewStore } from "../stores/pull-request-review-store";
import { usePullRequestTabDraftStore } from "../stores/pull-request-tab-draft-store";
import { PullRequestComposer } from "./pull-request-composer";

const detail = {
  number: 3,
  state: "open",
  capabilities: { comment: true, actions: [], review: { verdicts: ["comment", "approve"] } },
  viewerPermissions: { comment: true, actions: [], verdicts: ["comment", "approve"] },
} as unknown as PrDetail;

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " one",
  "+two",
  "",
].join("\n");

function composer(client: QueryClient, tabId = "pull-request:/repo:3") {
  return (
    <QueryClientProvider client={client}>
      <PullRequestComposer
        tabId={tabId}
        repoPath="/repo"
        detail={detail}
        pendingAction={null}
        onCommentAction={vi.fn()}
      />
    </QueryClientProvider>
  );
}

const openComposer = () =>
  fireEvent.click(screen.getByRole("button", { name: /Comment on pull request|Review pull/ }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
  usePullRequestTabDraftStore.setState({ drafts: {} });
  usePullRequestReviewStore.setState({ drafts: {} });
});

describe("PullRequestComposer drafts", () => {
  it("keeps a half-typed comment across the tab unmounting and mounting", () => {
    const client = new QueryClient();
    const first = render(composer(client));
    openComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on this pull request" }), {
      target: { value: "Half a comment" },
    });
    first.unmount();

    render(composer(client));
    openComposer();
    expect(screen.getByRole("textbox", { name: "Comment on this pull request" })).toHaveProperty(
      "value",
      "Half a comment",
    );
  });

  it("drops a tab's drafts when the tab closes", () => {
    watchPullRequestTabDrafts();
    usePullRequestTabDraftStore.getState().actions.patch("pull-request:/repo:9", {
      comment: "gone soon",
    });
    // Any change to the tab list prunes drafts whose tab is not in it.
    act(() => useLayoutStore.setState({ tabs: [...useLayoutStore.getState().tabs] }));
    expect(usePullRequestTabDraftStore.getState().drafts["pull-request:/repo:9"]).toBeUndefined();
  });
});

describe("PullRequestComposer stale line comments", () => {
  it("lists a pending comment no longer on the diff, blocks the review, and discards it", () => {
    const client = new QueryClient();
    const page: PrDiffResult = {
      patch: PATCH,
      files: [],
      truncated: false,
      nextCursor: null,
      omittedFileStats: [],
    } as unknown as PrDiffResult;
    client.setQueryData(pullRequestKeys.diffPages("/repo", 3, null), {
      pages: [page],
      pageParams: [null],
    });
    const key = reviewKeyOf("/repo", 3);
    const actions = usePullRequestReviewStore.getState().actions;
    actions.add(key, {
      id: "ok",
      path: "src/a.ts",
      position: { kind: "added", newLine: 2 },
      body: "fine",
    });
    actions.add(key, {
      id: "stale",
      path: "src/a.ts",
      position: { kind: "added", newLine: 40 },
      body: "this line moved",
    });

    render(composer(client));
    fireEvent.click(screen.getByRole("button", { name: /Review pull request/ }));
    expect(screen.getByText(/no longer on the diff/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit review" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(usePullRequestReviewStore.getState().drafts[key]?.map((c) => c.id)).toEqual(["ok"]);
    expect(screen.queryByText(/no longer on the diff/)).toBeNull();
    expect(screen.getByRole("button", { name: "Submit review" })).toHaveProperty("disabled", false);
  });
});
