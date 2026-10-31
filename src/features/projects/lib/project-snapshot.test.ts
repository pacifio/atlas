import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { useGitStore } from "@/features/git/stores/git-store";
import { captureSnapshot, clearPanelStores, restoreSnapshot } from "./project-snapshot";

const gitData = () =>
  Object.fromEntries(Object.entries(useGitStore.getState()).filter(([k]) => k !== "actions"));
const initialGitData = () =>
  Object.fromEntries(
    Object.entries(useGitStore.getInitialState()).filter(([k]) => k !== "actions"),
  );

describe("clearPanelStores", () => {
  it("empties the git status left by a torn-down project", () => {
    useGitStore.setState({ branch: "torn-down", repoPath: "/torn-down" });

    clearPanelStores();

    expect(gitData()).toEqual(initialGitData());
  });

  it("keeps the actions, so the next project can still load", () => {
    const actions = useGitStore.getState().actions;
    clearPanelStores();
    expect(useGitStore.getState().actions).toBe(actions);
  });

  it("does not disturb a snapshot captured before it", () => {
    useGitStore.setState({ branch: "a" });
    captureSnapshot("p-a");
    clearPanelStores();
    expect(restoreSnapshot("p-a")).toBe(true);
    expect(useGitStore.getState().branch).toBe("a");
  });
});
