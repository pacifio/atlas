// @vitest-environment happy-dom
//
// Version control reads the session's own checkout by path, never the git
// store (which mirrors the active project's checkout). A session in a pull
// request's worktree shows and acts on that worktree: its branch, its git
// action, its diff against the default branch.

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

const snapshot = (branch: string, files: string[]) => ({
  isRepo: true,
  branch,
  detached: false,
  upstream: `origin/${branch}`,
  ahead: 0,
  behind: 0,
  files: files.map((path) => ({ path, status: "modified", staged: false, conflicted: false })),
  branches: [{ name: branch, isCurrent: true, isRemote: false, upstream: `origin/${branch}` }],
  stashes: [],
  inProgress: null,
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const path = (args as { path?: string } | undefined)?.path;
    if (cmd === "git_snapshot")
      return path === WORKTREE ? snapshot("pr-42", ["src/a.ts"]) : snapshot("main", []);
    if (cmd === "git_branch_compare")
      return {
        defaultBranch: "main",
        isDefault: path !== WORKTREE,
        hasRemote: true,
        aheadOfDefault: path === WORKTREE ? 3 : 0,
        additions: path === WORKTREE ? 12 : 0,
        deletions: path === WORKTREE ? 4 : 0,
      };
    return cmd === "threads_history" || cmd === "pr_list" ? [] : null;
  });
  // The store mirrors the project's checkout: nothing here may read it.
  useGitStore.setState({ repoPath: PROJECT, isRepo: true, branch: "main", ahead: 2 });
});
afterEach(() => cleanup());

function mount(workPath: string) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <VersionControlSection
        tabId="tab-1"
        projectPath={PROJECT}
        workPath={workPath}
        compact={false}
      />
    </QueryClientProvider>,
  );
}

describe("VersionControlSection", () => {
  it("shows the worktree's branch and diff, not the project's", async () => {
    mount(WORKTREE);
    // Under a full run the snapshot can outlast one tick: wait for the row.
    expect(await screen.findByText("pr-42", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("−4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Git actions" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("git_snapshot", { path: WORKTREE });
    expect(invoke).not.toHaveBeenCalledWith("git_snapshot", { path: PROJECT });
  });

  it("shows nothing outside a repository", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "git_snapshot" ? { ...snapshot("", []), isRepo: false } : null,
    );
    mount(PROJECT);
    await settle();
    expect(screen.queryByRole("button", { name: "Git actions" })).toBeNull();
  });
});
