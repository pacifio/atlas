// Which messages make up a turn, and what to call it.
//
// A turn is the run of assistant messages that answers a prompt. Two names
// for one:
//
// - the TRANSCRIPT's turn id, `t:<message id>`, which `projectRows` gives each
//   run from its first non-empty message. Message ids are minted when a
//   session's log is loaded (`replaceMessages`), so this id lasts as long as
//   the loaded log does and no longer.
// - the STABLE key, `tc:<tool call id>`, from the run's first edit. The agent
//   assigns tool call ids and the transcript keeps them, so the key names the
//   same turn after a relaunch or a session switch. Anything persisted about a
//   turn is keyed by it.

import type { ChatMessage } from "@/types/agent";
import { classifyToolFileKind } from "./tool-files";

/**
 * A message renders nothing at all — no prose, no thinking, no tools, no files,
 * no plan. claude-agent-acp routinely emits signature-only `thinking` blocks
 * with empty content as turn markers; projecting them produced phantom rows
 * whose padding read as unexplained gaps. `projectRows` skips them, so the row
 * index never contains one — and a turn's transcript id comes from its first
 * message that is not one.
 */
export function isEmptyMessage(m: ChatMessage): boolean {
  return (
    !(m.content && m.content.trim()) &&
    !(m.thinking && m.thinking.trim()) &&
    m.toolCalls.length === 0 &&
    m.fileChanges.length === 0 &&
    !(m.plan && m.plan.length > 0) &&
    // A turn cut off before any output keeps an otherwise empty message just
    // to carry its interruption record (`recordInterruption`).
    !m.interruption
  );
}

/** Message index range `[start, end)` of one assistant run. */
export interface TurnRun {
  start: number;
  end: number;
}

/** The assistant run holding message `index`. */
function runAround(messages: readonly ChatMessage[], index: number): TurnRun {
  let start = index;
  while (start > 0 && messages[start - 1].role === "assistant") start--;
  let end = index + 1;
  while (end < messages.length && messages[end].role === "assistant") end++;
  return { start, end };
}

/** True when a tool call edits a file, by either shape an edit arrives in. */
export function isEditCall(tc: ChatMessage["toolCalls"][number]): boolean {
  if (tc.contentBlocks?.some((b) => b.type === "diff")) return true;
  return classifyToolFileKind(tc.kind, tc.toolName) === "edit";
}

/** The run's stable key: `tc:<id of its first edit call>`, or null when it
 *  edited nothing. */
export function stableTurnKey(messages: readonly ChatMessage[], run: TurnRun): string | null {
  for (let i = run.start; i < run.end; i++) {
    for (const tc of messages[i].toolCalls) if (isEditCall(tc)) return `tc:${tc.id}`;
  }
  return null;
}

/**
 * The assistant run a turn reference names: a stable key (`tc:<call id>`) or
 * a transcript id (`t:<message id>`). Either may name ANY message of the run,
 * not just the first — the transcript names a run by its first non-empty
 * message, which need not be its first.
 */
export function findTurnRun(messages: readonly ChatMessage[], ref: string): TurnRun | null {
  let index = -1;
  if (ref.startsWith("tc:")) {
    const callId = ref.slice(3);
    index = messages.findIndex(
      (m) => m.role === "assistant" && m.toolCalls.some((tc) => tc.id === callId),
    );
  } else {
    const messageId = ref.startsWith("t:") ? ref.slice(2) : ref;
    index = messages.findIndex((m) => m.role === "assistant" && m.id === messageId);
  }
  return index < 0 ? null : runAround(messages, index);
}
