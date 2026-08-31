import { describe, expect, it } from "vitest";
import { snapshotMessageToWire } from "./snapshot-message";
import type { SessionMessage } from "@/types/agents";

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "msg-0",
    role: "assistant",
    mode: "tool",
    content: "",
    tool_calls: [],
    timestamp: "2026-08-30T10:00:00Z",
    ...overrides,
  } as SessionMessage;
}

/**
 * ATL-220. The Rust snapshot carries each tool call's real id and its real
 * outcome; this adapter dropped both, and `replaceMessages` then re-minted an
 * id and hardcoded `"completed"`. Every tool call in a reopened conversation
 * therefore rendered as succeeded — a failed edit and a rejected command looked
 * exactly like ones that worked.
 */
describe("snapshotMessageToWire", () => {
  it("carries a failed tool call's status through", () => {
    const wire = snapshotMessageToWire(
      message({
        tool_calls: [
          {
            id: "call-1",
            tool_name: "edit",
            title: null,
            kind: "edit",
            status: "failed",
            arguments: { path: "a.txt" },
            result: "boom",
            locations: [],
          },
        ],
      }),
    );

    expect(wire.toolCalls[0].status).toBe("failed");
  });

  it("carries the agent's own tool call id, not a fresh one", () => {
    const wire = snapshotMessageToWire(
      message({
        tool_calls: [
          {
            id: "call-42",
            tool_name: "read",
            title: null,
            kind: "read",
            status: "completed",
            arguments: {},
            result: null,
            locations: [],
          },
        ],
      }),
    );

    // The id is the key later deltas are matched on (`findToolCall`), so a
    // re-minted one pushes a duplicate card for a call that is still running.
    expect(wire.toolCalls[0].id).toBe("call-42");
  });

  it("keeps every non-completed status distinguishable", () => {
    for (const status of ["pending", "running", "completed", "failed"] as const) {
      const wire = snapshotMessageToWire(
        message({
          tool_calls: [
            {
              id: `call-${status}`,
              tool_name: "run",
              title: null,
              kind: "execute",
              status,
              arguments: {},
              result: null,
              locations: [],
            },
          ],
        }),
      );
      expect(wire.toolCalls[0].status).toBe(status);
    }
  });
});
