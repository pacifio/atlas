// Subagents: the derivations a subagent surface needs, with no view in them.
//
// The backend already does the hard part. `atlas_acp_thread::subagent` reads a
// child out of ordinary ACP tool calls (no agent ships a subagent type —
// ADR-0002, and the detector is keyed on payload evidence, never on agent id),
// the projector diffs the set each time the thread changes, and the store holds
// the result. Everything here is pure projection over `Subagent` records and
// the transcript they point into: what is live, how long it has run, which of
// the parent's tool calls belong to which child.
//
// Two shapes of agent have to come out of the same functions:
//
//   * **Streaming children** (Claude, via the `subagent-transcript` client
//     capability Atlas declares): the child's calls arrive on the parent's
//     session stamped with `parentToolCallId`, so a row can show work in
//     flight and `toolCallCount` climbs while it runs.
//   * **Mail children** (the native engine's multi-agent v2): the child runs on
//     a thread of its own and reports once, so its calls are never attributed
//     and `toolCallCount` stays 0 until — and after — it finishes. Its `result`
//     is the whole of what it said.
//
// A surface that assumes either one is wrong for half the agents Atlas talks
// to. `hasAttributedWork` is the honest question to ask before rendering a
// count or a nested list.

import type { ChatMessage, Subagent, SubagentStatus, ToolCallDisplay } from "@/types/agent";

/** Statuses a child cannot leave. `interrupted` is terminal and is NOT a
 *  failure: a stop the user pressed ends every child of that turn
 *  (`EngineConnection::cancel` cascades), and painting those red would report
 *  the user's own action as an error. */
const TERMINAL: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>([
  "completed",
  "failed",
  "interrupted",
]);

export function isTerminal(status: SubagentStatus): boolean {
  return TERMINAL.has(status);
}

export function isRunning(subagent: Subagent): boolean {
  return subagent.status === "running";
}

/** Launch order, which is the only order a reader can follow: the agent spawns
 *  children in the order it describes them, and a list that re-sorts as
 *  statuses settle makes a row move while being read.
 *
 *  Ties broken on `toolCallId` so the sequence is total — two children spawned
 *  in one batch share a millisecond often enough to matter (the engine emits
 *  both `spawn_agent` calls in the same stream frame). */
export function orderedSubagents(subagents: Record<string, Subagent> | undefined): Subagent[] {
  if (!subagents) return [];
  return Object.values(subagents).sort(
    (a, b) => a.startedAtMs - b.startedAtMs || (a.toolCallId < b.toolCallId ? -1 : 1),
  );
}

export interface SubagentTally {
  total: number;
  running: number;
  completed: number;
  failed: number;
  interrupted: number;
}

const EMPTY_TALLY: SubagentTally = Object.freeze({
  total: 0,
  running: 0,
  completed: 0,
  failed: 0,
  interrupted: 0,
});

/** One pass for every count a header, badge or pill could want. */
export function tallySubagents(list: readonly Subagent[]): SubagentTally {
  if (list.length === 0) return EMPTY_TALLY;
  const tally: SubagentTally = { ...EMPTY_TALLY, total: list.length };
  for (const subagent of list) tally[subagent.status] += 1;
  return tally;
}

/**
 * How long a child has been running, or ran.
 *
 * `endedAtMs` is absent while live, so the caller passes its own clock — the
 * same arrangement the turn header uses (`WorkHeaderRow.startedAt`): a ticking
 * figure belongs to the frame that renders it, not to a value the store would
 * have to rewrite every second to keep honest.
 *
 * Never negative. The two timestamps are stamped by different clocks — the
 * start by the Rust projector from the thread entry, the `now` by the renderer
 * — and a machine whose wall clock steps back between them would otherwise
 * render "-3s".
 */
export function elapsedMs(subagent: Subagent, now: number): number {
  return Math.max(0, (subagent.endedAtMs ?? now) - subagent.startedAtMs);
}

/**
 * Whether this child's own work is visible at all.
 *
 * False for every mail child (the native engine's), whose calls run on a thread
 * Atlas never attributes — not a child that has done nothing. A row that
 * renders "0 tools" for those is stating something untrue; a row that hides the
 * count is merely saying less than it could.
 */
export function hasAttributedWork(subagent: Subagent): boolean {
  return subagent.toolCallCount > 0;
}

/** The ids of the tool calls that LAUNCHED children — the calls a transcript
 *  should render as subagent rows rather than as plain tool calls, since each
 *  one already has a richer record of itself.
 *
 *  Note this is `toolCallId`, the launch, not the child's own calls: see
 *  `childCallsOf` for those. */
export function launchCallIds(
  subagents: Record<string, Subagent> | undefined,
): ReadonlySet<string> {
  return new Set(Object.keys(subagents ?? {}));
}

/**
 * Every tool call the transcript attributes to one child, in transcript order.
 *
 * A child's calls arrive on the PARENT's session interleaved with the parent's
 * own and with its siblings', so this is a filter across the whole message
 * list rather than a lookup — `parentToolCallId` is the only thing telling them
 * apart. Empty for a mail child, always.
 */
export function childCallsOf(
  messages: readonly ChatMessage[],
  toolCallId: string,
): ToolCallDisplay[] {
  const calls: ToolCallDisplay[] = [];
  for (const message of messages) {
    for (const call of message.toolCalls) {
      if (call.parentToolCallId === toolCallId) calls.push(call);
    }
  }
  return calls;
}

/**
 * Every attributed call in the transcript, bucketed by the child that made it.
 *
 * One pass for a view that nests several children at once — `childCallsOf` per
 * row is O(children × calls) over a transcript that can hold thousands of
 * calls, and the transcript is re-projected on every streaming frame.
 */
export function childCallsByParent(
  messages: readonly ChatMessage[],
): Map<string, ToolCallDisplay[]> {
  const byParent = new Map<string, ToolCallDisplay[]>();
  for (const message of messages) {
    for (const call of message.toolCalls) {
      const parent = call.parentToolCallId;
      if (!parent) continue;
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(call);
      else byParent.set(parent, [call]);
    }
  }
  return byParent;
}

/** The children a single assistant message launched, for a transcript that
 *  places rows inline rather than in a panel. Launch order, as `ordered`. */
export function subagentsOfMessage(ordered: readonly Subagent[], messageId: string): Subagent[] {
  return ordered.filter((subagent) => subagent.messageId === messageId);
}

/** A display name that is never empty. The detector falls back to a clipped
 *  first line of the prompt when a launch carried no name at all, but an agent
 *  that sent neither leaves nothing to render. */
export function displayName(subagent: Subagent): string {
  const name = subagent.name.trim();
  return name.length > 0 ? name : "Subagent";
}
