// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CodeGrepResult } from "@/components/code-search-api";

const mocks = vi.hoisted(() => ({ codeGrep: vi.fn() }));

vi.mock("@/components/code-search-api", () => ({ codeGrep: mocks.codeGrep }));
vi.mock("@/lib/open-file", () => ({ openFile: vi.fn() }));
vi.mock("@/features/explorer/stores/explorer-store", () => ({
  useExplorerStore: { use: { rootPath: () => "/repo" } },
}));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { use: { currentProject: () => null } },
}));
vi.mock("@/features/app/stores/session-store", () => ({
  useSessionStore: {
    use: {
      session: () => ({ searchHistory: [] }),
      actions: () => ({
        addSearchHistory: vi.fn(),
        removeSearchHistory: vi.fn(),
        clearSearchHistory: vi.fn(),
        saveSession: vi.fn(),
      }),
    },
  },
}));

const { SearchOverlay } = await import("./search-overlay");

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
afterEach(cleanup);

function answer(path: string): CodeGrepResult {
  return {
    matches: [{ path, line: 1, text: "needle" }],
    totalMatches: 1,
    totalFiles: 1,
    truncated: false,
    partial: false,
  };
}

describe("SearchOverlay", () => {
  it("keeps the newest search's results when an older one answers last", async () => {
    let resolveOld: (r: CodeGrepResult) => void = () => {};
    let resolveNew: (r: CodeGrepResult) => void = () => {};
    mocks.codeGrep
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockImplementationOnce(() => new Promise((r) => (resolveNew = r)));
    render(<SearchOverlay open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search in files..."), "needle{Enter}");
    await user.click(screen.getByRole("button", { name: "Use regular expression" }));
    expect(mocks.codeGrep).toHaveBeenCalledTimes(2);
    await act(async () => resolveNew(answer("new.ts")));
    await act(async () => resolveOld(answer("old.ts")));
    expect(screen.getByText("new.ts")).toBeTruthy();
    expect(screen.queryByText("old.ts")).toBeNull();
  });
});
