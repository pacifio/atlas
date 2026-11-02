// @vitest-environment happy-dom
//
// The title bar's remote-control pill: nothing until the session has a room;
// then the room's state, and a panel whose controls follow the room — Take
// back control only while someone else drives, Hand control and Remove on the
// people here, Allow / Decline on a request, Invite and Let teammates drive
// only once the room is shared. The panel calls Rust and decides nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: unknown) => {
    // Reads answer empty; the panel's own changes are what the tests read.
    if (cmd === "rc_status" || cmd === "rc_members" || !cmd.startsWith("rc_")) {
      return Promise.resolve([]);
    }
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
import type { RcPeer, RcRoom } from "../lib/rc-api";
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
    startedAt: 0,
    state: "live",
    ownerOnline: true,
    viewers: 2,
    peers: [],
    acceptRequests: true,
    driver: { id: "user_owner", name: null, isOwner: true, lost: false },
    pending: [],
    memberTier: "view",
    lastError: null,
    endReason: null,
    ...patch,
  };
}

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

/** What the panel changed through Rust — reads left out. */
const rcCalls = () => invoked.filter(([cmd]) => cmd !== "rc_members");

const mount = () =>
  render(
    <HintGroup>
      <RcHeaderMenu tabId={TAB} />
    </HintGroup>,
  );

const priya = { id: "user_member", name: null, isOwner: false, lost: false };
const priyaHere: RcPeer = {
  id: "user_member",
  kind: "user",
  name: null,
  surfaces: ["web"],
  role: "visitor",
  tier: "steer",
  since: 1,
};
const shared = { scope: { orgId: "org_1", workspaceId: null } };
const open = () => userEvent.click(screen.getByRole("button", { name: "Remote control" }));

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

  it("offers Take back control only while someone else drives, and takes it through Rust", async () => {
    useRcStore.getState().actions.upsert(room());
    const { unmount } = mount();
    await open();
    expect(screen.queryByRole("button", { name: "Take back control" })).toBeNull();
    expect(screen.getByRole("button", { name: /Copy link/ })).toBeTruthy();
    // Solo room, no organisation in front: nothing to share with or invite.
    expect(screen.queryByRole("button", { name: /Share with/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    unmount();

    useRcStore.getState().actions.upsert(room({ driver: priya }));
    mount();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Take back control" }));
    expect(rcCalls()).toEqual([["rc_take_over", { sessionId: SESSION }]]);
  });

  it("stops the room through Rust", async () => {
    useRcStore.getState().actions.upsert(room());
    mount();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Stop remote control" }));
    expect(rcCalls()).toEqual([["rc_stop", { sessionId: SESSION }]]);
  });

  it("answers a request to drive", async () => {
    useRcStore.getState().actions.upsert(
      room({
        pending: [
          {
            requestId: "req-1",
            fromId: priya.id,
            fromName: "Priya",
            requestedAt: 1,
            expiresAt: 2,
          },
        ],
      }),
    );
    mount();
    await open();
    expect(screen.getByText("Priya asks to drive")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(rcCalls()).toEqual([
      ["rc_answer_control", { sessionId: SESSION, requestId: "req-1", approve: true }],
    ]);
  });

  it("hands control to, and removes, a person who is here", async () => {
    useRcStore.getState().actions.upsert(room({ peers: [priyaHere] }));
    mount();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Hand control to Someone else" }));
    expect(rcCalls()).toEqual([["rc_grant_control", { sessionId: SESSION, target: priya.id }]]);
  });

  it("offers no Hand control to someone who may only watch", async () => {
    useRcStore.getState().actions.upsert(room({ peers: [{ ...priyaHere, tier: "view" }] }));
    mount();
    await open();
    expect(screen.queryByRole("button", { name: /Hand control/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove Someone else" }));
    expect(rcCalls()).toEqual([["rc_kick", { sessionId: SESSION, target: priya.id }]]);
  });

  it("turns requests to drive off through Rust", async () => {
    useRcStore.getState().actions.upsert(room());
    mount();
    await open();
    await userEvent.click(screen.getByRole("switch", { name: "Accept requests to drive" }));
    expect(rcCalls()).toEqual([["rc_set_accept_requests", { sessionId: SESSION, accept: false }]]);
  });

  it("offers Invite and 'Let teammates drive' only once the room is shared", async () => {
    useRcStore.getState().actions.upsert(room(shared));
    mount();
    await open();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Let teammates drive" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(rcCalls()).toEqual([["rc_set_member_tier", { sessionId: SESSION, tier: "steer" }]]);
  });

  it("shows the tier the room carries, and turns it back to watching", async () => {
    useRcStore.getState().actions.upsert(room({ ...shared, memberTier: "steer" }));
    mount();
    await open();
    const toggle = screen.getByRole("switch", { name: "Let teammates drive" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(toggle);
    expect(rcCalls()).toEqual([["rc_set_member_tier", { sessionId: SESSION, tier: "view" }]]);
  });

  it("says how long the room has been live", async () => {
    useRcStore.getState().actions.upsert(room({ startedAt: Date.now() - 72 * 60_000 }));
    mount();
    await open();
    expect(screen.getByLabelText(/^Live for/).textContent).toMatch(/^1h 12m \d+s$/);
  });

  it("only offers to dismiss a room that has ended", async () => {
    useRcStore.getState().actions.upsert(room({ state: "ended" }));
    mount();
    await open();
    expect(screen.queryByRole("button", { name: "Stop remote control" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useRcStore.getState().bySession[SESSION]).toBeUndefined();
  });
});
