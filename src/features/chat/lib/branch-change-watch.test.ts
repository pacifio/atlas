// @vitest-environment happy-dom
//
// A turn that ends on another branch than it started on is recorded for the
// composer's strip; one that does not, or that started detached, is not; a
// new turn clears the last turn's notice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const git = vi.hoisted(() => ({ branch: "main", detached: false }));
vi.mock("@/features/git/lib/git-remote-api", () => ({
  checkoutState: vi.fn(async () => ({ branch: git.branch, detached: git.detached, dirty: false })),
}));

import { useChatStore } from "../stores/chat-store";
import { useBranchChangeStore } from "../stores/branch-change-store";
import { watchTurnBranchChanges } from "./branch-change-watch";

const status = (s: "running" | "waiting" | "idle") =>
  useChatStore.getState().actions.updateSessionStatus("tab", s);
const settle = () => new Promise((r) => setTimeout(r, 0));
const change = () => useBranchChangeStore.getState().changes.tab;

let unwatch: () => void;
beforeEach(() => {
  git.branch = "main";
  git.detached = false;
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useBranchChangeStore.setState({ changes: {} });
  const { actions } = useChatStore.getState();
  actions.createSession("tab", "claude-code");
  actions.setAcpBinding("tab", "agent-1", "acp-tab", "/proj");
  unwatch = watchTurnBranchChanges();
});
afterEach(() => unwatch());

describe("watchTurnBranchChanges", () => {
  it("records a turn that ends on another branch", async () => {
    status("running");
    await settle();
    git.branch = "feature/x";
    status("idle");
    await settle();
    expect(change()).toEqual({ cwd: "/proj", was: "main", now: "feature/x" });
  });

  it("records nothing when the branch is the same at both ends", async () => {
    status("running");
    await settle();
    status("idle");
    await settle();
    expect(change()).toBeUndefined();
  });

  it("does not split a turn at a permission wait", async () => {
    status("running");
    await settle();
    git.branch = "feature/x";
    status("waiting");
    await settle();
    expect(change()).toBeUndefined();
    status("idle");
    await settle();
    expect(change()?.was).toBe("main");
  });

  it("ignores a turn that started on a detached HEAD", async () => {
    git.detached = true;
    status("running");
    await settle();
    git.detached = false;
    git.branch = "feature/x";
    status("idle");
    await settle();
    expect(change()).toBeUndefined();
  });

  it("clears the notice when the next turn starts", async () => {
    status("running");
    await settle();
    git.branch = "feature/x";
    status("idle");
    await settle();
    expect(change()).toBeDefined();
    status("running");
    expect(change()).toBeUndefined();
  });
});
