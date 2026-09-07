import { describe, expect, it } from "vitest";
import { NATIVE_AGENT_ID, type ChatSession } from "@/types/agent";
import { sessionCanRetry } from "./retry-gate";

/** Only the fields the gate reads; the rest of `ChatSession` is irrelevant. */
function session(over: Partial<ChatSession> = {}): ChatSession {
  return {
    agentType: NATIVE_AGENT_ID,
    status: "idle",
    messages: [],
    ...over,
  } as ChatSession;
}

/** The agent advertised a rewind. */
const CAN = true;

describe("whether a session can retry its last turn", () => {
  it("can, when the agent advertises a rewind and the session is idle", () => {
    expect(sessionCanRetry(session(), CAN)).toBe(true);
  });

  it("cannot when the agent cannot rewind, whichever agent that is", () => {
    // Session capabilities in schema 1.5.0 are list/delete/fork/resume/close/
    // additional_directories/meta — nothing that tells an agent to forget a
    // turn. The alternative to hiding the button is an append-and-resend that
    // looks like a retry and silently isn't one.
    expect(sessionCanRetry(session({ agentType: "claude-code" }), false)).toBe(false);
    expect(sessionCanRetry(session({ agentType: "codex" }), false)).toBe(false);
  });

  it("asks the capability, not the agent id", () => {
    // ADR-0002: no agent gets special treatment. The gate must not recognise
    // the native agent by name — if the capability says no, the answer is no
    // even for `cersei`, and if it says yes the answer is yes for anyone.
    expect(sessionCanRetry(session({ agentType: NATIVE_AGENT_ID }), false)).toBe(false);
    expect(sessionCanRetry(session({ agentType: "some-future-agent" }), CAN)).toBe(true);
  });

  it("cannot before the agent's first handshake", () => {
    // Capabilities are false until the connection advertises them. Unknown is
    // not a licence to offer a destructive action.
    expect(sessionCanRetry(session(), false)).toBe(false);
  });

  it("cannot while a turn is in flight", () => {
    // Rewinding under a running turn would race the very turn it is replacing.
    expect(sessionCanRetry(session({ status: "running" }), CAN)).toBe(false);
  });

  it("cannot while a turn is paused on an approval", () => {
    // `waiting` is a LIVE turn parked on a permission or plan modal. Rewinding
    // here would delete the exchange the modal is asking about.
    expect(sessionCanRetry(session({ status: "waiting" }), CAN)).toBe(false);
  });

  it("cannot between Stop and the cancelled turn's terminal delta", () => {
    // `status` can already read idle while the backend is still winding tools
    // down; `stopping` is the flag that says so.
    expect(sessionCanRetry(session({ status: "idle", stopping: true }), CAN)).toBe(false);
  });

  it("can again once the turn ends, including after an error", () => {
    // A failed turn is the single most likely thing a user wants to retry.
    expect(sessionCanRetry(session({ status: "error" }), CAN)).toBe(true);
  });

  it("cannot on a session whose agent process is gone or still resuming", () => {
    expect(sessionCanRetry(session({ disconnected: true }), CAN)).toBe(false);
    expect(sessionCanRetry(session({ resumePending: true }), CAN)).toBe(false);
  });

  it("cannot on no session at all", () => {
    expect(sessionCanRetry(undefined, CAN)).toBe(false);
  });

  it("does not read `messages`", () => {
    // The transcript calls this inside a store selector, so it runs on every
    // streaming delta. Walking the message log here would make a long thread's
    // stream quadratic — which row is retryable is a separate, memoized
    // question answered from the row projection.
    const trap = session();
    Object.defineProperty(trap, "messages", {
      get() {
        throw new Error("sessionCanRetry must not touch messages");
      },
    });
    expect(() => sessionCanRetry(trap, CAN)).not.toThrow();
  });
});
