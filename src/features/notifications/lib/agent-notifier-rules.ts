/**
 * The agent notifier's rules — pure, no store or Tauri imports. It classifies
 * an agent event (a turn ending, a permission request or question, the agent process
 * dying) into a notification-catalog kind (`classifyAgentEvent`); the shared
 * `decideNotification` picks the channels from `prefsFromSettings`.
 * `agent-notifier.ts` supplies the environment and delivers.
 *
 * Copy: title `<agent> · <thread>`, subtitle = the project when it is not the
 * active one, body says what happened (stop reason, first sentence of the
 * final message, duration, files edited). The OS already shows the app name,
 * so "Atlas" never appears in it.
 */
import type { NotificationTarget } from "./catalog";
import { firstSentence } from "./agent-summary";
import { signInDedupeKey } from "./agent-signin-rules";
import { formatResetTime, rateWindowLabel, type RateSlot } from "./agent-warning-rules";
import { formatFileCount, formatTurnDuration } from "./agent-turn-stats";
import {
  decideNotification,
  type NotificationDecision,
  type NotificationEnv,
  type NotificationEvent,
} from "./decide";
import { prefsFromSettings } from "./prefs";
import {
  bannerAnswerable,
  parsePermissionOptions,
  permissionBannerActions,
} from "./permission-actions-rules";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import type { ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";

export type AgentCtx = Omit<Extract<NotificationTarget, { type: "session" }>, "type"> & {
  /** The session's title, when it has one. */
  sessionTitle?: string;
  /** The agent's display name, from the agent registry. */
  agentName?: string;
};

export type AgentErrorKind = "auth" | "transient" | "fatal" | "process_dead" | "unknown";

/** What the agent adapter hands the classifier. `nonce` makes the dedupe key
 *  unique per occurrence (a turn_seq, or a counter for agents without one). */
export type AgentNotifyEvent =
  | {
      type: "permission_requested";
      requestId: string;
      /** The raw ACP `tool_call` of the request; see `describePermission`. */
      toolCall?: unknown;
      toolTitle?: string;
      /** The ACP options the agent offered (`kind` decides the banner actions). */
      options?: unknown;
    }
  | {
      type: "question_asked";
      requestId: string;
      /** The question, as the agent worded it. May be empty (url mode). */
      message: string;
    }
  | {
      type: "turn_finished";
      stopReason: string;
      nonce: string | number;
      /** Wall time of the turn, when known. */
      durationMs?: number;
      /** First sentence of the final assistant message, when there is one. */
      summary?: string | null;
      /** Files the turn edited. */
      filesEdited?: number;
    }
  | { type: "turn_failed"; error: string; errorKind?: AgentErrorKind; nonce: string | number }
  // An agent cannot run until the user signs in to it. `episode` is the
  // sign-in episode (`agent-signin-rules.ts`): repeats within one share a key.
  | { type: "sign_in_required"; agentType: string; episode: number }
  | { type: "agent_disconnected"; agentId: string; reason: string; nonce: string | number }
  // Warning tier — the firing rules live in `agent-warning-rules.ts`.
  | { type: "context_warning"; percent: number; crossing: number }
  | {
      type: "rate_limit_warning";
      slot: RateSlot;
      percent: number;
      windowMinutes: number | null;
      resetsAt: number | null;
      seq: number;
    }
  | {
      type: "retrying";
      attempt: number;
      maxAttempts: number;
      lastError: string;
      episode: number;
      /** First of its episode: create the toast; otherwise update it. */
      first: boolean;
    }
  // Atlas woke the agent about a watched pull request (`pull_request_watch.rs`).
  | { type: "pull_request_watch"; summary: string; nonce: string };

/** A turn_seq below the session's current one belongs to a turn already
 *  superseded by a newer send. 0 / absent (the native agent) is current. */
export function isSupersededTurn(turnSeq: number | undefined, currentTurnSeq: number | undefined) {
  return !!turnSeq && turnSeq < (currentTurnSeq ?? 0);
}

const BODY_BY_STOP_REASON: Record<string, string> = {
  max_tokens: "Hit the output limit",
  max_turn_requests: "Hit the turn limit",
  refusal: "Declined",
};

/** The one-line note a failed turn carries, by error kind. Kinds whose
 *  cause the user cannot read off the wording append the agent's own error. */
export function failureBody(kind: AgentErrorKind | undefined, error: string): string {
  const detail = firstSentence(error);
  switch (kind) {
    case "auth":
      return "Sign-in expired — sign in again to continue";
    case "transient":
      return "Temporary problem — try again in a moment";
    case "process_dead":
      return "The agent process stopped — restart it to continue";
    case "fatal":
      return detail ? `Failed — ${detail}` : "Failed — the run cannot continue";
    default:
      return detail ?? "Something went wrong";
  }
}

const VERB_BY_TOOL_KIND: Record<string, string> = {
  execute: "Run",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  read: "Read",
  fetch: "Fetch",
  search: "Search",
};
const TARGET_KEYS = ["command", "cmd", "file_path", "filePath", "path", "url", "pattern", "query"];
const DETAIL_MAX = 80;

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1).trimEnd()}…` : t;
};

/** A permission's one-line description and whether it shows the whole thing. */
export interface PermissionDescription {
  text: string;
  /** False when `text` is not the complete command/target: cut at the cap, a
   *  multi-line command flattened to one line (newlines run commands apart, so
   *  the flat form is not the same command), or no command/target found at all
   *  (only the call's title). A banner must not offer Allow on such a request —
   *  the user would approve what they cannot see. */
  complete: boolean;
}

/** "Run npm test" / "Edit src/auth.ts" — the tool and its command or target,
 *  on one line. Reads the ACP tool call generically (kind + raw input); no
 *  per-agent shapes. Falls back to the call's title, then "a tool". */
export function describePermissionDetail(
  toolCall: unknown,
  fallbackTitle?: string,
): PermissionDescription {
  const tc = (toolCall && typeof toolCall === "object" ? toolCall : {}) as Record<string, unknown>;
  const title = typeof tc.title === "string" ? tc.title : (fallbackTitle ?? "");
  const kind = typeof tc.kind === "string" ? tc.kind : "";
  const input = (tc.rawInput ?? tc.raw_input) as Record<string, unknown> | undefined;
  let target = "";
  if (input && typeof input === "object") {
    for (const k of TARGET_KEYS) {
      if (typeof input[k] === "string" && input[k]) {
        target = input[k] as string;
        break;
      }
    }
  }
  const verb = VERB_BY_TOOL_KIND[kind];
  // For shell calls the ACP title IS the command.
  if (!target && kind === "execute") target = title;
  if (verb && target) {
    const text = oneLine(`${verb} ${target}`);
    return { text, complete: !text.endsWith("…") && !/[\r\n]/.test(target.trim()) };
  }
  if (title) return { text: oneLine(title), complete: false };
  return { text: kind ? oneLine(kind) : "a tool", complete: false };
}

export function describePermission(toolCall: unknown, fallbackTitle?: string): string {
  return describePermissionDetail(toolCall, fallbackTitle).text;
}

const QUESTION_MAX = 120;

/** The agent's question on one line, capped at a word boundary where it can. */
export function describeQuestion(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  if (!t) return "Has a question for you";
  if (t.length <= QUESTION_MAX) return t;
  const cut = t.slice(0, QUESTION_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > QUESTION_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The dedupe key a permission request's notification (and its toast) carries. */
export const permissionDedupeKey = (sessionKey: string, requestId: string) =>
  `${sessionKey}:${requestId}:permission`;

/** The dedupe key a question's notification (and its toast) carries. */
export const questionDedupeKey = (sessionKey: string, requestId: string) =>
  `${sessionKey}:${requestId}:question`;

/** The retry toast's dedupe key — also what its toast id derives from, so the
 *  notifier can update (or dismiss) it in place. One per retry episode. */
export const retryDedupeKey = (sessionKey: string, episode: number) =>
  `${sessionKey}:retry:${episode}`;

/** "Retrying — attempt 3 of 5 · Connection reset" */
export function describeRetry(attempt: number, maxAttempts: number, lastError: string): string {
  const head = `Retrying — attempt ${attempt} of ${maxAttempts}`;
  const detail = firstSentence(lastError);
  return detail ? `${head} · ${detail}` : head;
}

/** "5-hour rate limit 92% used — resets 3:45 PM" */
export function describeRateLimit(
  percent: number,
  windowMinutes: number | null,
  resetsAt: number | null,
  now?: Date,
  locale?: string | string[],
): string {
  const label = rateWindowLabel(windowMinutes);
  const head = `${label ? `${label[0].toUpperCase()}${label.slice(1)} rate` : "Rate"} limit ${percent}% used`;
  return resetsAt == null ? head : `${head} — resets ${formatResetTime(resetsAt, now, locale)}`;
}

const projectSubtitle = (ctx: AgentCtx, projectActive: boolean) =>
  !projectActive && ctx.projectName ? ctx.projectName : undefined;

/** Agent event → catalog event, or null when it is not notification-worthy
 *  at all (independent of environment and channel prefs). */
export function classifyAgentEvent(
  e: AgentNotifyEvent,
  ctx: AgentCtx,
  projectActive: boolean,
  minDurationMs: number,
): NotificationEvent | null {
  const target: NotificationTarget = {
    type: "session",
    tabId: ctx.tabId,
    sessionId: ctx.sessionId,
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    orgId: ctx.orgId,
  };
  const sid = ctx.sessionId ?? ctx.tabId;
  if (e.type === "sign_in_required") {
    // Not about a thread: the click opens the agent's sign-in, and one
    // notification stands for every thread of that agent.
    return {
      kind: "agent-sign-in",
      title: `Sign in to ${ctx.agentName || "agent"}`,
      subtitle: projectSubtitle(ctx, projectActive),
      body: ctx.sessionTitle ? `Signed out — "${ctx.sessionTitle}" is waiting` : "Signed out",
      target: { type: "agent-sign-in", agentType: e.agentType },
      dedupeKey: signInDedupeKey(e.agentType, e.episode),
    };
  }
  const agent = ctx.agentName || "Agent";
  const title = ctx.sessionTitle ? `${agent} · ${ctx.sessionTitle}` : agent;
  // Name the project only when it is not the one on screen.
  const subtitle = projectSubtitle(ctx, projectActive);
  const base = { title, subtitle, target };

  switch (e.type) {
    case "permission_requested": {
      const detail = describePermissionDetail(e.toolCall, e.toolTitle);
      return {
        ...base,
        kind: "permission",
        body: `Needs approval — ${detail.text}`,
        dedupeKey: permissionDedupeKey(sid, e.requestId),
        permission: {
          sessionId: sid,
          requestId: e.requestId,
          options: parsePermissionOptions(e.options),
          complete: detail.complete,
          answerable: bannerAnswerable(e.toolCall),
        },
      };
    }
    case "question_asked":
      return {
        ...base,
        kind: "agent-question",
        body: describeQuestion(e.message),
        dedupeKey: questionDedupeKey(sid, e.requestId),
      };
    case "turn_finished": {
      // A cancelled turn is a click the user just made.
      if (e.stopReason === "cancelled") return null;
      if (minDurationMs > 0 && e.durationMs !== undefined && e.durationMs < minDurationMs) {
        return null;
      }
      const stats = [formatTurnDuration(e.durationMs), formatFileCount(e.filesEdited ?? 0)];
      const lead =
        BODY_BY_STOP_REASON[e.stopReason] ??
        (e.summary ? e.summary : stats.some(Boolean) ? "" : "Done");
      const body = [lead, ...stats].filter(Boolean).join(" · ");
      return { ...base, kind: "agent-done", body, dedupeKey: `${sid}:${e.nonce}:done` };
    }
    case "turn_failed":
      return {
        ...base,
        kind: "agent-failed",
        body: failureBody(e.errorKind, e.error),
        dedupeKey: `${sid}:${e.nonce}:failed`,
      };
    case "agent_disconnected":
      return {
        ...base,
        kind: "agent-disconnected",
        body: failureBody("process_dead", ""),
        dedupeKey: `${sid}:${e.agentId}:${e.nonce}:disconnected`,
      };
    case "context_warning":
      return {
        ...base,
        kind: "agent-context-warning",
        body: `Context window ${e.percent}% full`,
        dedupeKey: `${sid}:context:${e.crossing}`,
      };
    case "rate_limit_warning":
      return {
        ...base,
        kind: "agent-rate-limit",
        body: describeRateLimit(e.percent, e.windowMinutes, e.resetsAt),
        // Quotas are account-level: the key carries no thread.
        dedupeKey: `rate:${e.slot}:${e.seq}`,
      };
    case "retrying":
      return {
        ...base,
        kind: "agent-retrying",
        body: describeRetry(e.attempt, e.maxAttempts, e.lastError),
        dedupeKey: retryDedupeKey(sid, e.episode),
      };
    case "pull_request_watch":
      return {
        ...base,
        kind: "pull-request-watch",
        body: `Pull request ${e.summary} — the agent is looking into it`,
        dedupeKey: `${sid}:${e.nonce}:pull-request-watch`,
      };
  }
}

/** A session's history row and the paths of the project group it sits in. */
export interface HistorySession {
  row: ThreadRow;
  groupPaths: readonly string[];
}

/** The history row of a session no tab shows: by Atlas's `threadId`, else by
 *  the agent's session id. Null when history does not list it. */
export function findHistorySession(
  groups: readonly ThreadProject[],
  threadId: string,
  sessionId?: string,
): HistorySession | null {
  let bySession: HistorySession | null = null;
  for (const group of groups) {
    for (const row of group.threads) {
      if (threadId && row.threadId === threadId) return { row, groupPaths: group.paths };
      if (!bySession && sessionId && row.sessionId === sessionId) {
        bySession = { row, groupPaths: group.paths };
      }
    }
  }
  return bySession;
}

/** Classify + decide — the whole agent rule set as one pure call. */
export function decideAgentNotification(
  e: AgentNotifyEvent,
  ctx: AgentCtx,
  env: NotificationEnv,
  settings: AppSettings,
): NotificationDecision | null {
  if (!settings.notificationsEnabled) return null;
  const event = classifyAgentEvent(e, ctx, env.projectActive, settings.notifyAgentMinDurationMs);
  if (!event) return null;
  const decision = decideNotification(event, env, prefsFromSettings(settings));
  if (decision && event.permission) {
    const { options, complete, answerable, sessionId, requestId } = event.permission;
    const actions = permissionBannerActions({
      options,
      complete,
      answerable,
      enabled: settings.notifyPermissionActions,
    });
    if (actions.length > 0) {
      decision.native.actions = actions;
      decision.native.permission = { sessionId, requestId };
    }
  }
  return decision;
}
