// @vitest-environment happy-dom
//
// The composer's remote-control seat notices: while someone else drives the
// strip names them and offers Take over; while a visitor asks, Allow and
// Decline answer the request. Both call Rust and decide nothing themselves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(() => [] as [string, unknown][]);
/** When set, every invoke hangs until `settle` is called with its outcome. */
const gate = vi.hoisted(() => ({
  hold: false,
  settle: null as ((err: Error | null) => void) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: unknown) => {
    invoked.push([cmd, args]);
    if (!gate.hold) return Promise.resolve(undefined);
    return new Promise<void>((resolve, reject) => {
      gate.settle = (err) => (err ? reject(err) : resolve());
    });
  }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RcRoom } from "../lib/rc-api";
import { useChatStore } from "../stores/chat-store";
import { useRcStore } from "../stores/rc-store";
import { RcDriverBar } from "./rc-driver-bar";
import { pillLabel } from "./rc-status-pill";
import type { RemoteControl } from "../lib/use-remote-control";

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
    viewers: 1,
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
  gate.hold = false;
  gate.settle = null;
  toast.error.mockClear();
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

describe("RcDriverBar", () => {
  it("renders nothing while the owner drives and nobody asks", () => {
    useRcStore.getState().actions.upsert(room());
    render(<RcDriverBar tabId={TAB} />);
    expect(screen.queryByTestId("rc-driver-bar")).toBeNull();
    expect(screen.queryByTestId("rc-request-bar")).toBeNull();
  });

  it("names the driver and takes the seat back through Rust", async () => {
    useRcStore.getState().actions.upsert(room({ driver: ada }));
    render(<RcDriverBar tabId={TAB} />);
    expect(screen.getByTestId("rc-driver-bar").textContent).toContain("Ada");
    await userEvent.click(screen.getByRole("button", { name: /Take over/ }));
    expect(invoked).toEqual([["rc_take_over", { sessionId: SESSION }]]);
  });

  it("answers a request to drive either way", async () => {
    useRcStore.getState().actions.upsert(
      room({
        pending: [
          { requestId: "req_1", fromId: "u2", fromName: "Bo", requestedAt: 1, expiresAt: 61 },
        ],
      }),
    );
    render(<RcDriverBar tabId={TAB} />);
    expect(screen.getByTestId("rc-request-bar").textContent).toContain("Bo");
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(invoked).toEqual([
      ["rc_answer_control", { sessionId: SESSION, requestId: "req_1", approve: true }],
      ["rc_answer_control", { sessionId: SESSION, requestId: "req_1", approve: false }],
    ]);
  });

  it("clears once the room ended", () => {
    useRcStore.getState().actions.upsert(room({ driver: ada, state: "ended" }));
    render(<RcDriverBar tabId={TAB} />);
    expect(screen.queryByTestId("rc-driver-bar")).toBeNull();
  });

  it("a driver the desktop cannot hear is not driving: no bar while the room is offline", () => {
    // The host socket is down; Take over could not reach the room, and Rust
    // frees the owner's composer for the same reason. The seat comes back
    // with the next welcome if they still hold it.
    useRcStore.getState().actions.upsert(room({ driver: ada, state: "offline" }));
    render(<RcDriverBar tabId={TAB} />);
    expect(screen.queryByTestId("rc-driver-bar")).toBeNull();
  });

  it("says so when Rust refuses a Take over, and holds the button meanwhile", async () => {
    gate.hold = true;
    useRcStore.getState().actions.upsert(room({ driver: ada }));
    render(<RcDriverBar tabId={TAB} />);
    const button = screen.getByRole("button", { name: /Take over/ });
    await userEvent.click(button);
    // A second click while Rust has not answered is not a second frame.
    await userEvent.click(button);
    expect(invoked.filter(([cmd]) => cmd === "rc_take_over")).toHaveLength(1);
    await act(async () => {
      gate.settle?.(new Error("the room is not connected right now"));
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain("not connected");
    // Answered: the button is live again.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts the requests waiting behind the first", () => {
    useRcStore.getState().actions.upsert(
      room({
        pending: [
          { requestId: "r1", fromId: "u2", fromName: "Bo", requestedAt: 1, expiresAt: 61 },
          { requestId: "r2", fromId: "u3", fromName: "Cy", requestedAt: 2, expiresAt: 62 },
        ],
      }),
    );
    render(<RcDriverBar tabId={TAB} />);
    expect(screen.getByTestId("rc-request-bar").textContent).toContain("1 more waiting");
  });
});

describe("pillLabel", () => {
  const control = (r: RcRoom | undefined, remoteDriver = null as RemoteControl["remoteDriver"]) =>
    ({ room: r, remoteDriver }) as RemoteControl;

  it("reads the link state, or the driver while it is someone else", () => {
    expect(pillLabel(control(room()))).toBe("Live");
    expect(pillLabel(control(room({ state: "offline" })))).toBe("Offline");
    expect(pillLabel(control(room({ driver: ada }), ada))).toBe("Ada driving");
    expect(pillLabel(control(room({ driver: ada, state: "connecting" }), ada))).toBe("Connecting");
  });
});
