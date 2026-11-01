// @vitest-environment happy-dom
//
// The title bar's remote-control pill: nothing until the session has a room;
// then the room's state, and a menu whose items follow the room — Take over
// only while someone else drives, Share only while the room is solo and an
// organisation is in front. The menu calls Rust and decides nothing itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: unknown) => {
    // The mirror asks for every room on mount; the menu's own calls are
    // what the tests read.
    if (cmd === "rc_status") return Promise.resolve([]);
    invoked.push([cmd, args]);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HintGroup } from "@/ui/hint-group";
import type { RcRoom } from "../lib/rc-api";
import { useChatStore } from "../stores/chat-store";
import { useRcStore } from "../stores/rc-store";
import { RcHeaderMenu } from "./rc-header-menu";

const TAB = "tab-1";
const SESSION = "sess-1";

function room(patch: Partial<RcRoom> = {}): RcRoom {
  return {
    sessionId: SESSION,
    roomId: "01ROOM",
    scope: null,
    viewerUrl: "https://app.example.invalid/rc/rooms/01ROOM",
    state: "live",
    ownerOnline: true,
    viewers: 2,
    driver: { id: "user_owner", name: null, isOwner: true, lost: false },
    pending: [],
    lastError: null,
    endReason: null,
    ...patch,
  };
}

const ada = { id: "user_member", name: "Ada", isOwner: false, lost: false };

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
  useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
});
afterEach(cleanup);

const mount = () =>
  render(
    <HintGroup>
      <RcHeaderMenu tabId={TAB} />
    </HintGroup>,
  );

describe("RcHeaderMenu", () => {
  it("renders nothing while the session has no room", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Remote control" })).toBeNull();
  });

  it("shows the room's state and viewer count once there is one", () => {
    useRcStore.getState().actions.upsert(room());
    mount();
    const pill = screen.getByRole("button", { name: "Remote control" });
    expect(pill.textContent).toContain("Live");
    expect(pill.textContent).toContain("2");
  });

  it("offers Take over only while someone else drives, and takes it through Rust", async () => {
    useRcStore.getState().actions.upsert(room());
    const { unmount } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Remote control" }));
    expect(screen.queryByRole("menuitem", { name: /Take over/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Copy viewer link" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Stop remote control" })).toBeTruthy();
    // Solo room, but no organisation in front: nothing to share with.
    expect(screen.queryByRole("menuitem", { name: /Share with/ })).toBeNull();
    unmount();

    useRcStore.getState().actions.upsert(room({ driver: ada }));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Remote control" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Take over from Ada" }));
    expect(invoked).toEqual([["rc_take_over", { sessionId: SESSION }]]);
  });

  it("stops the room through Rust", async () => {
    useRcStore.getState().actions.upsert(room());
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Remote control" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Stop remote control" }));
    expect(invoked).toEqual([["rc_stop", { sessionId: SESSION }]]);
  });

  it("only offers to dismiss a room that has ended", async () => {
    useRcStore.getState().actions.upsert(room({ state: "ended" }));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Remote control" }));
    expect(screen.getByRole("menuitem", { name: "Dismiss" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Stop remote control" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Dismiss" }));
    expect(useRcStore.getState().bySession[SESSION]).toBeUndefined();
  });
});
