// The Organisation agent's wire, as the desktop reads it. A mirror of the
// server's zod schemas (`packages/contracts/src/atlas.ts` in the server repo;
// the prose is `docs/api/atlas-agent-api.md` and
// `atlas-agent-effort-desktop.md`), cut to what this client draws. Every
// field the contract marks optional is optional here, and an event kind this
// build does not know is ignored (`org-agent-log.ts`), as the contract asks.

export type AtlasEffort = "low" | "medium" | "high" | "max";
export const ATLAS_EFFORTS: readonly AtlasEffort[] = ["low", "medium", "high", "max"];

/** The contract's bounds this client enforces before sending. */
export const ATLAS_LIMITS = {
  messageChars: 8_000,
  mentions: 20,
  mentionLabelChars: 120,
  eventsPage: 500,
} as const;

export type AskStatus = "idle" | "running" | "waiting_approval" | "waiting_answer";

export interface AskSummary {
  id: string;
  title: string;
  kind: "ask" | "loop_run";
  loop_id?: string | null;
  created_at: number;
  updated_at: number;
  status: AskStatus;
}

export type MentionKind =
  | "person"
  | "conversation"
  | "project"
  | "session"
  | "message"
  | "comment"
  | "ask"
  | "rc_room"
  | "thread"
  | "file"
  | "draft"
  | "loop"
  | "fact"
  | "space_page";

/** Something the member picked in the composer, written into the text as
 *  `@label` and sent beside it. A mention grants nothing: Atlas opens what
 *  it names through the doors, as the member. */
export interface Mention {
  kind: MentionKind;
  id: string;
  label: string;
  /** `ses-N`, `wp-N`, `cm-N`, `fact-N`. */
  handle?: string;
  /** The ids it sits inside, outermost first: a session's Workspace; a
   *  comment's Workspace and session; a message's conversation. */
  within?: string[];
}

export interface AskContext {
  route: string;
  entity?: string;
  tz?: string;
}

export type Card =
  | {
      kind: "person";
      user_id: string;
      name: string;
      role?: string;
      online?: boolean;
      page?: string;
    }
  | { kind: "project"; workspace_id: string; handle: string; name: string; restricted: boolean }
  | {
      kind: "session";
      workspace_id: string;
      session_id: string;
      handle: string;
      title: string;
      author: string;
      agent: string;
      started_at: number;
      live: boolean;
    }
  | {
      kind: "checkpoint";
      workspace_id: string;
      session_id: string;
      commit_sha: string;
      branch: string;
      files: number;
      plus: number;
      minus: number;
    }
  | {
      kind: "conversation";
      conv_id: string;
      conv_kind: "channel" | "dm" | "group_dm";
      name: string;
    }
  | {
      kind: "message";
      conv_id: string;
      message_id: string;
      author: string;
      excerpt: string;
      at: number;
    }
  | {
      kind: "comment";
      workspace_id: string;
      session_id: string;
      comment_id: string;
      handle: string;
      author: string;
      excerpt: string;
    }
  | { kind: "space_page"; conv_id: string; page_id: string; name: string }
  | { kind: "fact"; fact_id: string; handle: string; text: string }
  | { kind: "loop"; loop_id: string; name: string }
  | { kind: "link"; route: string; label: string };

export interface SourceRef {
  kind: string;
  ref: string;
  readers?: unknown;
  label?: string;
}

export type ApprovalTool =
  | "send_message"
  | "create_channel"
  | "comment_reply"
  | "comment_resolve"
  | "space_draw"
  | "propose_fact"
  | "loop_create";

export interface ApprovalCard {
  tool: ApprovalTool | string;
  title: string;
  rows: { target: { kind: string; id: string; name: string }; body?: string; selected: boolean }[];
  body?: string;
  notifies: { user_id: string; name: string; how: "dm" | "mention" | "digest" }[];
  visible_to: { kind: string; count?: number; description: string };
  warnings: {
    kind: "restricted_sources" | "external_content";
    sources?: SourceRef[];
    note: string;
  }[];
  editable_body: boolean;
  sources?: SourceRef[];
  loop?: { trigger: string; output: string; audience: string };
}

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done" | "canceled";
}

export type LimitWhich =
  | "rounds"
  | "tool_calls"
  | "wall_time"
  | "budget"
  | "rate"
  | "model_off"
  | "turns_per_day"
  | "deep_research_per_day";

export type ResearchStatus =
  | "queued"
  | "planning"
  | "researching"
  | "writing"
  | "done"
  | "canceled"
  | "failed";

export interface ResearchStep {
  id: string;
  question: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  tool_calls?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

/** Every event kind's payload, by kind. */
export interface EventPayloads {
  user_message: {
    text: string;
    client_msg_id: string;
    context?: AskContext;
    mentions?: Mention[];
    effort?: AtlasEffort;
    mode?: "deep_research";
  };
  text_delta: { text: string };
  tool_started: { call_id: string; tool: string; summary: string };
  tool_result: {
    call_id: string;
    tool: string;
    summary: string;
    cards: Card[];
    truncated?: boolean;
  };
  approval_required: { approval_id: string; card: ApprovalCard };
  approval_resolved: {
    approval_id: string;
    decision: "approve" | "decline";
    executed?: { ok: boolean; cards: Card[] };
    outcome_unknown?: boolean;
    withdrawn?: boolean;
  };
  question: {
    question_id: string;
    text: string;
    options: { id: string; label: string }[];
    allow_text: boolean;
  };
  plan: { steps: PlanStep[] };
  answer_done: { usage: Usage; uncited: string[] };
  limit_reached: { which: LimitWhich; can_continue: boolean };
  memory_updated: { item_id: string; text: string; forgotten?: boolean };
  compacted: { through_seq: number };
  error: { code: string; message: string };
  eta: {
    seconds_left: number;
    phase: "thinking" | "reading" | "answering";
    steps_done: number;
    steps_planned: number;
    effort?: AtlasEffort;
    rounds?: number;
    rounds_max?: number;
  };
  research: {
    job_id: string;
    status: ResearchStatus;
    question: string;
    steps: ResearchStep[];
    eta: { seconds_left: number; phase: string; steps_done: number; steps_planned: number };
    started_at: number;
    finished_at?: number;
    note?: string;
  };
  report: {
    job_id: string;
    title: string;
    text: string;
    cards: Card[];
    steps: ResearchStep[];
    partial: boolean;
    usage: Usage;
    uncited: string[];
    duration_ms: number;
  };
}

export type AtlasEventKind = keyof EventPayloads;

export type AtlasEvent = {
  [K in AtlasEventKind]: {
    t?: "event";
    ask_id: string;
    seq: number;
    kind: K;
    at: number;
    payload: EventPayloads[K];
  };
}[AtlasEventKind];

export type Payload<K extends AtlasEventKind> = EventPayloads[K];

export interface AskDetail {
  ask: AskSummary;
  events: AtlasEvent[];
  feedback?: { event_seq: number; rating: "up" | "down" }[];
}

/** What the client sends on the socket. */
export type ClientFrame =
  | {
      t: "ask.send";
      ask_id?: string;
      client_msg_id: string;
      text: string;
      context?: AskContext;
      mentions?: Mention[];
      effort?: AtlasEffort;
      mode?: "deep_research";
    }
  | { t: "ask.stop"; ask_id: string }
  | { t: "research.cancel"; ask_id: string; job_id: string }
  | {
      t: "approval.decide";
      approval_id: string;
      decision: "approve" | "decline";
      selected?: number[];
      edited_body?: string;
      reason?: string;
    }
  | { t: "question.answer"; question_id: string; choice?: string; text?: string }
  | { t: "resume"; ask_id: string; after_seq: number }
  | { t: "ping" };

export interface AtlasStatus {
  enabled: boolean;
  loops_enabled: boolean;
  model: string;
  limits: {
    turns_per_day: number;
    turns_today: number;
    actions_per_day: number;
    actions_today: number;
  };
  admin: boolean;
}

export interface EffortLevel {
  effort: AtlasEffort;
  label: string;
  blurb: string;
  eta_seconds: number;
  measured: boolean;
  model: string;
}

export interface EffortResponse {
  default: AtlasEffort;
  levels: EffortLevel[];
  deep_research: {
    allowed: boolean;
    per_day: number;
    used_today: number;
    remaining: number;
    eta_seconds: number;
    measured: boolean;
    model: string;
    running: { ask_id: string; job_id: string; status: ResearchStatus; started_at: number }[];
  };
}

export interface AtlasNotification {
  id: string;
  kind: "deep_research_done" | string;
  ask_id: string;
  job_id: string;
  title: string;
  excerpt: string;
  partial: boolean;
  at: number;
  read: boolean;
}

export type LoopEventKind =
  | "session.ended"
  | "checkpoint.created"
  | "comment.created"
  | "message.posted";
export const LOOP_EVENT_KINDS: readonly LoopEventKind[] = [
  "session.ended",
  "checkpoint.created",
  "comment.created",
  "message.posted",
];
export const LOOP_EVENT_WORDS: Record<LoopEventKind, string> = {
  "session.ended": "a Session ends",
  "checkpoint.created": "a Checkpoint lands",
  "comment.created": "someone comments on a Session",
  "message.posted": "someone posts in a channel",
};
export const LOOP_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type LoopTrigger =
  | { schedule: { every: "hourly" | "daily" | "weekly"; at: string; tz: string; weekday?: number } }
  | { events: LoopEventKind[]; filters?: { workspace?: string; conv?: string } };

export type LoopOutput =
  | { kind: "dm_self" }
  | { kind: "dm"; user_id: string }
  | { kind: "channel"; conv_id: string };

export interface Loop {
  id: string;
  creator: string;
  name: string;
  instruction: string;
  trigger: LoopTrigger;
  output: LoopOutput;
  status: "active" | "paused" | "paused_cap" | "deleted";
  runs_today: number;
  last_run_at: number | null;
  next_run_at: number | null;
  note: string | null;
  created_at: number;
}

export interface CreateLoopRequest {
  name: string;
  instruction: string;
  trigger: LoopTrigger;
  output: LoopOutput;
}

/** A trigger in plain words: "Every Monday at 09:00 (Asia/Dhaka)". The
 *  contract's `loopTriggerWords`, word for word. */
export function loopTriggerWords(
  trigger: LoopTrigger,
  names: { workspace?: string; conv?: string } = {},
): string {
  if ("schedule" in trigger) {
    const s = trigger.schedule;
    if (s.every === "hourly") return `Every hour at ${s.at.slice(3)} minutes past (${s.tz})`;
    if (s.every === "weekly") return `Every ${LOOP_DAY_NAMES[s.weekday ?? 1]} at ${s.at} (${s.tz})`;
    return `Every day at ${s.at} (${s.tz})`;
  }
  const what = trigger.events.map((e) => LOOP_EVENT_WORDS[e] ?? e).join(", or ");
  const where = [
    trigger.filters?.workspace ? `in ${names.workspace ?? "one project"}` : null,
    trigger.filters?.conv ? `in ${names.conv ?? "one conversation"}` : null,
  ].filter(Boolean);
  return `When ${what}${where.length ? ` ${where.join(" ")}` : ""} (batched over 5 minutes)`;
}

export interface MemoryItem {
  id: string;
  kind: "preference" | "open_thread" | "note";
  text: string;
  created_at: number;
  updated_at: number;
}
