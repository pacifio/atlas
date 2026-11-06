// Builders for agent transcript data, in the WIRE shape Rust streams
// (`SessionMessage` / `ToolCall`), so scenarios exercise the same
// delta → store → projection path a real session does.

import type { SessionMessage, ToolCall } from "@/types/agents";
import { abs } from "../project";

let n = 0;
const id = (p: string) => `${p}-${++n}`;

/** Timestamps a scenario can space out: `t(0)`, `t(12)` = 12s later.
 *  Anchored a few minutes before page load, so a turn's "Worked for" and
 *  "Working for" read as seconds rather than as days since a fixed date. */
const T0 = Date.now() - 5 * 60_000;
export const t = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export function user(content: string, at = t(0)): SessionMessage {
  return { id: id("u"), role: "user", mode: "text", content, tool_calls: [], timestamp: at };
}

export function text(content: string, at = t(0)): SessionMessage {
  return { id: id("a"), role: "assistant", mode: "text", content, tool_calls: [], timestamp: at };
}

export function thinking(thought: string, at = t(0)): SessionMessage {
  return {
    id: id("th"),
    role: "assistant",
    mode: "thinking",
    content: "",
    thinking: thought,
    tool_calls: [],
    timestamp: at,
  };
}

/**
 * One assistant message carrying tool calls.
 *
 * Settled calls are timed the way Rust stamps them — `started_at_ms` at first
 * sight, `ended_at_ms` when they settled — laid end to end from `at`, each
 * taking its `took` (a fifth of a second unless the call says otherwise). A
 * call still running keeps no times: the live one is stamped by whoever drives
 * it, against the real clock.
 */
export function tools(calls: ToolCall[], at = t(0)): SessionMessage {
  let cursor = Date.parse(at);
  for (const c of calls) {
    if (c.status !== "completed" && c.status !== "failed") continue;
    if (c.started_at_ms === undefined) c.started_at_ms = cursor;
    if (c.ended_at_ms === undefined) c.ended_at_ms = c.started_at_ms + (took.get(c) ?? 200);
    cursor = c.ended_at_ms;
  }
  return {
    id: id("tm"),
    role: "assistant",
    mode: "tool",
    content: "",
    tool_calls: calls,
    timestamp: at,
  };
}

/** `parent_tool_call_id` is here because a subagent's own calls are ordinary
 *  tool calls that happen to name the launch they belong to — the only thing
 *  that tells a child's work apart from its parent's. `took` is how many
 *  seconds the call ran, which `tools` turns into its wire times. */
type Opts = Partial<Pick<ToolCall, "status" | "result" | "id" | "parent_tool_call_id">> & {
  took?: number;
};

/** Each call's run time in ms, read by `tools` when it lays the calls out. */
const took = new WeakMap<ToolCall, number>();

function call(base: Omit<ToolCall, "id" | "status" | "result" | "locations">, o: Opts): ToolCall {
  const out: ToolCall = {
    id: o.id ?? id("tc"),
    status: o.status ?? "completed",
    result: o.result ?? null,
    locations: [],
    ...(o.parent_tool_call_id ? { parent_tool_call_id: o.parent_tool_call_id } : {}),
    ...base,
  };
  if (o.took !== undefined) took.set(out, o.took * 1000);
  return out;
}

/** Close a settled turn on its last message, the way a snapshot does: the
 *  turn's wall time and how it stopped. */
export function ended(
  message: SessionMessage,
  workedSeconds: number,
  stopReason = "end_turn",
): SessionMessage {
  return { ...message, worked_ms: workedSeconds * 1000, stop_reason: stopReason };
}

export const tool = {
  read: (path: string, o: Opts = {}) =>
    call(
      {
        tool_name: `Read ${path}`,
        title: `Read ${path}`,
        kind: "read",
        arguments: { file_path: abs(path) },
      },
      o,
    ),

  search: (pattern: string, o: Opts = {}) =>
    call(
      {
        tool_name: `grep "${pattern}"`,
        title: `grep "${pattern}"`,
        kind: "search",
        arguments: { pattern },
      },
      o,
    ),

  /** A shell command. `result` is its output. */
  run: (command: string, o: Opts = {}) =>
    call({ tool_name: command, title: command, kind: "execute", arguments: { command } }, o),

  /** An edit reported as an ACP diff block. Omit `before` for a new file. */
  edit: (path: string, before: string | undefined, after: string, o: Opts = {}) =>
    call(
      {
        tool_name: "apply_patch",
        title: `Edit ${path}`,
        kind: "edit",
        arguments: {},
        content_blocks: [
          before === undefined
            ? { type: "diff", path: abs(path), newText: after }
            : { type: "diff", path: abs(path), oldText: before, newText: after },
        ],
      },
      o,
    ),

  fetch: (url: string, o: Opts = {}) =>
    call(
      { tool_name: `Fetch ${url}`, title: `Fetch ${url}`, kind: "fetch", arguments: { url } },
      o,
    ),

  /** A delegated sub-agent. ACP's `think` kind, which is what Claude Code
   *  reports a Task with — the one marker the transcript keeps a brain on. */
  delegate: (description: string, o: Opts = {}) =>
    call(
      {
        // Both fields carry the description, as this file does everywhere
        // else and as the wire does: Claude Code titles a Task with what it
        // asked for, which is the only useful thing to read on the row.
        tool_name: description,
        title: description,
        kind: "think",
        arguments: { description },
      },
      o,
    ),

  /** Anything else — an MCP tool, say. */
  other: (name: string, args: Record<string, unknown> = {}, o: Opts = {}) =>
    call({ tool_name: name, title: name, kind: "other", arguments: args }, o),
};

/** `count` lines of plausible file content. */
export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}
