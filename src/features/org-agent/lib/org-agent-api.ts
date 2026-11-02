// The Organisation agent — Atlas's conversational agent over the
// Organisation's data (sessions, projects, comments, chats, schedules). It
// runs on the server; the desktop, the web (app.tryatlas.cc/agent) and mobile
// are its consumers, and they share one history. Not the coding agent: that
// one edits code, and is the wrong tool for conversation over team data.
//
// The one seam the UI talks through. Rust holds the token and the socket
// (`src-tauri/src/commands/org_agent.rs`, `atlas_comms::org_agent`); this
// module is typed wrappers over its four commands and its one event channel.
// The protocol's rules are `org-agent-log.ts`; the state is the store.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AskDetail,
  AskSummary,
  AtlasEffort,
  AtlasEvent,
  AtlasNotification,
  AtlasStatus,
  ClientFrame,
  CreateLoopRequest,
  EffortResponse,
  Loop,
  MemoryItem,
} from "./org-agent-types";
import { ATLAS_LIMITS } from "./org-agent-types";
import { lastOf } from "./org-agent-log";

/** The window channel Rust emits on (`ORG_AGENT_EVENT`). */
export const ORG_AGENT_EVENT = "atlas:org-agent";

export type AgentConnState = "disconnected" | "connecting" | "open" | "backoff" | "unavailable";

export type AgentEnvelope =
  | { org: string; epoch: number; ev: { kind: "connection"; state: AgentConnState } }
  | { org: string; epoch: number; ev: { kind: "frame"; frame: string } };

export interface AgentConnection {
  orgId: string | null;
  epoch: number;
  state: AgentConnState;
}

/** A refusal, in the server's own words: `atlas_off`, `loops_max`,
 *  `not_a_poster`, `not_found` … plus the client's `network`, `signed_out`. */
export class OrgAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrgAgentError";
  }
}

function toError(e: unknown): OrgAgentError {
  if (e instanceof OrgAgentError) return e;
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") {
      const message =
        parsed.code === "atlas_off"
          ? "Atlas is turned off for this organisation."
          : typeof parsed.message === "string" && parsed.message
            ? parsed.message
            : "Atlas could not do that.";
      return new OrgAgentError(parsed.code, message);
    }
  } catch {
    // Not the envelope: a plain message.
  }
  return new OrgAgentError("unknown", raw || "Atlas could not do that.");
}

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await invoke<T>("org_agent_rest", { method, path, body: body ?? null });
  } catch (e) {
    throw toError(e);
  }
}

function q(params: Record<string, string | number | null | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}

export const orgAgent = {
  status: (): Promise<AgentConnection> => invoke<AgentConnection>("org_agent_status"),
  /** One client frame; `false` when the socket is not open. */
  send: async (frame: ClientFrame): Promise<boolean> => {
    try {
      return await invoke<boolean>("org_agent_send", { frame });
    } catch {
      return false;
    }
  },
  reconnect: (): Promise<void> => invoke<void>("org_agent_reconnect"),
  listen: (handler: (envelope: AgentEnvelope) => void): Promise<UnlistenFn> =>
    listen<AgentEnvelope>(ORG_AGENT_EVENT, (e) => handler(e.payload)),

  /** Whether Atlas is on for this member, the model, and today's limits. */
  atlasStatus: () => rest<AtlasStatus>("GET", "/status"),
  effort: () => rest<EffortResponse>("GET", "/effort"),
  saveDefaultEffort: (effort: AtlasEffort) =>
    rest<{ default_effort: AtlasEffort }>("PUT", "/settings", { default_effort: effort }),
  notifications: () =>
    rest<{ items: AtlasNotification[]; unread: number }>("GET", "/notifications"),
  markNotificationsRead: (which: { ids: string[] } | { all: true }) =>
    rest<{ ok: boolean }>("POST", "/notifications/read", which),

  /** One page of the member's conversations, newest first. */
  asks: (cursor: string | null = null) =>
    rest<{ asks: AskSummary[]; next_cursor: string | null }>(
      "GET",
      `/asks${q({ kind: "ask", cursor })}`,
    ),
  /** One conversation and its events after `afterSeq`, read until a short
   *  page: a log cut at a page boundary would look like a finished answer. */
  ask: async (askId: string, afterSeq = 0): Promise<AskDetail> => {
    let after = afterSeq;
    let ask: AskSummary | null = null;
    let feedback: AskDetail["feedback"] = [];
    const events: AtlasEvent[] = [];
    for (;;) {
      const page = await rest<AskDetail>(
        "GET",
        `/asks/${encodeURIComponent(askId)}${q({ after_seq: after })}`,
      );
      ask = page.ask;
      feedback = page.feedback ?? feedback;
      events.push(...page.events);
      const last = lastOf(page.events);
      if (!last || page.events.length < ATLAS_LIMITS.eventsPage) break;
      after = last.seq;
    }
    return { ask: ask!, events, feedback };
  },
  deleteAsk: (askId: string) => rest<null>("DELETE", `/asks/${encodeURIComponent(askId)}`),
  /** Thumbs on one answer, named by its `answer_done` event. */
  rate: (askId: string, eventSeq: number, rating: "up" | "down", note?: string) =>
    rest<null>("POST", `/asks/${encodeURIComponent(askId)}/feedback`, {
      event_seq: eventSeq,
      rating,
      ...(note ? { note } : {}),
    }),

  loops: (all = false) => rest<{ loops: Loop[] }>("GET", `/loops${all ? "?all=1" : ""}`),
  createLoop: (body: CreateLoopRequest) => rest<Loop>("POST", "/loops", body),
  setLoopStatus: (id: string, status: "active" | "paused") =>
    rest<Loop>("PATCH", `/loops/${encodeURIComponent(id)}`, { status }),
  deleteLoop: (id: string) => rest<null>("DELETE", `/loops/${encodeURIComponent(id)}`),

  memory: () => rest<{ items: MemoryItem[] }>("GET", "/memory"),
  forget: (id: string) => rest<null>("DELETE", `/memory/${encodeURIComponent(id)}`),
};

/** The questions the empty state offers — the web's own three. */
export const ORG_AGENT_SUGGESTIONS = [
  "What did I work on this week?",
  "What is the team working on today?",
  "Which of my sessions have open comments?",
] as const;
