// An Ask's event log on the client, and what is drawn from it. The web's
// `apps/web/src/lib/atlas/log.ts`, ported rule for rule so the two clients
// cannot disagree about a conversation.
//
// **The log is the state.** The server stores every event an Ask produces with
// a `seq` one more than the last, and a socket frame only announces one that
// is already stored. So the client keeps the log exactly as the server has it
// — gapless, in order, never edited — and folds it into turns to draw.
// Anything that would break that (a frame from the future, a duplicate after a
// resume) is decided here, in pure functions the store and its tests share.

import type {
  AskDetail,
  AskStatus,
  AtlasEvent,
  AtlasEventKind,
  Card,
  Payload,
  PlanStep,
  ResearchStatus,
} from "./org-agent-types";

/** Kinds this build draws. Anything else in a log is skipped, never fatal. */
const KNOWN: ReadonlySet<string> = new Set<AtlasEventKind>([
  "user_message",
  "text_delta",
  "tool_started",
  "tool_result",
  "approval_required",
  "approval_resolved",
  "question",
  "plan",
  "answer_done",
  "limit_reached",
  "memory_updated",
  "compacted",
  "error",
  "eta",
  "research",
  "report",
]);

/** Is `raw` an event frame this build can apply? Malformed ones are dropped. */
export function isEvent(raw: unknown): raw is AtlasEvent {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.ask_id === "string" &&
    typeof e.seq === "number" &&
    Number.isInteger(e.seq) &&
    e.seq > 0 &&
    typeof e.kind === "string" &&
    typeof e.at === "number" &&
    typeof e.payload === "object" &&
    e.payload !== null
  );
}

/** The last element, `undefined` for none (the app's lib predates `at`). */
export function lastOf<T>(list: readonly T[] | undefined): T | undefined {
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/** The last `seq` the log holds, 0 for none. */
export function lastSeq(log: Pick<AskDetail, "events"> | undefined): number {
  return lastOf(log?.events)?.seq ?? 0;
}

/** Where an Ask stands after `event`. Applied to the summary as frames land,
 *  so the list and the conversation agree without a refetch per frame. */
export function statusAfter(event: AtlasEvent, current: AskStatus): AskStatus {
  switch (event.kind) {
    case "user_message":
    case "text_delta":
    case "tool_started":
    case "tool_result":
    case "plan":
    case "approval_resolved":
      return "running";
    case "approval_required":
      return "waiting_approval";
    case "question":
      return "waiting_answer";
    case "answer_done":
    case "limit_reached":
    case "error":
    case "report":
      return "idle";
    case "research":
      // A job that ended without a report (failed, or canceled before it
      // found anything) ends the turn here. One that wrote a report ended it
      // on the `report`, and the `research{done}` the server sends after it
      // must not start it again — that left a finished job "working" forever.
      if (event.payload.status === "failed" || event.payload.status === "canceled") return "idle";
      return event.payload.status === "done" ? current : "running";
    default:
      return current;
  }
}

export interface AppendResult {
  log: AskDetail;
  /** Frames were skipped past: the client must `resume` from `lastSeq(log)`. */
  gap: boolean;
  added: number;
}

/**
 * Append events in `seq` order. A seq at or below the head is a duplicate and
 * is dropped; one more than one past the head means frames were missed, so
 * nothing past the hole is applied (it would draw an answer with a piece
 * missing) and `gap` tells the caller to resume.
 */
export function appendEvents(log: AskDetail, incoming: readonly AtlasEvent[]): AppendResult {
  const sorted = [...incoming].sort((a, b) => a.seq - b.seq);
  let head = lastSeq(log);
  let status = log.ask.status;
  let updated = log.ask.updated_at;
  const added: AtlasEvent[] = [];
  let gap = false;
  for (const event of sorted) {
    if (event.seq <= head) continue;
    if (event.seq !== head + 1) {
      gap = true;
      break;
    }
    added.push(event);
    head = event.seq;
    status = statusAfter(event, status);
    updated = Math.max(updated, event.at);
  }
  if (added.length === 0) return { log, gap, added: 0 };
  return {
    log: {
      ...log,
      ask: { ...log.ask, status, updated_at: updated },
      events: [...log.events, ...added],
    },
    gap,
    added: added.length,
  };
}

/** A REST read landing on a log the socket has moved past since it was sent:
 *  the longer of the two is the newer, so a slow read never takes an event
 *  back off the screen. */
export function mergeFresh(old: AskDetail | undefined, fresh: AskDetail): AskDetail {
  if (!old || old.ask.id !== fresh.ask.id) return fresh;
  if (lastSeq(fresh) >= lastSeq(old)) return fresh;
  return appendEvents(
    fresh,
    old.events.filter((e) => e.seq > lastSeq(fresh)),
  ).log;
}

// ── Folding the log into turns ──────────────────────────────────────────────

export interface ToolBlock {
  kind: "tool";
  call_id: string;
  tool: string;
  summary: string;
  done: boolean;
  cards: Card[];
  truncated: boolean;
}

export interface ApprovalBlock {
  kind: "approval";
  approval_id: string;
  card: Payload<"approval_required">["card"];
  resolved: Payload<"approval_resolved"> | null;
}

export interface QuestionBlock {
  kind: "question";
  question_id: string;
  text: string;
  options: { id: string; label: string }[];
  allow_text: boolean;
  /** Something happened after it in the turn, so it was answered. */
  answered: boolean;
}

export type Block = { kind: "text"; text: string } | ToolBlock | ApprovalBlock | QuestionBlock;

/** One exchange: what the member asked and everything Atlas did about it. */
export interface Turn {
  /** The `seq` of the user message, or 0 for events before any (a Loop run). */
  key: number;
  user: Payload<"user_message"> | null;
  at: number;
  blocks: Block[];
  plan: PlanStep[] | null;
  done: Payload<"answer_done"> | null;
  /** The `answer_done` event's seq: what a thumbs up or down names. */
  doneSeq: number | null;
  limit: Payload<"limit_reached"> | null;
  error: Payload<"error"> | null;
  memory: Payload<"memory_updated">[];
  eta: (Payload<"eta"> & { at: number }) | null;
  research: (Payload<"research"> & { at: number }) | null;
  report: Payload<"report"> | null;
  /** When the turn ended, for "worked for 12 s". */
  endedAt: number | null;
}

export interface AskView {
  turns: Turn[];
  /** Every card any tool returned in this Ask: what handles may link to. */
  cards: Card[];
  /** Pending approvals, oldest first. */
  approvals: ApprovalBlock[];
  compactedThrough: number | null;
}

function newTurn(key: number, at: number, user: Turn["user"]): Turn {
  return {
    key,
    user,
    at,
    blocks: [],
    plan: null,
    done: null,
    doneSeq: null,
    limit: null,
    error: null,
    memory: [],
    eta: null,
    research: null,
    report: null,
    endedAt: null,
  };
}

/** Fold a log into turns. Pure, and cheap enough to run on every frame. */
export function foldAsk(events: readonly AtlasEvent[]): AskView {
  const turns: Turn[] = [];
  const cards: Card[] = [];
  const approvals = new Map<string, ApprovalBlock>();
  let compactedThrough: number | null = null;
  let turn: Turn | null = null;

  const current = (at: number): Turn => {
    if (!turn) {
      turn = newTurn(0, at, null);
      turns.push(turn);
    }
    return turn;
  };

  for (const event of events) {
    if (!KNOWN.has(event.kind)) continue;
    if (event.kind === "user_message") {
      turn = newTurn(event.seq, event.at, event.payload);
      turns.push(turn);
      continue;
    }
    if (event.kind === "compacted") {
      compactedThrough = event.payload.through_seq;
      continue;
    }
    const t = current(event.at);
    // An open question is answered by whatever the turn does next.
    for (const b of t.blocks) if (b.kind === "question") b.answered = true;
    switch (event.kind) {
      case "text_delta": {
        const last = lastOf(t.blocks);
        if (last?.kind === "text") last.text += event.payload.text;
        else t.blocks.push({ kind: "text", text: event.payload.text });
        break;
      }
      case "tool_started":
        t.blocks.push({
          kind: "tool",
          call_id: event.payload.call_id,
          tool: event.payload.tool,
          summary: event.payload.summary,
          done: false,
          cards: [],
          truncated: false,
        });
        break;
      case "tool_result": {
        const p = event.payload;
        const started = t.blocks.find(
          (b): b is ToolBlock => b.kind === "tool" && b.call_id === p.call_id,
        );
        const block: ToolBlock = started ?? {
          kind: "tool",
          call_id: p.call_id,
          tool: p.tool,
          summary: p.summary,
          done: true,
          cards: [],
          truncated: false,
        };
        block.done = true;
        block.summary = p.summary;
        block.cards = p.cards ?? [];
        block.truncated = p.truncated ?? false;
        if (!started) t.blocks.push(block);
        cards.push(...block.cards);
        break;
      }
      case "approval_required": {
        const block: ApprovalBlock = {
          kind: "approval",
          approval_id: event.payload.approval_id,
          card: event.payload.card,
          resolved: null,
        };
        approvals.set(block.approval_id, block);
        t.blocks.push(block);
        break;
      }
      case "approval_resolved": {
        const block = approvals.get(event.payload.approval_id);
        if (block) block.resolved = event.payload;
        if (event.payload.executed) cards.push(...(event.payload.executed.cards ?? []));
        break;
      }
      case "question":
        t.blocks.push({ kind: "question", ...event.payload, answered: false });
        break;
      case "plan":
        t.plan = event.payload.steps;
        break;
      case "answer_done":
        t.done = event.payload;
        t.doneSeq = event.seq;
        t.endedAt = event.at;
        break;
      case "limit_reached":
        t.limit = event.payload;
        if (!event.payload.can_continue) t.endedAt = event.at;
        break;
      case "error":
        t.error = event.payload;
        t.endedAt = event.at;
        break;
      case "memory_updated":
        t.memory.push(event.payload);
        break;
      case "eta":
        t.eta = { ...event.payload, at: event.at };
        break;
      case "research":
        t.research = { ...event.payload, at: event.at };
        if (event.payload.status === "failed") t.endedAt = event.at;
        break;
      case "report":
        t.report = event.payload;
        t.endedAt = event.at;
        cards.push(...(event.payload.cards ?? []));
        break;
    }
  }

  return {
    turns,
    cards,
    approvals: [...approvals.values()].filter((a) => a.resolved === null),
    compactedThrough,
  };
}

/** The answer's text, for Copy: every text block of the turn, in order. */
export function turnText(turn: Turn): string {
  return turn.blocks
    .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Whether the turn has ended: answered, stopped at a limit, failed, or its
 *  research reported. */
export function turnEnded(turn: Turn): boolean {
  return (
    turn.done !== null ||
    turn.limit !== null ||
    turn.error !== null ||
    turn.report !== null ||
    turn.research?.status === "failed"
  );
}

/** Research phases that are over: nothing more will move on the job. */
export function researchFinished(status: ResearchStatus): boolean {
  return status === "done" || status === "canceled" || status === "failed";
}

/** Seconds left on an estimate, counted down from when it was written so the
 *  line keeps moving between events. Never below zero. */
export function secondsLeft(
  eta: { seconds_left: number; at: number } | null,
  now: number,
): number | null {
  if (!eta) return null;
  return Math.max(0, Math.round(eta.seconds_left - (now - eta.at) / 1000));
}

/** "about 40 s left", "about 3 min left", "almost done". */
export function etaWords(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 3) return "almost done";
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

/** "about 20 s", "about 2 min": an estimate before anything has started. */
export function durationWords(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

/** "12 min", "45 s". */
export function tookWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
