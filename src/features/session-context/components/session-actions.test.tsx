// @vitest-environment happy-dom
//
// The Session card's buttons act on the CLOUD copy of the thread, which exists
// only once the project is shared and the session captured. Off, they must say
// why on hover (so not `disabled`, which takes no hover), and Find — the
// thread's own search — must keep working either way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@/features/artifacts/lib/read-session-detail", () => ({
  readSessionDetail: vi.fn(async () => ({
    summary: { id: "row-1", title: "a session" },
    entries: [],
    counts: {},
    tools: [],
  })),
}));

const { SessionActions } = await import("./session-actions");
const { useChatCommentsStore } = await import("@/features/chat/stores/chat-comments-store");
const { useArtifactsStore } = await import("@/features/artifacts/stores/artifacts-store");
const { useLayoutStore } = await import("@/features/layout/stores/layout-store");

const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  useArtifactsStore.getState().actions.openSession(null);
  useChatCommentsStore.getState().actions.clear("t1");
});
afterEach(cleanup);

describe("SessionActions", () => {
  it("turns the cloud actions off for an unsynced thread, and keeps Find on", () => {
    const onOpenSearch = vi.fn();
    render(<SessionActions tabId="t1" projectPath="/p" onOpenSearch={onOpenSearch} />);
    for (const b of screen.getAllByRole("button", { name: /Share this project/ })) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.hasAttribute("disabled")).toBe(false);
    }
    expect(screen.getAllByRole("button", { name: /Share this project/ })).toHaveLength(3);
    fireEvent.click(button(/Find in session/));
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("opens the thread's session in the Timeline once it is synced", async () => {
    render(<SessionActions tabId="t1" projectPath="/p" />);
    await act(async () => {
      useChatCommentsStore
        .getState()
        .actions.setTarget("t1", { remoteProjectId: "rp-1", sessionId: "row-1" }, []);
    });
    fireEvent.click(button("Open in Timeline"));
    expect(useArtifactsStore.getState().open).toEqual({
      sessionId: "row-1",
      projectPath: "/p",
      remoteProjectId: "rp-1",
    });
    expect(useLayoutStore.getState().destination?.type).toBe("artifacts");
  });

  it("does nothing on a click while off", () => {
    render(<SessionActions tabId="t1" projectPath="/p" />);
    for (const b of screen.getAllByRole("button", { name: /Share this project/ })) {
      fireEvent.click(b);
    }
    expect(useArtifactsStore.getState().open).toBeNull();
    expect(document.querySelector(".t-morph")).toBeNull();
  });
});
