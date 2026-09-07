import { beforeEach, describe, expect, it, vi } from "vitest";

// The action reaches IPC, toasts and the log store; none of that is what is
// under test. What IS under test is the ordering around the destructive call.
const rewindLastTurn = vi.fn<(key: unknown) => Promise<string | null>>();
const send = vi.fn<() => Promise<void>>();
const enqueueMessage = vi.fn();
const addMessage = vi.fn();
const updateSessionStatus = vi.fn();

let session: Record<string, unknown> | undefined;
let subscriber: (() => void) | undefined;

vi.mock("./agents-api", () => ({
  agents: {
    rewindLastTurn: (key: unknown) => rewindLastTurn(key),
    send: () => send(),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/features/agents/lib/agent-meta", () => ({
  catalogEntry: () => ({ supportsRewind: true }),
}));
vi.mock("../stores/chat-store", () => ({
  useChatStore: {
    getState: () => ({
      sessions: { tab: session },
      actions: { addMessage, updateSessionStatus, enqueueMessage },
    }),
    subscribe: (cb: () => void) => {
      subscriber = cb;
      return () => {
        subscriber = undefined;
      };
    },
  },
}));

const { retryLastTurn } = await import("./retry-turn");

/** Let the store's truncation become observable, as the real delta would. */
function deliverRewindDelta() {
  session = { ...session, messages: [{ role: "user" }] };
  subscriber?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriber = undefined;
  session = {
    agentType: "cersei",
    status: "idle",
    acpAgentId: "agent",
    acpSessionId: "sess",
    messages: [{ role: "user" }, { role: "assistant" }],
  };
});

describe("retrying the last turn", () => {
  it("rewinds once when clicked twice in a row", async () => {
    // The status gate cannot catch this: `updateSessionStatus("running")` only
    // runs AFTER the rewind resolves, so between the two clicks the session
    // still reads idle and the gate still says yes. Two rollbacks would have
    // destroyed two turns, and the second one is a turn the user never chose.
    let release: (v: string | null) => void = () => {};
    rewindLastTurn.mockReturnValue(
      new Promise<string | null>((resolve) => {
        release = resolve;
      }),
    );

    const first = retryLastTurn("tab");
    const second = retryLastTurn("tab");

    expect(rewindLastTurn).toHaveBeenCalledTimes(1);

    release("hello");
    deliverRewindDelta();
    await Promise.all([first, second]);
    expect(rewindLastTurn).toHaveBeenCalledTimes(1);
  });

  it("allows a retry again once the previous one has settled", async () => {
    rewindLastTurn.mockResolvedValue("hello");
    send.mockResolvedValue(undefined);

    const run = retryLastTurn("tab");
    deliverRewindDelta();
    await run;

    const again = retryLastTurn("tab");
    deliverRewindDelta();
    await again;
    expect(rewindLastTurn).toHaveBeenCalledTimes(2);
  });

  it("releases the claim even when the rewind throws", async () => {
    // A guard that leaks on the error path would wedge retry for the life of
    // the tab, with no way for the user to tell why the button stopped working.
    rewindLastTurn.mockRejectedValueOnce(new Error("engine gone"));
    await retryLastTurn("tab");

    rewindLastTurn.mockResolvedValue("hello");
    send.mockResolvedValue(undefined);
    const run = retryLastTurn("tab");
    deliverRewindDelta();
    await run;
    expect(rewindLastTurn).toHaveBeenCalledTimes(2);
  });

  it("does not send, and hands the prompt back, when the rewind never reaches the transcript", async () => {
    // The rewind already landed on the backend. Sending anyway risks a late
    // `history_rewound` splicing off the message just added; dropping the
    // prompt loses what the user wrote. Neither is acceptable.
    vi.useFakeTimers();
    rewindLastTurn.mockResolvedValue("hello");
    const run = retryLastTurn("tab");
    await vi.advanceTimersByTimeAsync(4_000);
    await run;
    vi.useRealTimers();

    expect(send).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledWith("tab", "hello");
  });

  it("does not send into a session the tab switched to mid-rewind", async () => {
    // Sending the old key's prompt into a different session would put one
    // conversation's text in another's transcript.
    rewindLastTurn.mockImplementation(async () => {
      session = { ...session, acpSessionId: "a-different-session" };
      return "hello";
    });

    const run = retryLastTurn("tab");
    deliverRewindDelta();
    await run;

    expect(send).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledWith("tab", "hello");
  });

  it("sends nothing and enqueues nothing when there was no turn to rewind", async () => {
    rewindLastTurn.mockResolvedValue(null);
    await retryLastTurn("tab");
    expect(send).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
