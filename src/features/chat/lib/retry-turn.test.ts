import { beforeEach, describe, expect, it, vi } from "vitest";

// The action reaches IPC, toasts and the log store; none of that is what is
// under test. What IS under test is the ordering around the destructive call.
const rewindLastTurn = vi.fn<(key: unknown) => Promise<string | null>>();
const send = vi.fn<(key: unknown, prompt: string) => Promise<void>>();
const queueAdd = vi.fn(async () => "q-1");
const enqueueMessage = vi.fn();
const addMessage = vi.fn();
const updateSessionStatus = vi.fn();

let session: Record<string, unknown> | undefined;
let subscriber: (() => void) | undefined;

vi.mock("./agents-api", () => ({
  agents: {
    rewindLastTurn: (key: unknown) => rewindLastTurn(key),
    send: (key: unknown, prompt: string) => send(key, prompt),
    queueAdd: (...args: unknown[]) => queueAdd(...(args as [])),
  },
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: { adaptiveSuggestions: "off" } }) },
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
      actions: { addMessage, updateSessionStatus, enqueueMessage, setQueueItemId: vi.fn() },
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
const { collapsePastes, pastedTextMention, withPastesInline } = await import("./pasted-text");

/**
 * Let the store's truncation become observable, as the real delta would:
 * shorter than it is NOW, not a fixed length. Setting a fixed one-message list
 * made the second rewind in a test invisible (1 → 1), so `awaitRewind` sat out
 * its real 3 s timeout and took the hand-back path while the test still
 * passed on the call count alone.
 */
function deliverRewindDelta() {
  const messages = (session?.messages as unknown[] | undefined) ?? [];
  session = { ...session, messages: messages.slice(0, -1) };
  subscriber?.();
}

/** The retry saw its rewind land and went on to send — not the timeout path. */
function expectRewindObserved(times: number) {
  expect(send).toHaveBeenCalledTimes(times);
  expect(enqueueMessage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriber = undefined;
  session = {
    agentType: "atlas-agent",
    status: "idle",
    acpAgentId: "agent",
    acpSessionId: "sess",
    messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }],
  };
});

describe("retrying the last turn", () => {
  // The native agent hands back the turn's prompt as the blocks it sent, a
  // blank line apart (`UserMessage::prompt_text`): a large paste rode as a
  // text block, so it comes back whole, in the form the queue writes.
  const paste = pastedTextMention(Array.from({ length: 120 }, (_, i) => `log ${i}`).join("\n"));
  const withPaste = withPastesInline(`summarise @paste:${paste.id}`, [paste]);

  it("re-sends a turn's large paste in full", async () => {
    rewindLastTurn.mockResolvedValue(withPaste);
    send.mockResolvedValue(undefined);
    const run = retryLastTurn("tab");
    deliverRewindDelta();
    await run;
    expect(send).toHaveBeenCalledWith(expect.anything(), withPaste);
    expect(send.mock.calls[0][1]).toContain("log 119");
  });

  it("hands a prompt with a paste back in a form the composer collapses to its chip", async () => {
    vi.useFakeTimers();
    rewindLastTurn.mockResolvedValue(withPaste);
    const run = retryLastTurn("tab");
    await vi.advanceTimersByTimeAsync(4_000);
    await run;
    vi.useRealTimers();
    expect(send).not.toHaveBeenCalled();
    const queued = enqueueMessage.mock.calls[0][1] as string;
    expect(collapsePastes(queued)).toEqual({
      text: `summarise @paste:${paste.id}`,
      pastes: [paste],
    });
  });

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
    expectRewindObserved(1);
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
    // Both retries observed their own truncation (4 → 3 → 2) and sent.
    expectRewindObserved(2);
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
    expectRewindObserved(1);
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
    // Handed back to the session's queue — in Rust, which owns it now; the
    // strip shows it at once, marked pending until `queue_changed` confirms.
    expect(enqueueMessage).toHaveBeenCalledWith(
      "tab",
      "hello",
      [],
      expect.stringMatching(/^pending:/),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: expect.any(String) }),
      "hello",
      "hello",
    );
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
    expect(enqueueMessage).toHaveBeenCalledWith(
      "tab",
      "hello",
      [],
      expect.stringMatching(/^pending:/),
    );
    // Into the session the tab is on NOW: the hand-back is for the user.
    expect(queueAdd).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "a-different-session" }),
      "hello",
      "hello",
    );
  });

  it("sends nothing and enqueues nothing when there was no turn to rewind", async () => {
    rewindLastTurn.mockResolvedValue(null);
    await retryLastTurn("tab");
    expect(send).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
