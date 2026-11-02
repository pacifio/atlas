// @vitest-environment happy-dom
//
// The Details card's Remote control section: Start is off, with the reason
// in its title, until the session has bound an agent; once bound it starts
// the room through Rust; while a room exists the row reports it instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: unknown) => {
    // The mirror asks for every room on mount; the section's own calls are
    // what the tests read.
    if (cmd === "rc_status") return Promise.resolve([]);
    invoked.push([cmd, args]);
    return Promise.resolve({ roomId: "01ROOM", scope: null, viewerUrl: "https://x", note: null });
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RcRoom } from "@/features/chat/lib/rc-api";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useRcStore } from "@/features/chat/stores/rc-store";
import { RemoteControlSection, START_LABEL, UNBOUND_HINT } from "./remote-control-section";

const TAB = "tab-1";
const SESSION = "sess-1";

beforeEach(() => {
  invoked.length = 0;
  useRcStore.setState({ bySession: {} });
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "codex");
});
afterEach(cleanup);

describe("RemoteControlSection", () => {
  it("keeps Start off, with the reason, until the agent has connected", async () => {
    render(<RemoteControlSection tabId={TAB} presentation="docked" />);
    const start = screen.getByRole("button", { name: START_LABEL });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.getAttribute("title")).toBe(UNBOUND_HINT);
    await userEvent.click(start);
    expect(invoked).toEqual([]);
  });

  it("starts the room through Rust once the session is bound", async () => {
    useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
    render(<RemoteControlSection tabId={TAB} presentation="docked" />);
    const start = screen.getByRole("button", { name: START_LABEL });
    expect(start.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(start);
    expect(invoked[0]?.[0]).toBe("rc_start");
    expect(invoked[0]?.[1]).toMatchObject({ sessionId: SESSION });
  });

  it("reports the room instead of offering Start while one exists", () => {
    useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
    const room: RcRoom = {
      sessionId: SESSION,
      roomId: "01ROOM",
      scope: null,
      viewerUrl: "https://x",
      state: "live",
      ownerOnline: true,
      viewers: 3,
      driver: { id: "user_owner", name: null, isOwner: true, lost: false },
      pending: [],
      memberTier: "view",
      lastError: null,
      endReason: null,
    };
    useRcStore.getState().actions.upsert(room);
    render(<RemoteControlSection tabId={TAB} presentation="docked" />);
    expect(screen.queryByRole("button", { name: START_LABEL })).toBeNull();
    expect(screen.getByText(/Live · 3 watching/)).toBeTruthy();
  });
});
