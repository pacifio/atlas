// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { invoke, toastError } = vi.hoisted(() => ({ invoke: vi.fn(), toastError: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { resetGhGateForTests } from "./pr-errors";
import {
  detailStaleTime,
  invalidatePullRequestQueries,
  pullRequestKeys,
  STALE,
  usePrDetail,
} from "./pull-requests-queries";
import { FLUSH_DELAY_MS, usePullRequestFilesViewed } from "./use-pull-request-files-viewed";
import type { PrDetail, PrFilesViewed } from "./pull-requests-types";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
  toastError.mockReset();
  resetGhGateForTests();
});

describe("pull-request queries", () => {
  it("keeps a merged pull request fresh longest and one with running checks shortest", () => {
    const detail = (patch: Partial<PrDetail>) =>
      ({ state: "open", checksState: null, ...patch }) as PrDetail;
    expect(detailStaleTime(undefined)).toBe(STALE.detail);
    expect(detailStaleTime(detail({ state: "merged" }))).toBe(STALE.mergedDetail);
    expect(detailStaleTime(detail({ checksState: "pending" }))).toBe(STALE.checks);
    expect(detailStaleTime(detail({ checksState: "passing" }))).toBe(STALE.detail);
  });

  it("files every read under its checkout, so one call marks them all stale", async () => {
    const client = new QueryClient();
    client.setQueryData(pullRequestKeys.detail("/a", 1), { n: 1 });
    client.setQueryData(pullRequestKeys.list("/a", {}), { n: 2 });
    client.setQueryData(pullRequestKeys.detail("/b", 1), { n: 3 });
    await invalidatePullRequestQueries(client, "/a");
    expect(client.getQueryState(pullRequestKeys.detail("/a", 1))?.isInvalidated).toBe(true);
    expect(client.getQueryState(pullRequestKeys.list("/a", {}))?.isInvalidated).toBe(true);
    expect(client.getQueryState(pullRequestKeys.detail("/b", 1))?.isInvalidated).toBe(false);
  });

  it("does not retry a signed-out gh", async () => {
    invoke.mockRejectedValue({ kind: "notAuthenticated" });
    const client = new QueryClient();
    const { result } = renderHook(() => usePrDetail("/repo", 9), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual({ kind: "notAuthenticated" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("asks nothing without a checkout or a number", () => {
    const client = new QueryClient();
    renderHook(() => usePrDetail(null, 9), { wrapper: wrapper(client) });
    renderHook(() => usePrDetail("/repo", null), { wrapper: wrapper(client) });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("viewed files, kept by GitHub", () => {
  const read = (
    states: Record<string, PrFilesViewed["files"][number]["state"]>,
  ): PrFilesViewed => ({
    files: Object.entries(states).map(([path, state]) => ({ path, state })),
    truncated: false,
  });
  let host: PrFilesViewed;
  let writes: unknown[];
  let refuse: boolean;

  beforeEach(() => {
    host = read({ "a.ts": "unviewed", "b.ts": "viewed", "c.ts": "dismissed" });
    writes = [];
    refuse = false;
    invoke.mockImplementation(async (cmd: string, args: { files?: unknown }) => {
      if (cmd === "pr_files_viewed") return host;
      if (cmd === "pr_set_files_viewed") {
        writes.push(args.files);
        if (refuse) throw { kind: "network" };
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });
  });

  const mount = () =>
    renderHook(() => usePullRequestFilesViewed("/repo", 3, true), {
      wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });

  it("reads GitHub's marks, a dismissed one as changed and not viewed", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current?.isViewed("b.ts")).toBe(true));
    expect(result.current?.isViewed("a.ts")).toBe(false);
    expect(result.current?.isViewed("c.ts")).toBe(false);
    expect(result.current?.isStale("c.ts")).toBe(true);
  });

  it("shows presses at once and sends a run of them as one write", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current?.isViewed("b.ts")).toBe(true));
    vi.useFakeTimers();
    act(() => {
      result.current?.setViewed("a.ts", true);
      result.current?.setViewed("b.ts", false);
      result.current?.setViewed("c.ts", true);
    });
    expect(result.current?.isViewed("a.ts")).toBe(true);
    expect(result.current?.isViewed("b.ts")).toBe(false);
    // Pressed again, so no longer "Changed".
    expect(result.current?.isStale("c.ts")).toBe(false);
    expect(writes).toEqual([]);
    host = read({ "a.ts": "viewed", "b.ts": "unviewed", "c.ts": "viewed" });
    await act(async () => vi.advanceTimersByTime(FLUSH_DELAY_MS));
    vi.useRealTimers();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual([
      { path: "a.ts", viewed: true },
      { path: "b.ts", viewed: false },
      { path: "c.ts", viewed: true },
    ]);
    // The read that follows agrees, and the presses settle into it.
    await waitFor(() => expect(result.current?.isViewed("a.ts")).toBe(true));
    expect(result.current?.isViewed("b.ts")).toBe(false);
  });

  it("puts a press back, with a toast, when GitHub refuses the write", async () => {
    refuse = true;
    const { result } = mount();
    await waitFor(() => expect(result.current?.isViewed("b.ts")).toBe(true));
    act(() => result.current?.setViewed("a.ts", true));
    expect(result.current?.isViewed("a.ts")).toBe(true);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(result.current?.isViewed("a.ts")).toBe(false);
  });

  it("sends what was pressed when the pull request is left inside the pause", async () => {
    const { result, unmount } = mount();
    await waitFor(() => expect(result.current?.isViewed("b.ts")).toBe(true));
    act(() => result.current?.setViewed("a.ts", true));
    unmount();
    await waitFor(() => expect(writes).toEqual([[{ path: "a.ts", viewed: true }]]));
  });

  it("is off, and reads nothing, when the host has no viewed marks", () => {
    const { result } = renderHook(() => usePullRequestFilesViewed("/repo", 3, false), {
      wrapper: wrapper(new QueryClient()),
    });
    expect(result.current).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
