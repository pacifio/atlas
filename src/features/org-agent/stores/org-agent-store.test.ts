// @vitest-environment happy-dom
//
// The Organisation agent's store: the web client's protocol rules over the
// desktop's bridge. Rust is mocked at its seam (`org-agent-api.ts`); every
// frame the store would send is captured, and server frames are fed in the
// way Rust emits them (`atlas:org-agent` envelopes).
//
// Covered: a new chat's first message and the echo that names its Ask; every
// later message; gaps and resumes; reconnects re-sending the outbox and
// resuming each log; refusals, Retry and Discard; Stop; Deep research and its
// Cancel; approvals and questions; votes; effort; loops; unread marks; and an
// Organisation switch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  open: true,
  asks: vi.fn(),
  ask: vi.fn(),
  atlasStatus: vi.fn(),
  effort: vi.fn(),
  saveDefaultEffort: vi.fn(),
  notifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  rate: vi.fn(),
  deleteAsk: vi.fn(),
  loops: vi.fn(),
  createLoop: vi.fn(),
  setLoopStatus: vi.fn(),
  deleteLoop: vi.fn(),
}));

vi.mock("../lib/org-agent-api", async (actual) => {
  const real = await actual<typeof import("../lib/org-agent-api")>();
  return {
    ...real,
    orgAgent: {
      ...real.orgAgent,
      send: vi.fn(async (frame: Record<string, unknown>) => {
        if (!api.open) return false;
        api.sent.push(frame);
        return true;
      }),
      asks: api.asks,
      ask: api.ask,
      atlasStatus: api.atlasStatus,
      effort: api.effort,
      saveDefaultEffort: api.saveDefaultEffort,
      notifications: api.notifications,
      markNotificationsRead: api.markNotificationsRead,
      rate: api.rate,
      deleteAsk: api.deleteAsk,
      loops: api.loops,
      createLoop: api.createLoop,
      setLoopStatus: api.setLoopStatus,
      deleteLoop: api.deleteLoop,
    },
  };
});

import { OrgAgentError } from "../lib/org-agent-api";
import type { AskDetail, EffortResponse, EventPayloads, Loop } from "../lib/org-agent-types";
import {
  askBusy,
  askTitle,
  askWaiting,
  isTempAsk,
  pendingFor,
  resetOrgAgentSessionForTests,
  useOrgAgentStore,
} from "./org-agent-store";

const ORG = "org_1";
const actions = () => useOrgAgentStore.getState().actions;
const state = () => useOrgAgentStore.getState();
/** Let the mocked bridge's promises settle — microtasks only, so it works
 *  under fake timers too. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let at = 1_000;
function frame<K extends keyof EventPayloads>(
  askId: string,
  seq: number,
  kind: K,
  payload: EventPayloads[K],
) {
  at += 10;
  actions().onEnvelope({
    org: ORG,
    epoch: 1,
    ev: {
      kind: "frame",
      frame: JSON.stringify({ t: "event", ask_id: askId, seq, kind, at, payload }),
    },
  });
}
function serverFrame(body: Record<string, unknown>, org = ORG) {
  actions().onEnvelope({ org, epoch: 1, ev: { kind: "frame", frame: JSON.stringify(body) } });
}
function connection(
  s: "open" | "connecting" | "backoff" | "unavailable" | "disconnected",
  org = ORG,
) {
  actions().onEnvelope({
    org: s === "disconnected" ? "" : org,
    epoch: 1,
    ev: { kind: "connection", state: s },
  });
}
const sent = (t: string) => api.sent.filter((f) => f.t === t);
const lastSent = () => {
  const all = sent("ask.send");
  return all[all.length - 1]!;
};

const EFFORT: EffortResponse = {
  default: "high",
  levels: [],
  deep_research: {
    allowed: true,
    per_day: 5,
    used_today: 0,
    remaining: 5,
    eta_seconds: 600,
    measured: false,
    model: "m",
    running: [],
  },
};

function detail(
  id: string,
  events: AskDetail["events"] = [],
  feedback: AskDetail["feedback"] = [],
): AskDetail {
  return {
    ask: { id, title: "Earlier", kind: "ask", created_at: 1, updated_at: 2, status: "idle" },
    events,
    feedback,
  };
}

beforeEach(() => {
  resetOrgAgentSessionForTests();
  api.sent = [];
  api.open = true;
  for (const fn of Object.values(api))
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  api.asks.mockResolvedValue({ asks: [], next_cursor: null });
  api.ask.mockImplementation(async (id: string) => detail(id));
  api.atlasStatus.mockResolvedValue({
    enabled: true,
    loops_enabled: true,
    model: "glm",
    limits: { turns_per_day: 200, turns_today: 3, actions_per_day: 50, actions_today: 0 },
    admin: false,
  });
  api.effort.mockResolvedValue(EFFORT);
  api.saveDefaultEffort.mockResolvedValue({ default_effort: "low" });
  api.notifications.mockResolvedValue({ items: [], unread: 0 });
  api.markNotificationsRead.mockResolvedValue({ ok: true });
  api.rate.mockResolvedValue(null);
  api.deleteAsk.mockResolvedValue(null);
  api.loops.mockResolvedValue({ loops: [] });
  useOrgAgentStore.setState({
    orgId: null,
    connection: "disconnected",
    asks: {},
    asksLoaded: false,
    asksCursor: null,
    asksOlderLoaded: false,
    asksError: null,
    logs: {},
    loading: [],
    loadErrors: {},
    votes: {},
    outbox: [],
    deciding: [],
    answering: [],
    error: null,
    atlas: null,
    effortInfo: null,
    notifications: null,
    loops: null,
    loopsError: null,
    tabs: [],
    activeId: null,
    floatingId: null,
    pageId: null,
    pageView: "chat",
    unread: [],
    pinned: [],
    effort: "medium",
    deepResearch: false,
  });
  connection("open");
});

afterEach(() => {
  vi.useRealTimers();
});

/** A new chat in the panel, its first message sent, and the server's echo. */
async function startAsk(text = "What shipped?", askId = "a1") {
  const temp = actions().newChat();
  actions().send(temp, text);
  await flush();
  const msg = lastSent()!;
  frame(askId, 1, "user_message", {
    text,
    client_msg_id: msg.client_msg_id as string,
    effort: "medium",
  });
  await flush();
  return { temp, askId };
}

describe("connecting", () => {
  it("reads the list, today's limits, the levels and the notifications when the socket opens", async () => {
    await flush();
    expect(state().connection).toBe("open");
    expect(state().orgId).toBe(ORG);
    expect(api.asks).toHaveBeenCalled();
    expect(api.atlasStatus).toHaveBeenCalled();
    expect(api.effort).toHaveBeenCalled();
    expect(api.notifications).toHaveBeenCalled();
    expect(state().atlas?.limits.turns_today).toBe(3);
    // The member's saved default is the composer's level.
    expect(state().effort).toBe("high");
  });

  it("drops another Organisation's frames, and its Asks when the socket moves", async () => {
    await startAsk();
    serverFrame(
      {
        t: "event",
        ask_id: "zzz",
        seq: 1,
        kind: "user_message",
        at: 1,
        payload: { text: "x", client_msg_id: "c" },
      },
      "org_other",
    );
    expect(state().asks.zzz).toBeUndefined();

    connection("open", "org_2");
    expect(state().orgId).toBe("org_2");
    expect(state().asks).toEqual({});
    expect(state().logs).toEqual({});
    expect(state().tabs).toEqual([]);
    connection("disconnected");
    expect(state().orgId).toBeNull();
  });
});

describe("a new conversation", () => {
  it("sends the first message optimistically, with the level, the time zone and the mentions", async () => {
    const temp = actions().newChat();
    expect(isTempAsk(temp)).toBe(true);
    expect(state().tabs).toEqual([temp]);
    expect(state().activeId).toBe(temp);
    expect(askTitle(state(), temp)).toBe("New chat");

    actions().send(temp, "  What did @Ada ship?\nmore  ", {
      mentions: [{ kind: "person", id: "u1", label: "Ada" }],
      effort: "low",
    });
    await flush();
    const msg = sent("ask.send")[0]!;
    expect(msg).toMatchObject({
      t: "ask.send",
      text: "What did @Ada ship?\nmore",
      effort: "low",
      mentions: [{ kind: "person", id: "u1", label: "Ada" }],
      context: { route: "/agent" },
    });
    expect(msg).not.toHaveProperty("ask_id");
    expect(typeof (msg.context as { tz?: string }).tz).toBe("string");
    // Drawn at once, titled by its first line, as working.
    expect(pendingFor(state().outbox, temp)).toHaveLength(1);
    expect(askTitle(state(), temp)).toBe("What did @Ada ship?");
    expect(askBusy(state(), temp)).toBe(true);
  });

  it("becomes the real Ask everywhere it was shown when the echo names it", async () => {
    const temp = actions().newChat();
    actions().togglePin(temp);
    actions().fullScreen(temp);
    actions().send(temp, "What shipped?");
    await flush();
    const msg = sent("ask.send")[0]!;
    frame("a1", 1, "user_message", {
      text: "What shipped?",
      client_msg_id: msg.client_msg_id as string,
    });
    await flush();

    const s = state();
    expect(s.tabs).toEqual(["a1"]);
    expect(s.activeId).toBe("a1");
    expect(s.pageId).toBe("a1");
    expect(s.pinned).toEqual(["a1"]);
    expect(s.asks[temp]).toBeUndefined();
    expect(s.asks.a1).toMatchObject({ id: "a1", title: "What shipped?", status: "running" });
    expect(s.outbox).toEqual([]);
    expect(s.logs.a1?.events.map((e) => e.seq)).toEqual([1]);
    // Seeded from the echo: no read needed.
    expect(api.ask).not.toHaveBeenCalled();
  });

  it("reads the whole log when the echo is not the Ask's first event", async () => {
    const temp = actions().newChat();
    actions().send(temp, "Again");
    await flush();
    const msg = sent("ask.send")[0]!;
    frame("a5", 7, "user_message", { text: "Again", client_msg_id: msg.client_msg_id as string });
    await flush();
    expect(api.ask).toHaveBeenCalledWith("a5");
  });
});

describe("a conversation in progress", () => {
  it("streams an answer into the log and ends idle and unread when nobody is looking", async () => {
    const { askId } = await startAsk();
    actions().newChat(); // the panel moves on to another tab
    frame(askId, 2, "tool_started", { call_id: "t1", tool: "sessions_find", summary: "Searching" });
    expect(askBusy(state(), askId)).toBe(true);
    frame(askId, 3, "tool_result", {
      call_id: "t1",
      tool: "sessions_find",
      summary: "Found 2",
      cards: [],
    });
    frame(askId, 4, "text_delta", { text: "Two sessions." });
    frame(askId, 5, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] });
    expect(state().logs[askId]?.events).toHaveLength(5);
    expect(state().asks[askId]?.status).toBe("idle");
    expect(askBusy(state(), askId)).toBe(false);
    expect(state().unread).toEqual([askId]);
    actions().activate(askId);
    expect(state().unread).toEqual([]);
  });

  it("does not mark unread what is on screen", async () => {
    const { askId } = await startAsk();
    frame(askId, 2, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] });
    expect(state().unread).toEqual([]);
  });

  it("sends a follow-up into the same Ask", async () => {
    const { askId } = await startAsk();
    actions().send(askId, "And yesterday?");
    await flush();
    expect(lastSent()).toMatchObject({ ask_id: askId, text: "And yesterday?" });
  });

  it("asks for a resume from the last event it holds when a frame was missed, once per hole", async () => {
    const { askId } = await startAsk();
    frame(askId, 4, "text_delta", { text: "late" });
    frame(askId, 5, "text_delta", { text: "later" });
    await flush();
    expect(sent("resume")).toEqual([{ t: "resume", ask_id: askId, after_seq: 1 }]);
    expect(state().logs[askId]?.events).toHaveLength(1);
    // The replay fills it in.
    frame(askId, 2, "text_delta", { text: "a" });
    frame(askId, 3, "text_delta", { text: "b" });
    frame(askId, 4, "text_delta", { text: "late" });
    expect(state().logs[askId]?.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the list honest for an Ask it has not read, and reads the list for one it has never seen", async () => {
    vi.useFakeTimers();
    useOrgAgentStore.setState({
      asks: {
        a9: { id: "a9", title: "Other", kind: "ask", created_at: 1, updated_at: 1, status: "idle" },
      },
    });
    frame("a9", 4, "tool_started", { call_id: "x", tool: "t", summary: "s" });
    expect(state().asks.a9?.status).toBe("running");
    api.asks.mockClear();
    frame("new-from-web", 1, "user_message", { text: "From the web", client_msg_id: "web" });
    await vi.advanceTimersByTimeAsync(400);
    expect(api.asks).toHaveBeenCalled();
  });
});

describe("the socket coming back", () => {
  it("re-sends what is still on its way and resumes every log it holds", async () => {
    const { askId } = await startAsk();
    frame(askId, 2, "text_delta", { text: "x" });
    api.open = false;
    actions().send(askId, "While offline");
    await flush();
    expect(sent("ask.send").filter((f) => f.text === "While offline")).toHaveLength(0);
    expect(pendingFor(state().outbox, askId)).toHaveLength(1);

    api.open = true;
    connection("backoff");
    connection("open");
    await flush();
    const resent = sent("ask.send").filter((f) => f.text === "While offline");
    expect(resent).toHaveLength(1);
    expect(resent[0]!.client_msg_id).toBe(state().outbox[0]!.clientMsgId);
    expect(sent("resume")).toContainEqual({ t: "resume", ask_id: askId, after_seq: 2 });
  });
});

describe("refusals", () => {
  it("marks the message it answered as not sent, which Retry sends again under the same id", async () => {
    const temp = actions().newChat();
    actions().send(temp, "One too many");
    await flush();
    serverFrame({
      t: "error",
      code: "turns_per_day",
      message: "You have asked as many questions as you can today.",
    });
    const failed = state().outbox[0]!;
    expect(failed.failed).toMatch(/as many questions/);
    expect(askBusy(state(), temp)).toBe(false);

    api.sent = [];
    actions().retrySend(failed.clientMsgId);
    await flush();
    expect(sent("ask.send")[0]!.client_msg_id).toBe(failed.clientMsgId);
    expect(state().outbox[0]!.failed).toBeNull();
  });

  it("forgets a discarded message and the Ask it would have started", async () => {
    const temp = actions().newChat();
    actions().send(temp, "Never mind");
    await flush();
    serverFrame({ t: "error", code: "bad_request", message: "Too long." });
    actions().discardSend(state().outbox[0]!.clientMsgId);
    expect(state().outbox).toEqual([]);
    expect(state().asks[temp]).toBeUndefined();
  });

  it("shows a refusal that answers no message", () => {
    serverFrame({ t: "error", code: "not_found", message: "That card is no longer waiting." });
    expect(state().error).toEqual({
      code: "not_found",
      message: "That card is no longer waiting.",
    });
    actions().clearError();
    expect(state().error).toBeNull();
  });
});

describe("controlling a turn", () => {
  it("stops a running turn, and reads the server's account after", async () => {
    vi.useFakeTimers();
    const { askId } = await startAsk();
    actions().stop(askId);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent("ask.stop")).toEqual([{ t: "ask.stop", ask_id: askId }]);
    expect(state().asks[askId]?.status).toBe("idle");
    api.ask.mockClear();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(api.ask).toHaveBeenCalledWith(askId);
  });

  it("asks the last question again with its own mentions and level", async () => {
    const temp = actions().newChat();
    actions().send(temp, "About @Ada", {
      mentions: [{ kind: "person", id: "u1", label: "Ada" }],
      effort: "max",
    });
    await flush();
    const msg = sent("ask.send")[0]!;
    frame("a1", 1, "user_message", {
      text: "About @Ada",
      client_msg_id: msg.client_msg_id as string,
      effort: "max",
      mentions: [{ kind: "person", id: "u1", label: "Ada" }],
    });
    frame("a1", 2, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] });
    actions().regenerate("a1");
    await flush();
    expect(lastSent()).toMatchObject({
      ask_id: "a1",
      text: "About @Ada",
      effort: "max",
      mentions: [{ kind: "person", id: "u1", label: "Ada" }],
    });
  });
});

describe("Deep research", () => {
  it("sends a research request without a level, once, and turns the toggle back off", async () => {
    actions().setDeepResearch(true);
    const temp = actions().newChat();
    actions().send(temp, "Research payments", { deepResearch: true, effort: "high" });
    await flush();
    const msg = sent("ask.send")[0]!;
    expect(msg.mode).toBe("deep_research");
    expect(msg).not.toHaveProperty("effort");
    expect(state().deepResearch).toBe(false);
  });

  it("cancels a job by its id", async () => {
    const { askId } = await startAsk();
    actions().cancelResearch(askId, "j1");
    await flush();
    expect(sent("research.cancel")).toEqual([
      { t: "research.cancel", ask_id: askId, job_id: "j1" },
    ]);
  });

  it("reads the allowance and the notifications again when a report lands, and says so", async () => {
    vi.useFakeTimers();
    const { askId } = await startAsk("Research", "a1");
    const heard = vi.fn();
    window.addEventListener("atlas:org-agent-report", heard);
    api.effort.mockClear();
    api.notifications.mockClear();
    frame(askId, 2, "report", {
      job_id: "j1",
      title: "Payments",
      text: "…",
      cards: [],
      steps: [],
      partial: false,
      usage: { input_tokens: 1, output_tokens: 1 },
      uncited: [],
      duration_ms: 1,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.effort).toHaveBeenCalled();
    expect(api.notifications).toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      askId,
      title: "Payments",
    });
    window.removeEventListener("atlas:org-agent-report", heard);
  });

  it("marks a report's notification read when its conversation is opened", async () => {
    useOrgAgentStore.setState({
      notifications: {
        unread: 1,
        items: [
          {
            id: "n1",
            kind: "deep_research_done",
            ask_id: "a7",
            job_id: "j",
            title: "t",
            excerpt: "",
            partial: false,
            at: 1,
            read: false,
          },
        ],
      },
    });
    await actions().openAsk("a7");
    await flush();
    expect(api.markNotificationsRead).toHaveBeenCalledWith({ ids: ["n1"] });
  });
});

describe("approvals and questions", () => {
  it("sends a decision and holds it as working until the server resolves it", async () => {
    const { askId } = await startAsk();
    frame(askId, 2, "approval_required", { approval_id: "p1", card: {} as never });
    expect(askWaiting(state(), askId)).toBe(true);
    expect(
      actions().decide({ approval_id: "p1", decision: "approve", edited_body: "Edited" }),
    ).toBe(true);
    await flush();
    expect(sent("approval.decide")).toEqual([
      { t: "approval.decide", approval_id: "p1", decision: "approve", edited_body: "Edited" },
    ]);
    expect(state().deciding).toEqual(["p1"]);
    frame(askId, 3, "approval_resolved", {
      approval_id: "p1",
      decision: "approve",
      executed: { ok: true, cards: [] },
    });
    expect(state().deciding).toEqual([]);
    expect(askWaiting(state(), askId)).toBe(false);
  });

  it("does not decide while the socket is down", () => {
    connection("backoff");
    expect(actions().decide({ approval_id: "p1", decision: "decline" })).toBe(false);
    expect(state().deciding).toEqual([]);
  });

  it("answers a question by choice or in words, and moves past it when the turn goes on", async () => {
    const { askId } = await startAsk();
    frame(askId, 2, "question", {
      question_id: "q1",
      text: "Which?",
      options: [{ id: "a", label: "A" }],
      allow_text: true,
    });
    expect(actions().answer("q1", { choice: "a" })).toBe(true);
    await flush();
    expect(sent("question.answer")).toEqual([
      { t: "question.answer", question_id: "q1", choice: "a" },
    ]);
    expect(state().answering).toEqual(["q1"]);
    frame(askId, 3, "text_delta", { text: "A it is." });
    expect(state().answering).toEqual([]);
  });

  it("clears decisions in flight when the server says the card is gone", () => {
    useOrgAgentStore.setState({ deciding: ["p1"], answering: ["q1"] });
    serverFrame({ t: "error", code: "not_found", message: "Gone." });
    expect(state().deciding).toEqual([]);
    expect(state().answering).toEqual([]);
  });
});

describe("rating an answer", () => {
  it("is drawn at once and kept when the server takes it", async () => {
    actions().vote("a1", 5, "up");
    expect(state().votes.a1?.[5]).toBe("up");
    await flush();
    expect(api.rate).toHaveBeenCalledWith("a1", 5, "up");
    expect(state().votes.a1?.[5]).toBe("up");
  });

  it("goes back to what it was when the server refuses", async () => {
    useOrgAgentStore.setState({ votes: { a1: { 5: "down" } } });
    api.rate.mockRejectedValueOnce(new OrgAgentError("not_found", "Not found."));
    actions().vote("a1", 5, "up");
    await flush();
    await flush();
    expect(state().votes.a1?.[5]).toBe("down");
  });

  it("reads the ratings the server holds with the log", async () => {
    api.ask.mockResolvedValueOnce(detail("a2", [], [{ event_seq: 9, rating: "up" }]));
    await actions().openAsk("a2");
    expect(state().votes.a2).toEqual({ 9: "up" });
  });
});

describe("the history", () => {
  it("lists the server's conversations and keeps one still starting", async () => {
    const temp = actions().newChat();
    actions().send(temp, "Starting");
    api.asks.mockResolvedValueOnce({
      asks: [
        { id: "a1", title: "Earlier", kind: "ask", created_at: 1, updated_at: 5, status: "idle" },
      ],
      next_cursor: "5.a1",
    });
    await actions().loadAsks();
    expect(Object.keys(state().asks).sort()).toEqual(["a1", temp].sort());
    expect(state().asksCursor).toBe("5.a1");

    api.asks.mockResolvedValueOnce({
      asks: [
        { id: "a0", title: "Oldest", kind: "ask", created_at: 0, updated_at: 1, status: "idle" },
      ],
      next_cursor: null,
    });
    await actions().loadMoreAsks();
    expect(state().asks.a0?.title).toBe("Oldest");
    expect(state().asksCursor).toBeNull();
  });

  it("says why the list could not be read", async () => {
    api.asks.mockRejectedValueOnce(
      new OrgAgentError("atlas_off", "Atlas is turned off for this organisation."),
    );
    await actions().loadAsks();
    expect(state().asksError).toBe("Atlas is turned off for this organisation.");
  });

  it("deletes a conversation on the server and everywhere it was shown", async () => {
    const { askId } = await startAsk();
    actions().togglePin(askId);
    await actions().deleteConversation(askId);
    expect(api.deleteAsk).toHaveBeenCalledWith(askId);
    expect(state().asks[askId]).toBeUndefined();
    expect(state().logs[askId]).toBeUndefined();
    expect(state().tabs).toEqual([]);
    expect(state().pinned).toEqual([]);
  });

  it("closes a tab without deleting the conversation", async () => {
    const { askId } = await startAsk();
    actions().closeTab(askId);
    expect(state().tabs).toEqual([]);
    expect(state().asks[askId]).toBeDefined();
    expect(api.deleteAsk).not.toHaveBeenCalled();
  });
});

describe("effort", () => {
  it("saves the pick as the member's default, shared with the web", () => {
    actions().setEffort("low");
    expect(state().effort).toBe("low");
    expect(api.saveDefaultEffort).toHaveBeenCalledWith("low");
  });

  it("turns Deep research off when none is left today", async () => {
    actions().setDeepResearch(true);
    api.effort.mockResolvedValueOnce({
      ...EFFORT,
      deep_research: { ...EFFORT.deep_research, remaining: 0 },
    });
    await actions().refreshEffort();
    expect(state().deepResearch).toBe(false);
  });
});

describe("Loops", () => {
  const loop: Loop = {
    id: "l1",
    creator: "u1",
    name: "Morning digest",
    instruction: "Summarise yesterday",
    trigger: { schedule: { every: "daily", at: "09:00", tz: "Asia/Dhaka" } },
    output: { kind: "dm_self" },
    status: "active",
    runs_today: 0,
    last_run_at: null,
    next_run_at: null,
    note: null,
    created_at: 1,
  };

  it("lists, creates, pauses and deletes", async () => {
    api.loops.mockResolvedValueOnce({ loops: [loop] });
    await actions().loadLoops();
    expect(state().loops).toEqual([loop]);

    const created = { ...loop, id: "l2", name: "Checkpoint watch" };
    api.createLoop.mockResolvedValueOnce(created);
    await actions().createLoop({
      name: created.name,
      instruction: "x",
      trigger: loop.trigger,
      output: loop.output,
    });
    expect(state().loops?.map((l) => l.id)).toEqual(["l2", "l1"]);

    api.setLoopStatus.mockResolvedValueOnce({ ...loop, status: "paused" });
    await actions().setLoopStatus("l1", "paused");
    expect(state().loops?.find((l) => l.id === "l1")?.status).toBe("paused");

    api.deleteLoop.mockResolvedValueOnce(null);
    await actions().deleteLoop("l2");
    expect(state().loops?.map((l) => l.id)).toEqual(["l1"]);
  });

  it("puts a Loop back as it was when the server refuses the change", async () => {
    useOrgAgentStore.setState({ loops: [loop] });
    api.setLoopStatus.mockRejectedValueOnce(new OrgAgentError("not_found", "Not found."));
    await expect(actions().setLoopStatus("l1", "paused")).rejects.toThrow();
    expect(state().loops?.[0]?.status).toBe("active");
    api.deleteLoop.mockRejectedValueOnce(new OrgAgentError("not_found", "Not found."));
    await expect(actions().deleteLoop("l1")).rejects.toThrow();
    expect(state().loops).toEqual([loop]);
  });

  it("lists everyone's Loops for an admin", async () => {
    useOrgAgentStore.setState({ atlas: { ...state().atlas!, admin: true } });
    await actions().loadLoops();
    expect(api.loops).toHaveBeenCalledWith(true);
  });
});

describe("placement", () => {
  it("moves a conversation between the panel, the messenger and the page, one place at a time", async () => {
    const { askId } = await startAsk();
    actions().minimise(askId);
    expect(state().floatingId).toBe(askId);
    actions().fullScreen(askId);
    expect(state().pageId).toBe(askId);
    expect(state().floatingId).toBeNull();
    actions().restoreToPanel(askId);
    expect(state().pageId).toBeNull();
    expect(state().activeId).toBe(askId);
    actions().setPageView("loops");
    actions().openOnPage(askId);
    expect(state().pageView).toBe("chat");
  });
});
