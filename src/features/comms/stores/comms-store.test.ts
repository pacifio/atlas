// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The org-switch guards in the comms store. Every case here is an
// interleaving that used to leave the panel on the wrong org, empty, or with
// a message silently gone — see the switch comments in `comms-store.ts`.

const snapshot = vi.fn();
const send = vi.fn();
const openConversation = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  () => new Promise(() => {}),
);
const toastError = vi.fn();

vi.mock("../lib/comms-api", () => ({
  comms: {
    snapshot: (...args: unknown[]) => snapshot(...args),
    send: (...args: unknown[]) => send(...args),
    openConversation: (...args: unknown[]) => openConversation(...args),
    conversationSnapshot: vi.fn(),
    closeConversation: vi.fn(() => Promise.resolve()),
    typing: vi.fn(() => Promise.resolve()),
  },
  listenComms: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: {
    getState: () => ({ tabs: [], actions: { closeTab: vi.fn() } }),
  },
}));
vi.mock("@/features/spaces/stores/spaces-store", () => ({
  useSpacesStore: { getState: () => ({ actions: { clearAll: vi.fn() } }) },
}));

const { useCommsStore, commsActions, resetCommsSwitchStateForTests, pendingConvRetriesForTests } =
  await import("./comms-store");

type Env = Parameters<ReturnType<typeof commsActions>["applyEnvelope"]>[0];

const conv = (id: string) => ({ id }) as never;
const connectionEnvelope = (org: string, state: "open" | "connecting"): Env =>
  ({
    org,
    epoch: 1,
    ev: { kind: "connection", state, reason: null, retry_at_ms: null },
  }) as Env;
const conversationsEnvelope = (org: string, ids: string[]): Env =>
  ({
    org,
    epoch: 1,
    ev: {
      kind: "conversationsChanged",
      conversations: ids.map(conv),
      discoverable: [],
    },
  }) as Env;

const snapshotFor = (orgId: string | null, ids: string[], state = "open") => ({
  connection: { state, reason: null, epoch: 1, orgId },
  me: "u1",
  conversations: ids.map(conv),
  discoverable: [],
  reads: [],
  online: [],
  calls: [],
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetCommsSwitchStateForTests();
  commsActions().reset();
  snapshot.mockReset();
  send.mockReset();
  openConversation.mockReset();
  openConversation.mockImplementation(() => new Promise(() => {}));
  toastError.mockReset();
  useCommsStore.setState({
    connection: { state: "open", reason: null, epoch: 1, orgId: "org_a" },
    conversations: [conv("a1")],
    composers: {},
    tabs: [{ id: "tab_home", convId: null }],
  });
});

describe("org switch guards", () => {
  it("drops a straggler from the outgoing org once a switch is declared", () => {
    commsActions().beginSwitch("org_b");
    expect(useCommsStore.getState().conversations).toEqual([]);

    // Org A is still talking for a moment after the reset.
    commsActions().applyEnvelope(conversationsEnvelope("org_a", ["a1", "a2"]));
    expect(useCommsStore.getState().conversations).toEqual([]);

    commsActions().applyEnvelope(conversationsEnvelope("org_b", ["b1"]));
    expect(useCommsStore.getState().conversations.map((c) => c.id)).toEqual(["b1"]);
  });

  it("an unsynced target (null) drops every org-bearing envelope", () => {
    commsActions().beginSwitch(null);
    commsActions().applyEnvelope(connectionEnvelope("org_a", "open"));
    expect(useCommsStore.getState().connection.state).toBe("disconnected");
  });

  it("still adopts a Rust-driven retarget before any switch (boot reconciliation)", async () => {
    snapshot.mockResolvedValue(snapshotFor("org_b", ["b1"]));
    commsActions().applyEnvelope(connectionEnvelope("org_b", "open"));
    expect(useCommsStore.getState().connection.orgId).toBe("org_b");
    await flush();
    expect(useCommsStore.getState().conversations.map((c) => c.id)).toEqual(["b1"]);
  });

  it("discards a snapshot of the outgoing org taken before Rust was retargeted", async () => {
    commsActions().beginSwitch("org_b");
    // Rust still answers for A (or for nobody) at this point.
    snapshot.mockResolvedValueOnce(snapshotFor("org_a", ["a1"]));
    await commsActions().hydrate();
    expect(useCommsStore.getState().conversations).toEqual([]);

    snapshot.mockResolvedValueOnce(snapshotFor(null, [], "disconnected"));
    await commsActions().hydrate();
    expect(useCommsStore.getState().conversations).toEqual([]);

    snapshot.mockResolvedValueOnce(snapshotFor("org_b", ["b1"]));
    await commsActions().hydrate();
    expect(useCommsStore.getState().conversations.map((c) => c.id)).toEqual(["b1"]);
  });

  it("a hydrate that resolves after a newer one is discarded", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    snapshot
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(snapshotFor("org_a", ["a1", "a2"]));
    const first = commsActions().hydrate();
    await commsActions().hydrate();
    expect(useCommsStore.getState().conversations.map((c) => c.id)).toEqual(["a1", "a2"]);

    resolveFirst(snapshotFor("org_a", ["stale"]));
    await first;
    expect(useCommsStore.getState().conversations.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("a snapshot never walks an open socket back to connecting", async () => {
    snapshot.mockResolvedValueOnce(snapshotFor("org_a", ["a1"], "connecting"));
    await commsActions().hydrate();
    expect(useCommsStore.getState().connection.state).toBe("open");
  });

  it("reset cancels the outgoing org's conversation retry timers", async () => {
    vi.useFakeTimers();
    try {
      // A failing first page arms a backoff retry for that conversation.
      openConversation.mockRejectedValueOnce("no organisation is connected");
      commsActions().openConversation("a1");
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingConvRetriesForTests()).toBe(1);

      // The switch's reset must disarm it: it would otherwise fire
      // `comms_open_conversation("a1")` against the NEW org's socket.
      commsActions().reset();
      expect(pendingConvRetriesForTests()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(openConversation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("send", () => {
  it("keeps the draft and toasts when there is no org to send to", () => {
    useCommsStore.setState({
      connection: {
        state: "disconnected",
        reason: null,
        epoch: 0,
        orgId: null,
      },
      composers: {
        c1: { draft: "hello", replyTo: null, editing: null, attachments: [] },
      },
    });
    commsActions().send("c1");
    expect(send).not.toHaveBeenCalled();
    expect(useCommsStore.getState().composers.c1?.draft).toBe("hello");
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("sends while reconnecting — Rust queues and replays it", () => {
    send.mockResolvedValue({ client_msg_id: "x" });
    useCommsStore.setState({
      connection: {
        state: "backoff",
        reason: "offline",
        epoch: 1,
        orgId: "org_a",
      },
      composers: {
        c1: { draft: "hello", replyTo: null, editing: null, attachments: [] },
      },
    });
    commsActions().send("c1");
    expect(send).toHaveBeenCalledWith("c1", "hello", null, []);
    expect(useCommsStore.getState().composers.c1?.draft).toBe("");
  });

  it("gives the draft back when Rust refuses the send", async () => {
    send.mockRejectedValue('{"code":"bad_request","message":"Nope."}');
    useCommsStore.setState({
      composers: {
        c1: { draft: "hello", replyTo: "m9", editing: null, attachments: [] },
      },
    });
    commsActions().send("c1");
    expect(useCommsStore.getState().composers.c1?.draft).toBe("");
    await flush();
    const composer = useCommsStore.getState().composers.c1;
    expect(composer?.draft).toBe("hello");
    expect(composer?.replyTo).toBe("m9");
    expect(toastError).toHaveBeenCalledWith("Nope.");
  });
});
