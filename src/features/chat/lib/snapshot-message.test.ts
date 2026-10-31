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

/**
 * A reopened conversation used to show the text `Image` where a picture had
 * been: the snapshot flattened it. The images now ride the snapshot, and the
 * adapter hands them to the store in the shape the sent message had.
 */
describe("snapshotMessageToWire images", () => {
  it("maps a user message's images to attachments", () => {
    const wire = snapshotMessageToWire(
      message({
        role: "user",
        mode: "text",
        content: "can you see this?",
        images: [{ mime_type: "image/png", data: "iVBORw0K" }],
      }),
    );
    expect(wire.attachments).toEqual([{ mimeType: "image/png", dataBase64: "iVBORw0K" }]);
  });

  it("adds no attachments key when there are no images", () => {
    expect(snapshotMessageToWire(message())).not.toHaveProperty("attachments");
  });

  it("carries the turn's timing and each call's times, so durations survive a reload", () => {
    const wire = snapshotMessageToWire(
      message({
        worked_ms: 252_000,
        stop_reason: "cancelled",
        tool_calls: [
          {
            id: "call-1",
            tool_name: "run",
            title: null,
            kind: "execute",
            status: "completed",
            arguments: {},
            result: null,
            locations: [],
            started_at_ms: 1_000,
            ended_at_ms: 7_000,
          },
        ],
      }),
    );
    expect(wire).toMatchObject({ workedMs: 252_000, stopReason: "cancelled" });
    expect(wire.toolCalls[0]).toMatchObject({ startedAt: 1_000, endedAt: 7_000 });
  });

  it("adds no timing keys to a message that has none", () => {
    const wire = snapshotMessageToWire(message());
    expect(wire).not.toHaveProperty("workedMs");
    expect(wire).not.toHaveProperty("stopReason");
  });
});
