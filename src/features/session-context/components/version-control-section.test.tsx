// @vitest-environment happy-dom
//
// A session that works in a pull request's worktree is not the repository
// the git store mirrors (the project's checkout). Its overlay must not offer
// the branch picker, push / pull / publish or Create PR, which would all act
// on the project's checkout; the session's own pull requests stay.

import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useGitStore } from "@/features/git/stores/git-store";
import { VersionControlSection } from "./version-control-section";

const PROJECT = "/work/acme";
const WORKTREE = "/Users/me/Library/Application Support/atlas/worktrees/acme-pr-42";

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "threads_history" ? [] : null));
  // The git store mirrors the project's checkout, on a branch ahead of its
  // upstream: in the project, the overlay would offer to push it.
  useGitStore.setState({
    repoPath: PROJECT,
    isRepo: true,
    branch: "main",
    ahead: 2,
    behind: 0,
    files: [],
    branchesFull: [
      {
        name: "main",
        isCurrent: true,
        isRemote: false,
        upstream: "origin/main",
      } as never,
    ],
  });
});
afterEach(() => cleanup());

function mount(workPath: string) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <VersionControlSection tabId={null} projectPath={PROJECT} workPath={workPath} />
    </QueryClientProvider>,
  );
}

describe("VersionControlSection in a worktree session", () => {
  it("leaves out every verb that would act on the project's checkout", async () => {
    mount(WORKTREE);
    await settle();
    expect(screen.queryByText(/^Push/)).toBeNull();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByRole("button", { name: "More git actions" })).toBeNull();
    // What belongs to the session stays.
    expect(screen.getByText("Link a pull request…")).toBeTruthy();
    expect(screen.getByText("View all pull requests")).toBeTruthy();
    // And no pull request list was asked for by the project's branch.
    expect(invoke).not.toHaveBeenCalledWith("pr_list", expect.anything());
  });

  it("offers them in the project's own checkout", async () => {
    mount(PROJECT);
    await settle();
    expect(screen.getByRole("button", { name: "More git actions" })).toBeTruthy();
  });
});
