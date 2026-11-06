import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import { bashEntriesOf } from "./bash-history";

const call = (id: string, kind: string, toolName: string, args: Record<string, unknown>) =>
  ({ id, kind, toolName, arguments: args, status: "completed" }) as unknown as ToolCallDisplay;

const message = (timestamp: string, toolCalls: ToolCallDisplay[]) =>
  ({
    id: timestamp,
    role: "assistant",
    content: "",
    toolCalls,
    timestamp,
  }) as unknown as ChatMessage;

describe("bashEntriesOf", () => {
  it("lists execute-kind and bash-named calls, newest first, carrying the description", () => {
    const entries = bashEntriesOf([
      message("t0", [call("a", "execute", "Run", { command: "ls" })]),
      message("t1", [
        call("b", "other", "Bash", { command: "git status", description: "Check the tree" }),
        call("c", "read", "Read", { path: "x" }),
      ]),
    ]);
    expect(entries.map((e) => e.toolCallId)).toEqual(["b", "a"]);
    expect(entries[0]).toMatchObject({
      command: "git status",
      description: "Check the tree",
      messageIndex: 1,
      timestamp: "t1",
    });
  });

  it("skips a call with no command", () => {
    expect(bashEntriesOf([message("t0", [call("a", "execute", "Run", {})])])).toEqual([]);
  });
});
