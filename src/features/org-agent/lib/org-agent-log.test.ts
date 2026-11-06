// The log is the state: an Ask's events applied in `seq` order, gapless, and
// folded into turns. These are the web client's rules (the server repo's
// `apps/web/src/lib/atlas/log.test.ts`), checked here against every event kind
// the contract has, so the two clients cannot draw one conversation two ways.

import { describe, expect, it } from "vitest";

import {
  appendEvents,
  durationWords,
  etaWords,
  foldAsk,
  isEvent,
  lastSeq,
  mergeFresh,
  researchFinished,
  secondsLeft,
  statusAfter,
  tookWords,
  turnEnded,
  turnText,
} from "./org-agent-log";
import type { AskDetail, AskSummary, AtlasEvent, Card, EventPayloads } from "./org-agent-types";

const ASK: AskSummary = {
  id: "a1",
  title: "What shipped?",
  kind: "ask",
  created_at: 1,
  updated_at: 1,
  status: "idle",
};

let at = 1_000;
function ev<K extends keyof EventPayloads>(
  seq: number,
  kind: K,
  payload: EventPayloads[K],
): AtlasEvent {
  at += 10;
  return { t: "event", ask_id: "a1", seq, kind, at, payload } as AtlasEvent;
}

const log = (events: AtlasEvent[] = [], status: AskSummary["status"] = "idle"): AskDetail => ({
  ask: { ...ASK, status },
  events,
});

const SESSION: Card = {
  kind: "session",
  workspace_id: "w1",
  session_id: "s1",
  handle: "ses-41",
  title: "Fix expiry",
  author: "Ada",
  agent: "claude-acp",
  started_at: 1,
  live: false,
};

const user = (
  seq: number,
  text = "What shipped?",
  extra: Partial<EventPayloads["user_message"]> = {},
) => ev(seq, "user_message", { text, client_msg_id: `c${seq}`, ...extra });

describe("frames", () => {
  it("takes a well-formed event and refuses anything else", () => {
    expect(isEvent(user(1))).toBe(true);
    expect(isEvent(null)).toBe(false);
    expect(isEvent({ t: "pong" })).toBe(false);
    expect(isEvent({ ask_id: "a1", seq: 0, kind: "text_delta", at: 1, payload: {} })).toBe(false);
    expect(isEvent({ ask_id: "a1", seq: 1.5, kind: "text_delta", at: 1, payload: {} })).toBe(false);
    expect(isEvent({ ask_id: "a1", seq: 1, kind: "text_delta", at: 1, payload: null })).toBe(false);
  });
});

describe("appending", () => {
  it("appends in seq order, moving the status and the summary's time", () => {
    const {
      log: next,
      gap,
      added,
    } = appendEvents(log(), [ev(2, "text_delta", { text: "Hi" }), user(1)]);
    expect(gap).toBe(false);
    expect(added).toBe(2);
    expect(next.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(next.ask.status).toBe("running");
    // The latest time any of them was written, whatever order they came in.
    expect(next.ask.updated_at).toBe(Math.max(...next.events.map((e) => e.at)));
    expect(lastSeq(next)).toBe(2);
  });

  it("drops a duplicate a resume replays over a live frame", () => {
    const first = appendEvents(log(), [user(1)]).log;
    const again = appendEvents(first, [user(1)]);
    expect(again.added).toBe(0);
    expect(again.log).toBe(first);
  });

  it("stops at a hole and asks for a resume, applying nothing past it", () => {
    const first = appendEvents(log(), [user(1)]).log;
    const result = appendEvents(first, [ev(3, "text_delta", { text: "late" })]);
    expect(result.gap).toBe(true);
    expect(result.added).toBe(0);
    expect(lastSeq(result.log)).toBe(1);
  });

  it("applies what comes before a hole and still reports the hole", () => {
    const result = appendEvents(log(), [
      user(1),
      ev(2, "text_delta", { text: "a" }),
      ev(4, "text_delta", { text: "c" }),
    ]);
    expect(result.added).toBe(2);
    expect(result.gap).toBe(true);
  });

  it("never lets a slower REST read take an event back off the screen", () => {
    const socket = appendEvents(log(), [
      user(1),
      ev(2, "text_delta", { text: "a" }),
      ev(3, "text_delta", { text: "b" }),
    ]).log;
    const staleRead = log([socket.events[0]!]);
    const merged = mergeFresh(socket, staleRead);
    expect(merged.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // A read that is ahead wins outright.
    const ahead = log([
      ...socket.events,
      ev(4, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] }),
    ]);
    expect(mergeFresh(socket, ahead)).toBe(ahead);
    // Another Ask's read is simply that Ask.
    const other: AskDetail = { ask: { ...ASK, id: "a2" }, events: [] };
    expect(mergeFresh(socket, other)).toBe(other);
  });
});

describe("the status an event leaves", () => {
  const cases: [AtlasEvent, AskSummary["status"]][] = [
    [user(1), "running"],
    [ev(1, "text_delta", { text: "x" }), "running"],
    [ev(1, "tool_started", { call_id: "c", tool: "t", summary: "s" }), "running"],
    [ev(1, "tool_result", { call_id: "c", tool: "t", summary: "s", cards: [] }), "running"],
    [ev(1, "plan", { steps: [] }), "running"],
    [ev(1, "approval_resolved", { approval_id: "p", decision: "approve" }), "running"],
    [ev(1, "approval_required", { approval_id: "p", card: {} as never }), "waiting_approval"],
    [
      ev(1, "question", { question_id: "q", text: "?", options: [], allow_text: true }),
      "waiting_answer",
    ],
    [ev(1, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] }), "idle"],
    [ev(1, "limit_reached", { which: "rounds", can_continue: true }), "idle"],
    [ev(1, "error", { code: "x", message: "y" }), "idle"],
    [ev(1, "report", {} as never), "idle"],
  ];
  it.each(cases)("%#: %o", (event, status) => {
    expect(statusAfter(event, "waiting_answer")).toBe(status);
  });

  it("leaves it alone for the events that say nothing about it", () => {
    for (const e of [
      ev(1, "memory_updated", { item_id: "m", text: "t" }),
      ev(1, "compacted", { through_seq: 3 }),
      ev(1, "eta", { seconds_left: 5, phase: "thinking", steps_done: 0, steps_planned: 1 }),
    ]) {
      expect(statusAfter(e, "waiting_approval")).toBe("waiting_approval");
    }
  });

  it("ends the turn on a job that failed or was canceled, and never restarts a finished one", () => {
    const research = (status: EventPayloads["research"]["status"]) =>
      ev(1, "research", {
        job_id: "j",
        status,
        question: "q",
        steps: [],
        eta: { seconds_left: 1, phase: "x", steps_done: 0, steps_planned: 0 },
        started_at: 1,
      });
    expect(statusAfter(research("failed"), "running")).toBe("idle");
    expect(statusAfter(research("canceled"), "running")).toBe("idle");
    expect(statusAfter(research("researching"), "idle")).toBe("running");
    // The `research{done}` after a report leaves the turn as the report did.
    expect(statusAfter(research("done"), "idle")).toBe("idle");
  });
});

describe("folding a log into turns", () => {
  it("draws an answer: streamed text joined, tool calls paired with their results, cards collected", () => {
    const view = foldAsk([
      user(1, "What did Ada ship?", {
        effort: "low",
        mentions: [{ kind: "person", id: "u1", label: "Ada" }],
      }),
      ev(2, "eta", {
        seconds_left: 12,
        phase: "thinking",
        steps_done: 0,
        steps_planned: 3,
        effort: "low",
      }),
      ev(3, "tool_started", {
        call_id: "t1",
        tool: "sessions_find",
        summary: "Searching Sessions by Ada",
      }),
      ev(4, "tool_started", { call_id: "t2", tool: "people_find", summary: "Finding Ada" }),
      ev(5, "tool_result", {
        call_id: "t1",
        tool: "sessions_find",
        summary: "Found 1 Session",
        cards: [SESSION],
      }),
      ev(6, "tool_result", {
        call_id: "t2",
        tool: "people_find",
        summary: "Found Ada",
        cards: [],
        truncated: true,
      }),
      ev(7, "text_delta", { text: "Ada fixed " }),
      ev(8, "text_delta", { text: "expiry in ses-41." }),
      ev(9, "answer_done", { usage: { input_tokens: 10, output_tokens: 5 }, uncited: [] }),
    ]);
    expect(view.turns).toHaveLength(1);
    const turn = view.turns[0]!;
    expect(turn.user?.effort).toBe("low");
    expect(turn.user?.mentions?.[0]?.label).toBe("Ada");
    expect(turn.blocks.map((b) => b.kind)).toEqual(["tool", "tool", "text"]);
    const [t1, t2] = turn.blocks as Extract<(typeof turn.blocks)[number], { kind: "tool" }>[];
    expect(t1).toMatchObject({ done: true, summary: "Found 1 Session", cards: [SESSION] });
    expect(t2).toMatchObject({ done: true, truncated: true });
    expect(turnText(turn)).toBe("Ada fixed expiry in ses-41.");
    expect(turn.doneSeq).toBe(9);
    expect(turn.eta?.seconds_left).toBe(12);
    expect(turn.endedAt).toBe(turn.at + 80);
    expect(turnEnded(turn)).toBe(true);
    expect(view.cards).toEqual([SESSION]);
  });

  it("draws a result whose start it never saw (a log read mid-turn)", () => {
    const view = foldAsk([
      user(1),
      ev(2, "tool_result", { call_id: "x", tool: "t", summary: "Read it", cards: [] }),
    ]);
    expect(view.turns[0]!.blocks).toEqual([
      {
        kind: "tool",
        call_id: "x",
        tool: "t",
        summary: "Read it",
        done: true,
        cards: [],
        truncated: false,
      },
    ]);
  });

  it("keeps a running tool as running, and the turn as not ended", () => {
    const view = foldAsk([
      user(1),
      ev(2, "tool_started", { call_id: "x", tool: "t", summary: "Reading" }),
    ]);
    const turn = view.turns[0]!;
    expect((turn.blocks[0] as { done: boolean }).done).toBe(false);
    expect(turnEnded(turn)).toBe(false);
  });

  it("lists an approval as pending until it is resolved, and keeps what it made", () => {
    const card = {
      tool: "send_message",
      title: "Send a message",
      rows: [{ target: { kind: "conversation", id: "c1", name: "#team" }, selected: true }],
      body: "Shipped",
      notifies: [],
      visible_to: { kind: "org", description: "everyone" },
      warnings: [],
      editable_body: true,
    };
    const asked = foldAsk([user(1), ev(2, "approval_required", { approval_id: "p1", card })]);
    expect(asked.approvals.map((a) => a.approval_id)).toEqual(["p1"]);

    const message: Card = {
      kind: "message",
      conv_id: "c1",
      message_id: "m1",
      author: "Ada",
      excerpt: "Shipped",
      at: 1,
    };
    const done = foldAsk([
      user(1),
      ev(2, "approval_required", { approval_id: "p1", card }),
      ev(3, "approval_resolved", {
        approval_id: "p1",
        decision: "approve",
        executed: { ok: true, cards: [message] },
      }),
    ]);
    expect(done.approvals).toEqual([]);
    const block = done.turns[0]!.blocks[0] as Extract<
      (typeof done.turns)[0]["blocks"][number],
      { kind: "approval" }
    >;
    expect(block.resolved?.executed?.ok).toBe(true);
    expect(done.cards).toEqual([message]);
  });

  it("marks a question answered once the turn moves on", () => {
    const q = ev(2, "question", {
      question_id: "q1",
      text: "Which project?",
      options: [{ id: "a", label: "Atlas" }],
      allow_text: false,
    });
    const open = foldAsk([user(1), q]);
    expect((open.turns[0]!.blocks[0] as { answered: boolean }).answered).toBe(false);
    const answered = foldAsk([user(1), q, ev(3, "text_delta", { text: "In Atlas…" })]);
    expect((answered.turns[0]!.blocks[0] as { answered: boolean }).answered).toBe(true);
  });

  it("replaces the plan whole each time", () => {
    const view = foldAsk([
      user(1),
      ev(2, "plan", {
        steps: [
          { text: "Find", status: "in_progress" },
          { text: "Write", status: "pending" },
        ],
      }),
      ev(3, "plan", {
        steps: [
          { text: "Find", status: "done" },
          { text: "Write", status: "in_progress" },
        ],
      }),
    ]);
    expect(view.turns[0]!.plan?.map((s) => s.status)).toEqual(["done", "in_progress"]);
  });

  it("keeps a limit, an error and a memory note on their turn", () => {
    const view = foldAsk([
      user(1),
      ev(2, "memory_updated", { item_id: "m1", text: "Prefers tables" }),
      ev(3, "limit_reached", { which: "tool_calls", can_continue: true }),
      ev(4, "text_delta", { text: "Partial" }),
      ev(5, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: ["ses-9"] }),
      user(6, "Again"),
      ev(7, "error", { code: "model", message: "The model failed." }),
    ]);
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]!.limit).toEqual({ which: "tool_calls", can_continue: true });
    expect(view.turns[0]!.memory[0]!.text).toBe("Prefers tables");
    expect(view.turns[0]!.done?.uncited).toEqual(["ses-9"]);
    expect(view.turns[1]!.error?.message).toBe("The model failed.");
    expect(turnEnded(view.turns[1]!)).toBe(true);
  });

  it("follows a Deep research job by its latest event, then the report", () => {
    const research = (
      seq: number,
      status: EventPayloads["research"]["status"],
      steps: EventPayloads["research"]["steps"] = [],
    ) =>
      ev(seq, "research", {
        job_id: "j1",
        status,
        question: "Payments this month",
        steps,
        eta: { seconds_left: 240, phase: status, steps_done: 0, steps_planned: steps.length },
        started_at: 1,
      });
    const running = foldAsk([
      user(1, "Payments this month", { mode: "deep_research" }),
      research(2, "queued"),
      research(3, "researching", [
        { id: "s1", question: "Who?", status: "running", tool_calls: 2 },
      ]),
    ]);
    const turn = running.turns[0]!;
    expect(turn.user?.mode).toBe("deep_research");
    expect(turn.research?.status).toBe("researching");
    expect(turn.research?.steps[0]?.tool_calls).toBe(2);
    expect(turnEnded(turn)).toBe(false);

    const reportEvent = ev(3, "report", {
      job_id: "j1",
      title: "Payments",
      text: "It was ses-41.",
      cards: [SESSION],
      steps: [],
      partial: true,
      usage: { input_tokens: 1, output_tokens: 1 },
      uncited: [],
      duration_ms: 512_000,
    });
    const reported = foldAsk([
      user(1, "Payments this month", { mode: "deep_research" }),
      research(2, "writing"),
      ev(3, "report", {
        job_id: "j1",
        title: "Payments",
        text: "It was ses-41.",
        cards: [SESSION],
        steps: [],
        partial: true,
        usage: { input_tokens: 1, output_tokens: 1 },
        uncited: [],
        duration_ms: 512_000,
      }),
      research(4, "done"),
    ]);
    expect(reported.turns[0]!.report?.partial).toBe(true);
    // What production sends, in order: the Ask ends idle, not "working".
    const applied = appendEvents(log(), [
      user(1, "Payments this month", { mode: "deep_research" }),
      research(2, "writing"),
      { ...reportEvent, seq: 3 } as AtlasEvent,
      research(4, "done"),
    ]);
    expect(applied.log.ask.status).toBe("idle");
    expect(reported.turns[0]!.research?.status).toBe("done");
    expect(reported.cards).toEqual([SESSION]);
    expect(turnEnded(reported.turns[0]!)).toBe(true);

    const failed = foldAsk([user(1, "x", { mode: "deep_research" }), research(2, "failed")]);
    expect(turnEnded(failed.turns[0]!)).toBe(true);
  });

  it("draws a Loop run, which has no message from the member, as one turn", () => {
    const view = foldAsk([
      ev(1, "text_delta", { text: "Morning digest" }),
      ev(2, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] }),
    ]);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]!.key).toBe(0);
    expect(view.turns[0]!.user).toBeNull();
  });

  it("notes compaction and skips kinds it does not know", () => {
    const unknown = {
      t: "event",
      ask_id: "a1",
      seq: 3,
      kind: "brand_new_kind",
      at: 5,
      payload: {},
    } as unknown as AtlasEvent;
    const view = foldAsk([
      user(1),
      ev(2, "compacted", { through_seq: 1 }),
      unknown,
      ev(4, "text_delta", { text: "ok" }),
    ]);
    expect(view.compactedThrough).toBe(1);
    expect(turnText(view.turns[0]!)).toBe("ok");
  });
});

describe("words for time", () => {
  it("counts an estimate down between events, never below zero", () => {
    expect(secondsLeft(null, 0)).toBeNull();
    expect(secondsLeft({ seconds_left: 20, at: 0 }, 5_000)).toBe(15);
    expect(secondsLeft({ seconds_left: 2, at: 0 }, 60_000)).toBe(0);
  });

  it("says what is left the way the web does", () => {
    expect(etaWords(null)).toBeNull();
    expect(etaWords(2)).toBe("almost done");
    expect(etaWords(12)).toBe("about 10 s left");
    expect(etaWords(4)).toBe("about 5 s left");
    expect(etaWords(150)).toBe("about 3 min left");
    expect(durationWords(7)).toBe("about 5 s");
    expect(durationWords(600)).toBe("about 10 min");
    expect(tookWords(45_000)).toBe("45 s");
    expect(tookWords(512_000)).toBe("9 min");
    expect(tookWords(3_900_000)).toBe("1 h 5 min");
  });

  it("knows which research phases are over", () => {
    expect(["done", "canceled", "failed"].every((s) => researchFinished(s as never))).toBe(true);
    expect(
      ["queued", "planning", "researching", "writing"].some((s) => researchFinished(s as never)),
    ).toBe(false);
  });
});
