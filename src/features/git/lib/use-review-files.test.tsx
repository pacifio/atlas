// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DiffFileStat, DiffSource } from "./git-review-api";

const getDiffFilePatch = vi.fn();
vi.mock("./git-review-api", () => ({
  getDiffFilePatch: (...a: unknown[]) => getDiffFilePatch(...a),
}));

import { MAX_WATCHED, useReviewFiles } from "./use-review-files";

const FILES = 3000;

const stat = (i: number): DiffFileStat =>
  ({
    path: `src/f${i}.ts`,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    sig: `s${i}`,
  }) as DiffFileStat;

// No patch: every file is past the source's cap and loads on its own.
const source = {
  kind: "working",
  baseRef: null,
  mergeBase: null,
  diff: "",
  files: Array.from({ length: FILES }, (_, i) => stat(i)),
} as unknown as DiffSource;

describe("useReviewFiles", () => {
  it("keeps the cached and watched patches bounded however many files a review requests", async () => {
    getDiffFilePatch.mockResolvedValue({ patch: "", truncated: false, binary: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useReviewFiles({ repoPath: "/repo", source, ignoreWhitespace: false }),
      { wrapper },
    );

    for (let start = 0; start < FILES; start += 100) {
      await act(async () => {
        for (let i = start; i < start + 100; i++) result.current.requestFile(`src/f${i}.ts`);
      });
    }
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    const queries = client.getQueryCache().getAll();
    const watched = queries.filter((q) => q.getObserversCount() > 0);
    // The render window plus the first batch; the rest went idle and were
    // pruned to the idle cap.
    expect(watched.length).toBeLessThanOrEqual(MAX_WATCHED + 4);
    expect(queries.length).toBeLessThanOrEqual(MAX_WATCHED + 4 + 48);
    // The most recent requests are the ones that loaded.
    const last = result.current.files.find((f) => f.stat.path === `src/f${FILES - 1}.ts`);
    expect(last?.state).toBe("empty");
  });
});
