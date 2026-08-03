// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { GithubRepo } from "@/features/github/types";

/**
 * Flow-level reference test: drives the panel the way a person does — type,
 * press Enter, click — and asserts both what reaches the IPC boundary and what
 * the panel renders back.
 *
 * Everything below the component is faked (`invoke`, the project store, the
 * log) so the test needs no Tauri process and runs on any OS. That is the
 * deliberate trade: this catches component logic and wiring, not rendering
 * fidelity. Whether `search_github` and `clone_github_repo` exist at all is
 * covered once for the whole app by `tests/ipc-contract.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logEvent: vi.fn(),
  openUrl: vi.fn(),
  currentProject: null as { path: string } | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/features/project/stores/project-store", () => ({
  useProjectStore: { use: { currentProject: () => mocks.currentProject } },
}));

const { GithubPanel } = await import("./github-panel");

function repo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  return {
    name: "atlas",
    full_name: "ahammadnafiz/atlas",
    description: "An agentic desktop workspace",
    html_url: "https://github.com/ahammadnafiz/atlas",
    clone_url: "https://github.com/ahammadnafiz/atlas.git",
    language: "Rust",
    stars: 1234,
    forks: 56,
    updated_at: "2026-06-15T12:00:00Z",
    ...overrides,
  };
}

/** Type into the search box and submit, as a user would. */
async function search(term: string) {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/search github repositories/i), `${term}{Enter}`);
  return user;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.logEvent.mockReset();
  mocks.openUrl.mockReset();
  mocks.currentProject = null;
});

afterEach(() => {
  cleanup();
});

describe("searching", () => {
  it("shows an empty state before anything is typed", () => {
    render(<GithubPanel />);
    expect(screen.getByText("Search for repositories")).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("sends the trimmed query to search_github on Enter", async () => {
    mocks.invoke.mockResolvedValue([]);
    render(<GithubPanel />);
    await search("  tauri  ");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("search_github", { query: "tauri" }),
    );
  });

  it.each([
    ["an empty query", ""],
    ["a whitespace-only query", "   "],
  ])("does not call the backend for %s", async (_label, term) => {
    render(<GithubPanel />);
    await search(term);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("renders each result with its star and fork counts", async () => {
    mocks.invoke.mockResolvedValue([repo()]);
    render(<GithubPanel />);
    await search("atlas");
    expect(await screen.findByText("ahammadnafiz/atlas")).toBeInTheDocument();
    // Thousands separator comes from `toLocaleString`.
    expect(screen.getByText(/1,234/)).toBeInTheDocument();
    expect(screen.getByText(/56/)).toBeInTheDocument();
  });

  it("distinguishes 'no matches' from the initial empty state", async () => {
    mocks.invoke.mockResolvedValue([]);
    render(<GithubPanel />);
    await search("nothing-matches-this");
    expect(await screen.findByText("No repositories found")).toBeInTheDocument();
    expect(screen.queryByText("Search for repositories")).not.toBeInTheDocument();
  });
});

describe("when the search fails", () => {
  it("surfaces the backend error instead of an empty list", async () => {
    mocks.invoke.mockRejectedValue("GitHub API rate limit exceeded");
    render(<GithubPanel />);
    await search("atlas");
    expect(await screen.findByText(/rate limit exceeded/i)).toBeInTheDocument();
    expect(screen.queryByText("No repositories found")).not.toBeInTheDocument();
  });

  it("retries the same query and clears the error on success", async () => {
    mocks.invoke.mockRejectedValueOnce("network down").mockResolvedValueOnce([repo()]);
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("ahammadnafiz/atlas")).toBeInTheDocument();
    expect(screen.queryByText("network down")).not.toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("drops stale results when a later search errors", async () => {
    mocks.invoke.mockResolvedValueOnce([repo()]).mockRejectedValueOnce("boom");
    render(<GithubPanel />);
    const user = await search("atlas");
    await screen.findByText("ahammadnafiz/atlas");

    await user.type(screen.getByPlaceholderText(/search github/i), "{Enter}");

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("ahammadnafiz/atlas")).not.toBeInTheDocument();
  });
});

describe("cloning", () => {
  const CLONE = "Clone to .atlas/repos/";

  it("offers no clone button without an open project", async () => {
    // There is nowhere to clone to, so the affordance must not appear at all.
    mocks.currentProject = null;
    mocks.invoke.mockResolvedValue([repo()]);
    render(<GithubPanel />);
    await search("atlas");
    await screen.findByText("ahammadnafiz/atlas");
    expect(screen.queryByTitle(CLONE)).not.toBeInTheDocument();
  });

  it("clones into the open project, flattening the slash in the directory name", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    mocks.invoke.mockResolvedValueOnce([repo()]).mockResolvedValueOnce(undefined);
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByTitle(CLONE));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenLastCalledWith("clone_github_repo", {
        projectPath: "/Users/dev/myproject",
        cloneUrl: "https://github.com/ahammadnafiz/atlas.git",
        // `owner/repo` would otherwise be read as a nested path on disk.
        repoName: "ahammadnafiz-atlas",
      }),
    );
  });

  it("marks the repo cloned and refuses a second clone", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    mocks.invoke.mockResolvedValueOnce([repo()]).mockResolvedValue(undefined);
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByTitle(CLONE));

    const done = await screen.findByTitle("Cloned");
    expect(done).toBeDisabled();
    const afterFirstClone = mocks.invoke.mock.calls.length;
    await user.click(done);
    expect(mocks.invoke).toHaveBeenCalledTimes(afterFirstClone);
  });

  it("notifies the rest of the app so the file tree refreshes", async () => {
    mocks.currentProject = { path: "/Users/dev/myproject" };
    mocks.invoke.mockResolvedValueOnce([repo()]).mockResolvedValueOnce(undefined);
    const cloned = vi.fn();
    window.addEventListener("atlas:repo-cloned", cloned);
    try {
      render(<GithubPanel />);
      const user = await search("atlas");
      await user.click(await screen.findByTitle(CLONE));
      await waitFor(() => expect(cloned).toHaveBeenCalledTimes(1));
      expect(mocks.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ source: "github", kind: "clone" }),
      );
    } finally {
      window.removeEventListener("atlas:repo-cloned", cloned);
    }
  });

  it("re-enables the button when the clone fails", async () => {
    // A failed clone previously left the row stuck in its spinner state.
    mocks.currentProject = { path: "/Users/dev/myproject" };
    mocks.invoke.mockResolvedValueOnce([repo()]).mockRejectedValueOnce("permission denied");
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<GithubPanel />);
    const user = await search("atlas");

    await user.click(await screen.findByTitle(CLONE));

    await waitFor(() => expect(screen.getByTitle(CLONE)).toBeEnabled());
    expect(screen.queryByTitle("Cloned")).not.toBeInTheDocument();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
