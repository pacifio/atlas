import { describe, expect, it, vi } from "vitest";

// The host mounts a Radix dialog and talks to Tauri; the behaviour under test
// is the queue it keeps, which is plain state.
const handlers: Array<(e: unknown) => void> = [];
vi.mock("../lib/agents-api", () => ({
  listenAgentElicitation: (h: (e: unknown) => void) => {
    handlers.push(h);
    return Promise.resolve(() => {});
  },
  agents: { respondElicitation: () => Promise.resolve() },
}));

const { enqueueElicitation: enqueue } = await import("./agent-elicitation-host");

type Pending = import("../lib/agents-api").RequestElicitation;
const one: Pending = { requestId: "r1", agentId: "a", mode: "url", message: "" };
const two: Pending = { requestId: "r2", agentId: "b", mode: "url", message: "" };

describe("the request-elicitation queue", () => {
  it("keeps a second agent's question instead of replacing the first", () => {
    // Two agents can be signing in at once. A question the user is never shown
    // is one its agent waits on forever.
    const queue = enqueue(enqueue([], one), two);
    expect(queue.map((q) => q.requestId)).toEqual(["r1", "r2"]);
  });

  it("never queues the same question twice", () => {
    // The backend refuses to announce one twice, but a remount must not
    // double it either.
    const queue = enqueue(enqueue([], one), { ...one });
    expect(queue).toHaveLength(1);
  });

  it("answers them oldest first", () => {
    const queue = enqueue(enqueue([], one), two);
    expect(queue[0].requestId).toBe("r1");
    const after = queue.filter((q) => q.requestId !== "r1");
    expect(after[0].requestId).toBe("r2");
  });
});
