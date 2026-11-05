// The Organisation agent, faked: its REST doors and its socket, so the agent's
// panel, page and messenger have something true-shaped to draw in `bun run
// dev`. Two earlier conversations; a new message is answered the way the
// server answers — echo, an estimate, tool calls with the records they found,
// the answer streamed with a handle in it, then `answer_done`. Ask it to send
// or post something and it asks for approval first; ask it which project and
// it asks you back; turn on Deep research and it runs a short job and writes
// a report. `resume` replays from the log, as the server's does.
//
// The sessions and Workspace are the synced app Project's (`artifacts.ts`), so
// opening a card lands on the Timeline.

import { emit } from "@tauri-apps/api/event";

import type { AgentConnection, AgentEnvelope } from "@/features/org-agent/lib/org-agent-api";
import type {
  AskSummary,
  AtlasEvent,
  Card,
  ClientFrame,
  EffortResponse,
  EventPayloads,
  Loop,
} from "@/features/org-agent/lib/org-agent-types";
import { MOCK_ORG_ID } from "../project";
import type { TypedHandlers, Unit } from "../types";

export interface OrgAgentResponses {
  org_agent_status: AgentConnection;
  org_agent_send: boolean;
  org_agent_reconnect: Unit;
  org_agent_rest: unknown;
}

const ORG = MOCK_ORG_ID;
const WS = "rw_1d55e903";
const HOUR = 3_600_000;

const SESSION: Card = {
  kind: "session",
  workspace_id: WS,
  session_id: "sess-a19c40",
  handle: "ses-1112",
  title: "Regenerate the dark-mode ramp from the shadcn base tokens",
  author: "Priya Raman",
  agent: "claude-acp",
  started_at: Date.now() - 20 * HOUR,
  live: false,
};
const PERSON: Card = {
  kind: "person",
  user_id: "usr_priya",
  name: "Priya Raman",
  role: "developer",
  online: true,
};

interface FakeAsk {
  summary: AskSummary;
  events: AtlasEvent[];
}

const asks = new Map<string, FakeAsk>();
const loops: Loop[] = [];
let askSeq = 0;
let effortDefault: EffortResponse["default"] = "medium";
let deepUsed = 0;

function newAsk(title: string, at: number): FakeAsk {
  askSeq += 1;
  const ask: FakeAsk = {
    summary: {
      id: `ask-${askSeq}`,
      title,
      kind: "ask",
      created_at: at,
      updated_at: at,
      status: "idle",
    },
    events: [],
  };
  asks.set(ask.summary.id, ask);
  return ask;
}

function push<K extends keyof EventPayloads>(
  ask: FakeAsk,
  kind: K,
  payload: EventPayloads[K],
  at = Date.now(),
): AtlasEvent {
  const event = {
    t: "event",
    ask_id: ask.summary.id,
    seq: ask.events.length + 1,
    kind,
    at,
    payload,
  } as AtlasEvent;
  ask.events.push(event);
  ask.summary.updated_at = at;
  return event;
}

function seed() {
  if (asks.size > 0) return;
  const t0 = Date.now() - 26 * HOUR;
  const a = newAsk("What did I work on this week?", t0);
  push(
    a,
    "user_message",
    { text: "What did I work on this week?", client_msg_id: "seed-1", effort: "medium" },
    t0,
  );
  push(
    a,
    "tool_started",
    { call_id: "s1", tool: "sessions_find", summary: "Searching Sessions by me" },
    t0 + 2_000,
  );
  push(
    a,
    "tool_result",
    { call_id: "s1", tool: "sessions_find", summary: "Searching Sessions by me", cards: [SESSION] },
    t0 + 4_000,
  );
  push(
    a,
    "text_delta",
    { text: "Mostly the dark-mode ramp: ses-1112 regenerated it from the shadcn base tokens." },
    t0 + 6_000,
  );
  push(
    a,
    "answer_done",
    { usage: { input_tokens: 1200, output_tokens: 90 }, uncited: [] },
    t0 + 7_000,
  );

  const t1 = Date.now() - 3 * HOUR;
  const b = newAsk("Who is working on the Timeline?", t1);
  push(
    b,
    "user_message",
    { text: "Who is working on the Timeline?", client_msg_id: "seed-2", effort: "low" },
    t1,
  );
  push(
    b,
    "tool_started",
    { call_id: "p1", tool: "people_find", summary: "Finding who touched the Timeline" },
    t1 + 1_000,
  );
  push(
    b,
    "tool_result",
    {
      call_id: "p1",
      tool: "people_find",
      summary: "Finding who touched the Timeline",
      cards: [PERSON],
    },
    t1 + 2_000,
  );
  push(b, "text_delta", { text: "Priya Raman, in ses-1112." }, t1 + 3_000);
  push(
    b,
    "answer_done",
    { usage: { input_tokens: 800, output_tokens: 20 }, uncited: [] },
    t1 + 4_000,
  );
}

function announce(event: AtlasEvent) {
  const envelope: AgentEnvelope = {
    org: ORG,
    epoch: 1,
    ev: { kind: "frame", frame: JSON.stringify(event) },
  };
  void emit("atlas:org-agent", envelope);
}
function refuse(code: string, message: string) {
  const envelope: AgentEnvelope = {
    org: ORG,
    epoch: 1,
    ev: { kind: "frame", frame: JSON.stringify({ t: "error", code, message }) },
  };
  void emit("atlas:org-agent", envelope);
}

/** Events land a beat apart, the way a turn streams. */
function script(ask: FakeAsk, steps: Array<() => void>, gap = 450) {
  steps.forEach((step, i) => setTimeout(step, gap * (i + 1)));
  void ask;
}

function emitPush<K extends keyof EventPayloads>(ask: FakeAsk, kind: K, payload: EventPayloads[K]) {
  ask.summary.status =
    kind === "answer_done" || kind === "report" || kind === "error"
      ? "idle"
      : kind === "approval_required"
        ? "waiting_approval"
        : kind === "question"
          ? "waiting_answer"
          : "running";
  announce(push(ask, kind, payload));
}

function answer(ask: FakeAsk, text: string) {
  const streamed = text.match(/.{1,24}(\s|$)/g) ?? [text];
  script(ask, [
    () =>
      emitPush(ask, "eta", {
        seconds_left: 6,
        phase: "reading",
        steps_done: 0,
        steps_planned: 2,
        effort: effortDefault,
      }),
    () =>
      emitPush(ask, "tool_started", {
        call_id: `c${ask.events.length}`,
        tool: "sessions_find",
        summary: "Searching Sessions",
      }),
    () => {
      const started = [...ask.events].reverse().find((e) => e.kind === "tool_started");
      const call = started?.kind === "tool_started" ? started.payload.call_id : "c";
      emitPush(ask, "tool_result", {
        call_id: call,
        tool: "sessions_find",
        summary: "Searching Sessions",
        cards: [SESSION],
      });
    },
    ...streamed.map((chunk) => () => emitPush(ask, "text_delta", { text: chunk })),
    () =>
      emitPush(ask, "answer_done", {
        usage: { input_tokens: 900, output_tokens: 60 },
        uncited: [],
      }),
  ]);
}

function research(ask: FakeAsk, question: string) {
  deepUsed += 1;
  const job = `job-${ask.events.length}`;
  const steps = (status: "pending" | "running" | "done", n: number) =>
    ["Who worked on it?", "What shipped?", "What is still open?"].map((q, i) => ({
      id: `st${i}`,
      question: q,
      status: i < n ? ("done" as const) : i === n ? status : ("pending" as const),
      tool_calls: i <= n ? 2 : undefined,
    }));
  const state = (status: EventPayloads["research"]["status"], n: number, left: number) =>
    emitPush(ask, "research", {
      job_id: job,
      status,
      question,
      steps: status === "queued" || status === "planning" ? [] : steps("running", n),
      eta: { seconds_left: left, phase: status, steps_done: n, steps_planned: 3 },
      started_at: Date.now(),
    });
  script(
    ask,
    [
      () => state("queued", 0, 20),
      () => state("planning", 0, 18),
      () => state("researching", 0, 14),
      () => state("researching", 1, 10),
      () => state("researching", 2, 6),
      () => state("writing", 3, 3),
      () =>
        emitPush(ask, "report", {
          job_id: job,
          title: question.slice(0, 60),
          text: "## What happened\nThe dark-mode ramp was regenerated in ses-1112.\n\n## Open questions\n- Whether the light theme follows.",
          cards: [SESSION],
          steps: steps("done", 3).map((s) => ({ ...s, status: "done" as const })),
          partial: false,
          usage: { input_tokens: 20_000, output_tokens: 1_200 },
          uncited: [],
          duration_ms: 9_000,
        }),
      () => {
        announce(
          push(ask, "research", {
            job_id: job,
            status: "done",
            question,
            steps: steps("done", 3),
            eta: { seconds_left: 0, phase: "done", steps_done: 3, steps_planned: 3 },
            started_at: Date.now(),
            finished_at: Date.now(),
          }),
        );
      },
    ],
    900,
  );
}

function onSend(frame: Extract<ClientFrame, { t: "ask.send" }>) {
  seed();
  const existing = frame.ask_id ? asks.get(frame.ask_id) : undefined;
  if (frame.ask_id && !existing) return refuse("not_found", "That conversation does not exist.");
  const ask = existing ?? newAsk(frame.text.split("\n")[0]!.slice(0, 80), Date.now());
  const dup = ask.events.find(
    (e) => e.kind === "user_message" && e.payload.client_msg_id === frame.client_msg_id,
  );
  if (dup) return announce(dup);
  if (frame.mode === "deep_research" && deepUsed >= 5) {
    return refuse(
      "deep_research_per_day",
      "You have used today's Deep research. It resets at midnight UTC.",
    );
  }
  emitPush(ask, "user_message", {
    text: frame.text,
    client_msg_id: frame.client_msg_id,
    ...(frame.mentions ? { mentions: frame.mentions } : {}),
    ...(frame.mode ? { mode: frame.mode } : { effort: frame.effort ?? effortDefault }),
  });
  const text = frame.text.toLowerCase();
  if (frame.mode === "deep_research") return research(ask, frame.text);
  if (/\b(send|post|tell|message)\b/.test(text)) {
    return script(ask, [
      () =>
        emitPush(ask, "approval_required", {
          approval_id: `ap-${ask.events.length}`,
          card: {
            tool: "send_message",
            title: "Send a message",
            rows: [
              {
                target: { kind: "conversation", id: "conv-general", name: "#general" },
                selected: true,
              },
            ],
            body: "Heads up: the dark-mode ramp landed in ses-1112.",
            notifies: [],
            visible_to: { kind: "org", description: "everyone in the organisation" },
            warnings: [],
            editable_body: true,
          },
        }),
    ]);
  }
  if (/\bwhich project\b/.test(text)) {
    return script(ask, [
      () =>
        emitPush(ask, "question", {
          question_id: `q-${ask.events.length}`,
          text: "Which project do you mean?",
          options: [
            { id: "atlas", label: "atlas" },
            { id: "atlas-docs", label: "atlas-docs" },
          ],
          allow_text: true,
        }),
    ]);
  }
  answer(
    ask,
    `Here is what I found: ses-1112 regenerated the dark-mode ramp. Ask me anything else about the team's work.`,
  );
}

function findApproval(id: string): FakeAsk | undefined {
  return [...asks.values()].find((a) =>
    a.events.some((e) => e.kind === "approval_required" && e.payload.approval_id === id),
  );
}

export const orgAgentHandlers: TypedHandlers<OrgAgentResponses> = {
  org_agent_status: () => ({ orgId: ORG, epoch: 1, state: "open" }),
  org_agent_reconnect: () => null,
  org_agent_send: ({ frame }) => {
    const f = frame as ClientFrame;
    switch (f.t) {
      case "ping":
        void emit("atlas:org-agent", {
          org: ORG,
          epoch: 1,
          ev: { kind: "frame", frame: '{"t":"pong"}' },
        });
        break;
      case "ask.send":
        onSend(f);
        break;
      case "resume": {
        const ask = asks.get(f.ask_id);
        for (const e of ask?.events ?? []) if (e.seq > f.after_seq) announce(e);
        break;
      }
      case "ask.stop": {
        const ask = asks.get(f.ask_id);
        if (ask) ask.summary.status = "idle";
        break;
      }
      case "approval.decide": {
        const ask = findApproval(f.approval_id);
        if (!ask) return (refuse("not_found", "That card is no longer waiting."), true);
        script(ask, [
          () =>
            emitPush(ask, "approval_resolved", {
              approval_id: f.approval_id,
              decision: f.decision,
              ...(f.decision === "approve"
                ? {
                    executed: {
                      ok: true,
                      cards: [
                        {
                          kind: "message",
                          conv_id: "conv-general",
                          message_id: "msg-fake",
                          author: "You",
                          excerpt:
                            f.edited_body ?? "Heads up: the dark-mode ramp landed in ses-1112.",
                          at: Date.now(),
                        },
                      ],
                    },
                  }
                : {}),
            }),
          () =>
            emitPush(ask, "text_delta", {
              text:
                f.decision === "approve" ? "Sent." : `Not sent${f.reason ? `: ${f.reason}` : ""}.`,
            }),
          () =>
            emitPush(ask, "answer_done", {
              usage: { input_tokens: 100, output_tokens: 5 },
              uncited: [],
            }),
        ]);
        break;
      }
      case "question.answer": {
        const ask = [...asks.values()].find((a) =>
          a.events.some((e) => e.kind === "question" && e.payload.question_id === f.question_id),
        );
        if (ask) answer(ask, `In ${f.choice ?? f.text}, ses-1112 is the latest work.`);
        break;
      }
      case "research.cancel":
        break;
    }
    return true;
  },
  org_agent_rest: ({ method, path, body }) => {
    seed();
    const [route, query = ""] = (path as string).split("?");
    const parts = route!.split("/").filter(Boolean);
    const m = method as string;
    switch (parts[0]) {
      case "status":
        return {
          enabled: true,
          loops_enabled: true,
          model: "glm-5.3",
          limits: {
            turns_per_day: 200,
            turns_today: [...asks.values()].reduce(
              (n, a) => n + a.events.filter((e) => e.kind === "user_message").length,
              0,
            ),
            actions_per_day: 50,
            actions_today: 0,
          },
          admin: false,
        };
      case "effort":
        return {
          default: effortDefault,
          levels: (["low", "medium", "high", "max"] as const).map((effort, i) => ({
            effort,
            label: effort[0]!.toUpperCase() + effort.slice(1),
            blurb: [
              "Quick answer from a few lookups.",
              "Balanced. Checks the main sources.",
              "Thorough. Follows more leads.",
              "Slowest. Thinks hardest and reads widest.",
            ][i]!,
            eta_seconds: [7, 12, 90, 180][i]!,
            measured: false,
            model: "glm-5.3",
          })),
          deep_research: {
            allowed: true,
            per_day: 5,
            used_today: deepUsed,
            remaining: Math.max(0, 5 - deepUsed),
            eta_seconds: 600,
            measured: false,
            model: "glm-5.3",
            running: [],
          },
        } satisfies EffortResponse;
      case "settings":
        if (m === "PUT")
          effortDefault = (body as { default_effort: EffortResponse["default"] }).default_effort;
        return { default_effort: effortDefault };
      case "notifications":
        return parts[1] === "read" ? { ok: true } : { items: [], unread: 0 };
      case "asks": {
        if (!parts[1]) {
          return {
            asks: [...asks.values()]
              .map((a) => a.summary)
              .sort((x, y) => y.updated_at - x.updated_at),
            next_cursor: null,
          };
        }
        const ask = asks.get(parts[1]);
        if (!ask) throw JSON.stringify({ code: "not_found", message: "Not found." });
        if (m === "DELETE") {
          asks.delete(parts[1]);
          return null;
        }
        if (parts[2] === "feedback") return null;
        const after = Number(new URLSearchParams(query).get("after_seq") ?? 0);
        return { ask: ask.summary, events: ask.events.filter((e) => e.seq > after), feedback: [] };
      }
      case "loops": {
        if (m === "GET") return { loops };
        if (m === "POST") {
          const req = body as Pick<Loop, "name" | "instruction" | "trigger" | "output">;
          const loop: Loop = {
            ...req,
            id: `loop-${loops.length + 1}`,
            creator: "usr_dev",
            status: "active",
            runs_today: 0,
            last_run_at: null,
            next_run_at: "schedule" in req.trigger ? Date.now() + 12 * HOUR : null,
            note: null,
            created_at: Date.now(),
          };
          loops.unshift(loop);
          return loop;
        }
        const i = loops.findIndex((l) => l.id === parts[1]);
        if (i < 0) throw JSON.stringify({ code: "not_found", message: "Not found." });
        if (m === "DELETE") {
          loops.splice(i, 1);
          return null;
        }
        loops[i] = { ...loops[i]!, ...(body as Partial<Loop>) };
        return loops[i];
      }
      case "memory":
        return { items: [] };
      default:
        throw JSON.stringify({ code: "not_found", message: "Not found." });
    }
  },
};
