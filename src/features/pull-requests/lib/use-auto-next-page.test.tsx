// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resetGhGateForTests } from "./pr-errors";
import { usePrCommitPages } from "./pull-requests-queries";
import { useAutoNextPage } from "./use-auto-next-page";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

const commitCalls = () => invoke.mock.calls.filter(([name]) => name === "pr_commits");
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 250)));

afterEach(() => {
  invoke.mockReset();
  resetGhGateForTests();
});

describe("useAutoNextPage", () => {
  it("reads on while wanted, and stops for good at a failed page", async () => {
    invoke.mockImplementation(async (_name: string, args: { cursor: string | null }) => {
      if (args.cursor === null) return { commits: [], nextCursor: "c2" };
      if (args.cursor === "c2") return { commits: [], nextCursor: "c3" };
      throw { kind: "failed", message: "boom" };
    });
    // The Code tab's commit picker looking for a commit on no page.
    const { result } = renderHook(
      () => {
        const query = usePrCommitPages("/repo", 7);
        useAutoNextPage(query, true);
        return query;
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    await settle();
    expect(commitCalls()).toHaveLength(3);

    // A retry the reader asks for still goes out, once.
    await act(() => result.current.fetchNextPage());
    await settle();
    expect(commitCalls()).toHaveLength(4);
  });

  it("asks for nothing while not wanted", async () => {
    invoke.mockResolvedValue({ commits: [], nextCursor: "c2" });
    renderHook(
      () => {
        const query = usePrCommitPages("/repo", 7);
        useAutoNextPage(query, false);
        return query;
      },
      { wrapper },
    );
    await settle();
    expect(commitCalls()).toHaveLength(1);
  });
});
