import { describe, expect, it, vi } from "vitest";

// The host mounts a Radix dialog and talks to Tauri; the behaviour under test
// is the queue it keeps, which is plain state.
vi.mock("../lib/agents-api", () => ({
  listenAgentElicitation: () => Promise.resolve(() => {}),
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

  it("keeps two agents' questions that share a request id", () => {
    // Request ids are per connection: both agents can send a `r1`.
    const queue = enqueue(enqueue([], one), { ...one, agentId: "b" });
    expect(queue.map((q) => q.agentId)).toEqual(["a", "b"]);
  });

  it("never queues the same question twice", () => {
    // The backend refuses to announce one twice, but a remount must not
    // double it either.
    const queue = enqueue(enqueue([], one), { ...one });
    expect(queue).toHaveLength(1);
  });
});
