// @vitest-environment happy-dom
//
// A turn as the member sees it, drawn from a real event log through the real
// store, with only Rust's seam mocked: what each kind of block shows, and the
// exact frame each control sends — a decision with the edited body and the
// kept rows, a decline with its reason, a question's answer, Cancel on a
// research job, Continue past a limit. Plus the closed renderer: a handle is
// a link only when a tool returned it, and no URL leaves the app.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../lib/org-agent-api", async (actual) => {
  const real = await actual<typeof import("../lib/org-agent-api")>();
  return {
    ...real,
    orgAgent: {
      ...real.orgAgent,
      send: vi.fn(async (frame: Record<string, unknown>) => {
        sent.push(frame);
        return true;
      }),
      rate: vi.fn(async () => null),
    },
  };
});

import { handleIndex, type OrgAgentTarget } from "../lib/org-agent-links";
import { foldAsk, lastOf } from "../lib/org-agent-log";
import type { ApprovalCard, AtlasEvent, Card, EventPayloads } from "../lib/org-agent-types";
import { useOrgAgentStore } from "../stores/org-agent-store";
import { OrgAgentMarkdown } from "./org-agent-markdown";
import { decisionFor, TurnView } from "./org-agent-turn";

let at = 1_000;
function ev<K extends keyof EventPayloads>(
  seq: number,
  kind: K,
  payload: EventPayloads[K],
): AtlasEvent {
  at += 1_000;
  return { t: "event", ask_id: "a1", seq, kind, at, payload } as AtlasEvent;
}
const user = (extra: Partial<EventPayloads["user_message"]> = {}) =>
  ev(1, "user_message", { text: "What shipped?", client_msg_id: "c1", ...extra });

const SESSION: Card = {
  kind: "session",
  workspace_id: "w1",
  session_id: "s1",
  handle: "ses-41",
  title: "Fix session expiry",
  author: "Ada",
  agent: "claude-acp",
  started_at: Date.now() - 60_000,
  live: false,
};

const opened: OrgAgentTarget[] = [];
/** The one occurrence of `text` that is a link (a card also shows the handle). */
const linked = (text: string) =>
  screen.getAllByText(text).find((el) => el.closest("[data-atlas-link]"))!;
const onOpen = (t: OrgAgentTarget) => opened.push(t);

function draw(
  events: AtlasEvent[],
  status: "idle" | "running" | "waiting_approval" | "waiting_answer" = "idle",
) {
  const view = foldAsk(events);
  const turn = view.turns[0]!;
  return render(
    <TurnView
      askId="a1"
      turn={turn}
      status={status}
      live
      last
      handles={handleIndex(view.cards)}
      vote={null}
      onOpen={onOpen}
    />,
  );
}

beforeEach(() => {
  sent.length = 0;
  opened.length = 0;
  useOrgAgentStore.setState({
    connection: "open",
    deciding: [],
    answering: [],
    outbox: [],
    logs: {},
    asks: {},
  });
});
afterEach(cleanup);

describe("an answer", () => {
  it("shows the prompt with its chips, the tool steps with their records, and the answer", () => {
    draw([
      user({
        text: "What did @Ada ship?",
        mentions: [{ kind: "session", id: "s1", label: "Ada", within: ["w1"] }],
        effort: "low",
      }),
      ev(2, "tool_started", {
        call_id: "t1",
        tool: "sessions_find",
        summary: "Searching Sessions by Ada",
      }),
      ev(3, "tool_result", {
        call_id: "t1",
        tool: "sessions_find",
        summary: "Searching Sessions by Ada",
        cards: [SESSION],
      }),
      ev(4, "text_delta", { text: "Ada fixed expiry in ses-41." }),
      ev(5, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] }),
    ]);
    expect(screen.getByText("Low")).toBeTruthy();
    expect(screen.getByText("Searching Sessions by Ada")).toBeTruthy();
    // The record, and opening it lands on the Timeline session.
    fireEvent.click(screen.getByText("Fix session expiry"));
    expect(opened[opened.length - 1]).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
    });
    // The handle in the answer is a link because the tool returned it.
    fireEvent.click(linked("ses-41"));
    expect(opened[opened.length - 1]).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
    });
    // The chip in the prompt opens what it names.
    fireEvent.click(screen.getByText("@Ada"));
    expect(opened[opened.length - 1]).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
    });
    // Ended: the actions, and how long it took.
    expect(screen.getByLabelText("Copy")).toBeTruthy();
    expect(screen.getByLabelText("Good answer")).toBeTruthy();
    expect(screen.getByLabelText("Ask again")).toBeTruthy();
    expect(screen.getByText(/Worked for 4 s/)).toBeTruthy();
  });

  it("rates the answer by its answer_done event", () => {
    draw([
      user(),
      ev(2, "text_delta", { text: "x" }),
      ev(3, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] }),
    ]);
    fireEvent.click(screen.getByLabelText("Bad answer"));
    expect(useOrgAgentStore.getState().votes.a1).toEqual({ 3: "down" });
  });

  it("says what Atlas is doing while it works, and how long is left", () => {
    draw(
      [
        user(),
        {
          ...ev(2, "eta", { seconds_left: 40, phase: "reading", steps_done: 1, steps_planned: 6 }),
          at: Date.now(),
        } as AtlasEvent,
        ev(3, "tool_started", { call_id: "t1", tool: "t", summary: "Reading comments" }),
      ],
      "running",
    );
    expect(screen.getByText("Reading")).toBeTruthy();
    expect(screen.getByText(/left/)).toBeTruthy();
    expect(screen.queryByLabelText("Copy")).toBeNull();
  });

  it("draws the plan, and folds a long list of tool calls", () => {
    draw(
      [
        user(),
        ev(2, "plan", {
          steps: [
            { text: "Find the sessions", status: "done" },
            { text: "Summarise", status: "in_progress" },
          ],
        }),
        ...[3, 4, 5].flatMap((n, i) => [
          ev(n * 2, "tool_started", { call_id: `t${i}`, tool: "t", summary: `Step ${i}` }),
          ev(n * 2 + 1, "tool_result", {
            call_id: `t${i}`,
            tool: "t",
            summary: `Step ${i}`,
            cards: [],
          }),
        ]),
      ].map((e, i) => ({ ...e, seq: i + 1 }) as AtlasEvent),
    );
    expect(screen.getByLabelText("Plan").textContent).toContain("Summarise");
    expect(screen.queryByText("Step 0")).toBeNull();
    fireEvent.click(screen.getByText(/Looked at 3 things/));
    expect(screen.getByText("Step 0")).toBeTruthy();
  });

  it("offers Continue past a limit that allows it, and sends it", async () => {
    useOrgAgentStore.setState({ connection: "open" });
    draw([user(), ev(2, "limit_reached", { which: "tool_calls", can_continue: true })]);
    expect(screen.getByText(/looking at a lot of records/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.find((f) => f.t === "ask.send")).toMatchObject({ ask_id: "a1", text: "Continue" });
  });

  it("does not offer Continue past today's limit", () => {
    draw([user(), ev(2, "limit_reached", { which: "turns_per_day", can_continue: false })]);
    expect(screen.getByText(/as many questions as you can today/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("shows an error, and references it could not check", () => {
    draw([user(), ev(2, "error", { code: "model", message: "The model failed." })]);
    expect(screen.getByRole("alert").textContent).toContain("The model failed.");
    cleanup();
    draw([
      user(),
      ev(2, "text_delta", { text: "x" }),
      ev(3, "answer_done", {
        usage: { input_tokens: 1, output_tokens: 1 },
        uncited: ["ses-9", "cm-3"],
      }),
    ]);
    expect(screen.getByText(/2 references could not be checked/)).toBeTruthy();
  });

  it("draws a Loop run, which nobody typed", () => {
    const view = foldAsk([{ ...ev(1, "text_delta", { text: "Morning digest" }) }]);
    render(
      <TurnView
        askId="a1"
        turn={view.turns[0]!}
        status="idle"
        live
        last
        handles={new Map()}
        vote={null}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("A Loop ran this.")).toBeTruthy();
  });
});

const CARD: ApprovalCard = {
  tool: "send_message",
  title: "Send a message",
  rows: [
    { target: { kind: "conversation", id: "c1", name: "#team" }, selected: true },
    { target: { kind: "person", id: "u2", name: "Bo" }, selected: true },
  ],
  body: "We shipped the expiry fix.",
  notifies: [{ user_id: "u2", name: "Bo", how: "dm" }],
  visible_to: { kind: "mixed", description: "#team and Bo" },
  warnings: [{ kind: "external_content", note: "Part of this came from outside your team." }],
  editable_body: true,
};

describe("an approval", () => {
  const asked = () => [user(), ev(2, "approval_required", { approval_id: "p1", card: CARD })];

  it("shows exactly what will happen: rows, body, who is notified, who can see it, and the warning", () => {
    draw(asked(), "waiting_approval");
    expect(screen.getByText("Send a message")).toBeTruthy();
    expect(screen.getByText("#team")).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "We shipped the expiry fix.",
    );
    expect(screen.getByText(/Notifies Bo \(direct message\)/)).toBeTruthy();
    expect(screen.getByText(/Visible to #team and Bo/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("outside your team");
  });

  it("confirms with the edited body and only the rows kept", async () => {
    draw(asked(), "waiting_approval");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Shipped today." } });
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.find((f) => f.t === "approval.decide")).toEqual({
      t: "approval.decide",
      approval_id: "p1",
      decision: "approve",
      selected: [0],
      edited_body: "Shipped today.",
    });
    expect(useOrgAgentStore.getState().deciding).toEqual(["p1"]);
  });

  it("declines with the reason Atlas will hear", async () => {
    draw(asked(), "waiting_approval");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.change(screen.getByLabelText("Reason for declining"), {
      target: { value: "Not yet" },
    });
    fireEvent.click(lastOf(screen.getAllByRole("button", { name: "Decline" }))!);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.find((f) => f.t === "approval.decide")).toEqual({
      t: "approval.decide",
      approval_id: "p1",
      decision: "decline",
      reason: "Not yet",
    });
  });

  it("will not confirm with every row unticked, or while the socket is down", () => {
    draw(asked(), "waiting_approval");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();
    useOrgAgentStore.setState({ connection: "backoff" });
    draw(asked(), "waiting_approval");
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
  });

  it("names a Loop's schedule, output and audience, and its button", () => {
    draw(
      [
        user(),
        ev(2, "approval_required", {
          approval_id: "p2",
          card: {
            ...CARD,
            tool: "loop_create",
            title: "Create a Loop",
            rows: [{ target: { kind: "loop", id: "new:digest", name: "Digest" }, selected: true }],
            editable_body: false,
            warnings: [],
            loop: {
              trigger: "Every day at 09:00 (Asia/Dhaka)",
              output: "A message to you",
              audience: "Only you read it.",
            },
          },
        }),
      ],
      "waiting_approval",
    );
    expect(screen.getByText("Every day at 09:00 (Asia/Dhaka)")).toBeTruthy();
    expect(screen.getByText("Only you read it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Loop" })).toBeTruthy();
  });

  it("stays as a summary of what came of it, with what it made", () => {
    const message: Card = {
      kind: "message",
      conv_id: "c1",
      message_id: "m1",
      author: "Ada",
      excerpt: "Shipped today.",
      at: Date.now(),
    };
    draw([
      ...asked(),
      ev(3, "approval_resolved", {
        approval_id: "p1",
        decision: "approve",
        executed: { ok: true, cards: [message] },
      }),
      ev(4, "answer_done", { usage: { input_tokens: 1, output_tokens: 1 }, uncited: [] }),
    ]);
    expect(screen.getByText("Done")).toBeTruthy();
    fireEvent.click(screen.getByText("Shipped today."));
    expect(opened[opened.length - 1]).toEqual({
      kind: "conversation",
      convId: "c1",
      messageId: "m1",
    });
  });

  it("says when it was declined, withdrawn, failed or could not be confirmed", () => {
    const outcome = (resolved: EventPayloads["approval_resolved"]) => {
      cleanup();
      draw([...asked(), ev(3, "approval_resolved", resolved)]);
    };
    outcome({ approval_id: "p1", decision: "decline" });
    expect(screen.getByText("Declined")).toBeTruthy();
    outcome({ approval_id: "p1", decision: "decline", withdrawn: true });
    expect(screen.getByText("Withdrawn")).toBeTruthy();
    outcome({ approval_id: "p1", decision: "approve", executed: { ok: false, cards: [] } });
    expect(screen.getByText("Failed")).toBeTruthy();
    outcome({ approval_id: "p1", decision: "approve", outcome_unknown: true });
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
  });

  it("builds the decision frame the web builds", () => {
    expect(
      decisionFor(
        "p",
        { ...CARD, rows: [CARD.rows[0]!] },
        "approve",
        [true],
        "We shipped the expiry fix.",
      ),
    ).toEqual({
      approval_id: "p",
      decision: "approve",
    });
    expect(decisionFor("p", CARD, "decline", [true, true], null, "   ")).toEqual({
      approval_id: "p",
      decision: "decline",
    });
  });
});

describe("a question", () => {
  it("answers with a choice or in words", async () => {
    draw(
      [
        user(),
        ev(2, "question", {
          question_id: "q1",
          text: "Which project?",
          options: [{ id: "a", label: "Atlas" }],
          allow_text: true,
        }),
      ],
      "waiting_answer",
    );
    fireEvent.click(screen.getByRole("button", { name: "Atlas" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.find((f) => f.t === "question.answer")).toEqual({
      t: "question.answer",
      question_id: "q1",
      choice: "a",
    });
    expect(screen.getByText("Sending your answer")).toBeTruthy();
  });

  it("shows an answered question as answered", () => {
    draw([
      user(),
      ev(2, "question", { question_id: "q1", text: "Which?", options: [], allow_text: true }),
      ev(3, "text_delta", { text: "OK" }),
    ]);
    expect(screen.getByText("Answered.")).toBeTruthy();
  });
});

describe("Deep research", () => {
  const research = (
    seq: number,
    status: EventPayloads["research"]["status"],
    extra: Partial<EventPayloads["research"]> = {},
  ) =>
    ev(seq, "research", {
      job_id: "j1",
      status,
      question: "Payments this month",
      steps: [
        { id: "s1", question: "Who worked on payments?", status: "done", tool_calls: 3 },
        { id: "s2", question: "Which changes landed?", status: "running", tool_calls: 1 },
        { id: "s3", question: "Why?", status: "pending" },
      ],
      eta: { seconds_left: 240, phase: status, steps_done: 1, steps_planned: 3 },
      started_at: 1,
      ...extra,
    });

  it("shows the phase, the steps and the time left, and cancels the job", async () => {
    draw([user({ mode: "deep_research" }), research(2, "researching")], "running");
    expect(screen.getByText("Researching")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("Which changes landed?")).toBeTruthy();
    expect(screen.getByText(/You can close this/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.find((f) => f.t === "research.cancel")).toEqual({
      t: "research.cancel",
      ask_id: "a1",
      job_id: "j1",
    });
  });

  it("says why a job failed", () => {
    draw([
      user({ mode: "deep_research" }),
      research(2, "failed", { note: "You have used today's Deep research." }),
    ]);
    expect(screen.getByText("Could not finish")).toBeTruthy();
    expect(screen.getByText("You have used today's Deep research.")).toBeTruthy();
  });

  it("draws the report with its citations linked and a Partial badge", () => {
    draw([
      user({ mode: "deep_research" }),
      research(2, "writing"),
      ev(3, "report", {
        job_id: "j1",
        title: "Payments this month",
        text: "## Work\nMostly the expiry fix in ses-41.",
        cards: [SESSION],
        steps: [{ id: "s1", question: "Who?", status: "done" }],
        partial: true,
        usage: { input_tokens: 1, output_tokens: 1 },
        uncited: [],
        duration_ms: 512_000,
      }),
      research(4, "done"),
    ]);
    expect(screen.getByRole("heading", { name: "Payments this month" })).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByText(/1 of 1 questions answered · 9 min · 1 sources/)).toBeTruthy();
    fireEvent.click(linked("ses-41"));
    expect(opened[opened.length - 1]).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
    });
  });
});

describe("the closed renderer", () => {
  const md = (source: string, cards: Card[] = []) =>
    render(<OrgAgentMarkdown source={source} handles={handleIndex(cards)} onOpen={onOpen} />);

  it("links a handle only when a tool returned it", () => {
    md("See ses-41 and ses-99.", [SESSION]);
    expect(screen.getByText("ses-41").closest("[data-atlas-link]")).toBeTruthy();
    expect(screen.getByText("ses-99").closest("[data-atlas-link]")).toBeNull();
  });

  it("never links off the app, and opens Atlas routes in place", () => {
    md("[click](https://evil.example/?d=secret) and [chat](/chat?c=c1)");
    expect(screen.getByText("click").closest("a, [data-atlas-link]")).toBeNull();
    expect(screen.getByText("(https://evil.example/?d=secret)")).toBeTruthy();
    fireEvent.click(screen.getByText("chat"));
    expect(opened[opened.length - 1]).toEqual({ kind: "conversation", convId: "c1" });
  });

  it("draws no image and no raw HTML", () => {
    const { container } = md(
      '![leak](https://evil.example/x.png) <img src="https://evil.example/y.png"> <b>bold</b>',
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("[image: leak]")).toBeTruthy();
  });

  it("marks erased text and suggestions", () => {
    const { container } = md("He said [erased] there.\n\nSuggestion: ask Bo.");
    expect(container.querySelector("[data-erased]")?.textContent).toBe("erased");
    expect(container.querySelector("[data-suggestion]")).toBeTruthy();
  });
});
