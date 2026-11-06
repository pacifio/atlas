/**
 * Agent notifications: the agent's source adapter onto the shared
 * notification pipeline.
 *
 * ENTRY POINT — `notifyAgentEvent(delta)`. App.tsx's session-delta listener
 * forwards `permission_request`, `elicitation_requested`, `turn_finished`, `turn_failed`,
 * `agent_disconnected` and the warning deltas (`context_usage`, `rate_limits`,
 * `retry_status`) here and does nothing else notification-related.
 *
 * Flow: delta → `AgentNotifyEvent` → `decideAgentNotification` (pure, in
 * `agent-notifier-rules.ts`: classify into a catalog kind, then the shared
 * decision picks channels) → `deliverNotification`. Stale turns (superseded by
 * a newer send) and user-cancelled turns never notify.
 *
 * A finish reads the turn's final text, duration and edited files from the chat
 * store, which only has them once `turn_finished` is applied — App.tsx flushes
 * its delta buffer before calling in.
 *
 * Bursts: OS banners for `agent-done` are held for a short window and leave
 * as one "N agents finished" (`banner-coalescer.ts`); center, toast and badge
 * are not delayed.
 */
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { projectIdForTab } from "@/features/chat/lib/tab-project";
import type { AgentDelta } from "@/types/agents";
import type { ChatSession } from "@/types/agent";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import {
  decideAgentNotification,
  isSupersededTurn,
  permissionDedupeKey,
  questionDedupeKey,
  retryDedupeKey,
  type AgentCtx,
  type AgentNotifyEvent,
} from "./agent-notifier-rules";
import {
  INITIAL_CONTEXT_STATE,
  INITIAL_RATE_STATE,
  INITIAL_RETRY_STATE,
  endRetryEpisode,
  evaluateContextUsage,
  evaluateRateLimits,
  evaluateRetry,
  type ContextWarnState,
  type RateWarnState,
  type RetryWarnState,
} from "./agent-warning-rules";
import {
  INITIAL_SIGN_IN_EPISODE,
  openSignInEpisode,
  resolveSignInEpisode,
  signInDedupeKey,
  type SignInEpisode,
} from "./agent-signin-rules";
import { canSignIn } from "@/features/chat/lib/agent-signin";
import { turnStats } from "./agent-turn-stats";
import { createBannerCoalescer } from "./banner-coalescer";
import { computeAway, type NotificationDecision, type NotificationEnv } from "./decide";
import { deliverNotification, notificationToastId, openNotificationTarget } from "./deliver";
import { toast } from "sonner";
import { clearResolved } from "./resolve";
import { openTabForSession, resolveHistorySession } from "./open-session-target";
import { resumeAgentFor } from "@/features/chat/lib/sidebar-agents";
import type { NotificationKind } from "./catalog";

/** Banners of finishes within this window of the first merge into one. */
export const FINISH_BANNER_WINDOW_MS = 3_000;

const finishBanners = createBannerCoalescer({
  windowMs: FINISH_BANNER_WINDOW_MS,
  // Native-only: the other channels were delivered when each finish landed.
  emit: (d) =>
    deliverNotification({
      ...d,
      dedupeKey: `${d.dedupeKey}:banner`,
      channels: { center: false, toast: false, badge: false, sound: false, native: true },
    }),
});

function findSession(acpSessionId: string): { tabId: string; session: ChatSession } | null {
  for (const [tabId, session] of Object.entries(useChatStore.getState().sessions)) {
    if (session.acpSessionId === acpSessionId) return { tabId, session };
  }
  return null;
}

/** True when this turn was superseded by a newer send — the chat store ignores
 *  its terminal delta, so nothing downstream (notification, reindex) may act. */
export function isStaleAgentTurn(sessionId: string, turnSeq?: number): boolean {
  const found = findSession(sessionId);
  return !!found && isSupersededTurn(turnSeq, found.session.currentTurnSeq);
}

// Warning-rule state (pure rules in `agent-warning-rules.ts`). Context and retry
// are per thread; the rate-limit quota is account-level, so one global state.
const contextState = new Map<string, ContextWarnState>();
const retryState = new Map<string, RetryWarnState>();
let rateState: RateWarnState = INITIAL_RATE_STATE;

/** The turn is over: close its retry episode and drop the retry toast. */
function endRetry(sessionId: string): void {
  const st = retryState.get(sessionId);
  if (!st?.active) return;
  toast.dismiss(`bg-session-${retryDedupeKey(sessionId, st.episode)}`);
  retryState.set(sessionId, endRetryEpisode(st));
}

// Sign-in episodes per agent type (pure rules in `agent-signin-rules.ts`).
const signInEpisodes = new Map<string, SignInEpisode>();

/** The agent works again (signed in, or a turn completed): close its episode,
 *  drop the sign-in toast, mark the center item read and refresh the badge. */
export function resolveAgentSignIn(agentType: string): void {
  try {
    const st = signInEpisodes.get(agentType);
    if (!st?.open) return;
    signInEpisodes.set(agentType, resolveSignInEpisode(st));
    clearResolved({
      kind: "agent-sign-in",
      target: { type: "agent-sign-in", agentType },
      dedupeKey: signInDedupeKey(agentType, st.episode),
      markRead: [{ kind: "agent-sign-in", agentType }],
    });
  } catch (err) {
    console.warn("agent sign-in clear failed:", err);
  }
}

/** Open (or stay in) the agent's current sign-in episode; the event carries it. */
function signInRequired(agentType: string): AgentNotifyEvent {
  const st = openSignInEpisode(signInEpisodes.get(agentType) ?? INITIAL_SIGN_IN_EPISODE);
  signInEpisodes.set(agentType, st);
  return { type: "sign_in_required", agentType, episode: st.episode };
}

let counter = 0;
const nonceFor = (turnSeq?: number) => turnSeq || `n${++counter}`;

function toNotifyEvent(env: AgentDelta, session: ChatSession): AgentNotifyEvent | null {
  switch (env.kind) {
    case "permission_request": {
      const tc = env.tool_call as Record<string, unknown> | undefined;
      const toolTitle =
        (typeof tc?.title === "string" && tc.title) ||
        (typeof tc?.kind === "string" && tc.kind) ||
        "tool call";
      return {
        type: "permission_requested",
        requestId: String(env.request_id),
        toolCall: env.tool_call,
        toolTitle,
        options: env.options,
      };
    }
    case "elicitation_requested":
      return { type: "question_asked", requestId: env.request_id, message: env.message };
    case "context_usage": {
      const r = evaluateContextUsage(
        contextState.get(env.session_id) ?? INITIAL_CONTEXT_STATE,
        env.used,
        env.size,
      );
      contextState.set(env.session_id, r.state);
      return r.warning && { type: "context_warning", ...r.warning };
    }
    case "rate_limits": {
      const r = evaluateRateLimits(rateState, { primary: env.primary, secondary: env.secondary });
      rateState = r.state;
      // Every live session hears the same snapshot; the first one speaks.
      // Both windows crossing in one snapshot is rare; the fuller one speaks.
      const w = r.warnings.reduce<(typeof r.warnings)[number] | undefined>(
        (a, b) => (!a || b.percent > a.percent ? b : a),
        undefined,
      );
      return w ? { type: "rate_limit_warning", ...w } : null;
    }
    case "retry_status": {
      const r = evaluateRetry(retryState.get(env.session_id) ?? INITIAL_RETRY_STATE, env.attempt);
      retryState.set(env.session_id, r.state);
      return (
        r.update && {
          type: "retrying",
          attempt: env.attempt,
          maxAttempts: env.max_attempts,
          lastError: env.last_error,
          episode: r.update.episode,
          first: r.update.first,
        }
      );
    }
    case "turn_finished": {
      endRetry(env.session_id);
      // A completed turn proves the agent's credentials work again.
      if (env.stop_reason !== "cancelled") resolveAgentSignIn(session.agentType);
      const stats = turnStats(session.messages, Date.now());
      return {
        type: "turn_finished",
        stopReason: env.stop_reason,
        nonce: nonceFor(env.turn_seq),
        durationMs: stats.durationMs,
        summary: stats.summary,
        filesEdited: stats.filesEdited,
      };
    }
    case "turn_failed":
      endRetry(env.session_id);
      // One clear notification: an auth failure of an agent with a sign-in is
      // "sign in to X" (its click opens the dialog), not also "run failed —
      // sign-in expired". Without a sign-in flow (native / BYOK keys) it stays
      // an ordinary failure.
      if (env.error_kind === "auth" && canSignIn(session.agentType)) {
        return signInRequired(session.agentType);
      }
      return {
        type: "turn_failed",
        error: env.error,
        errorKind: env.error_kind,
        nonce: nonceFor(env.turn_seq),
      };
    case "agent_disconnected":
      return {
        type: "agent_disconnected",
        agentId: env.agent_id,
        reason: env.reason,
        nonce: nonceFor(),
      };
    default:
      return null;
  }
}

/** `tabId` null: no tab shows the source, so it is never the one in view. */
function envFor(tabId: string | null, projectId: string | undefined): NotificationEnv {
  const windowFocused = isWindowFocused();
  const sinceInputMs = Date.now() - lastInteraction();
  return {
    targetVisible: tabId !== null && useLayoutStore.getState().activeTabId === tabId,
    windowFocused,
    sinceInputMs,
    projectActive: !projectId || projectId === useProjectStore.getState().activeProjectId,
    away: computeAway(windowFocused, sinceInputMs),
  };
}

function buildCtx(tabId: string, session: ChatSession, sessionId: string) {
  const ws = useProjectStore.getState();
  const projectId = projectIdForTab(tabId) ?? undefined;
  const project = projectId ? ws.projects.find((w) => w.id === projectId) : undefined;
  const ctx: AgentCtx = {
    tabId,
    sessionId,
    sessionTitle: session.title || undefined,
    agentName: agentMeta(session.agentType).label,
    projectId,
    projectName: project?.name,
    orgId: project?.orgId,
  };
  return { ctx, projectId };
}

/** Forward an agent session delta to the pipeline. Ignores kinds that do not
 *  notify; never throws. */
export function notifyAgentEvent(env: AgentDelta): void {
  try {
    if (
      env.kind !== "permission_request" &&
      env.kind !== "elicitation_requested" &&
      env.kind !== "turn_finished" &&
      env.kind !== "turn_failed" &&
      env.kind !== "agent_disconnected" &&
      env.kind !== "context_usage" &&
      env.kind !== "rate_limits" &&
      env.kind !== "retry_status"
    ) {
      return;
    }
    if (
      (env.kind === "turn_finished" || env.kind === "turn_failed") &&
      isStaleAgentTurn(env.session_id, env.turn_seq)
    ) {
      return;
    }
    const found = findSession(env.session_id);
    // No open session: nothing to jump to.
    if (!found) return;
    const event = toNotifyEvent(env, found.session);
    if (env.kind === "turn_finished" || env.kind === "turn_failed") {
      clearSessionAttention(env.session_id);
    }
    if (!event) return;

    const { ctx, projectId } = buildCtx(found.tabId, found.session, env.session_id);
    const decision = decideAgentNotification(
      event,
      ctx,
      envFor(found.tabId, projectId),
      useSettingsStore.getState().settings,
    );
    if (!decision) return;
    noteOutstanding(env.session_id, decision);

    // Retry attempts after the first update the live toast in place — a plain
    // re-delivery would be deduped, and a new key would stack a second toast.
    if (event.type === "retrying" && !event.first) {
      updateRetryToast(decision);
      return;
    }
    if (decision.kind === "agent-done" && decision.channels.native) {
      const delivered = deliverNotification({
        ...decision,
        channels: { ...decision.channels, native: false, sound: false },
      });
      if (delivered) finishBanners.add(decision);
      return;
    }
    deliverNotification(decision);
  } catch (err) {
    console.warn("agent notifier failed:", err);
  }
}

/** A pull request watch wake, as `atlas:session-prompt-injected` carries it. */
export interface PullRequestWake {
  /** The ACP session the wake went to. */
  sessionId: string;
  threadId: string;
  summary: string;
  /** RFC 3339; makes the dedupe key unique per wake. */
  at: string;
}

/** Atlas woke a session's agent about a watched pull request. Notifies
 *  unless that session is the one in view: through its tab when one shows it,
 *  otherwise from its history row, and the click resumes it there. Its
 *  turn's own finish notifies as any turn's does. */
export async function notifyPullRequestWatch(wake: PullRequestWake): Promise<void> {
  try {
    const event: AgentNotifyEvent = {
      type: "pull_request_watch",
      summary: wake.summary,
      nonce: wake.at,
    };
    const settings = useSettingsStore.getState().settings;
    if (!settings.notificationsEnabled) return;
    const tabId = openTabForSession(wake.sessionId);
    const found = tabId ? useChatStore.getState().sessions[tabId] : undefined;
    let decision: NotificationDecision | null;
    if (tabId && found) {
      const { ctx, projectId } = buildCtx(tabId, found, wake.sessionId);
      ctx.threadId = wake.threadId || undefined;
      decision = decideAgentNotification(event, ctx, envFor(tabId, projectId), settings);
    } else {
      const ctx = await historyCtx(wake);
      // No tab shows it, so it is not the one in view.
      decision = decideAgentNotification(event, ctx, envFor(null, ctx.projectId), settings);
    }
    if (decision) deliverNotification(decision);
  } catch (err) {
    console.warn("pull request watch notification failed:", err);
  }
}

/** The context of a session no tab shows, from its history row. A session
 *  history does not list (yet) still notifies, under the bare agent name. */
async function historyCtx(wake: PullRequestWake): Promise<AgentCtx> {
  const base: AgentCtx = {
    tabId: "",
    sessionId: wake.sessionId,
    threadId: wake.threadId || undefined,
  };
  const resolved = await resolveHistorySession(wake.threadId, wake.sessionId).catch(() => null);
  if (!resolved) return base;
  const { row, project } = resolved;
  return {
    ...base,
    threadId: row.threadId,
    sessionTitle: row.title || undefined,
    agentName: agentMeta(resumeAgentFor(row.agentId)).label,
    projectId: project?.id,
    projectName: project?.name,
    orgId: project?.orgId,
  };
}

/** An agent refused to bind or run for want of sign-in, outside a turn failure
 *  (a bind failure on open). Same notification and episode as a failed turn's. */
export function notifyAgentSignInRequired(tabId: string, agentType: string): void {
  try {
    const session = useChatStore.getState().sessions[tabId];
    if (!session || !canSignIn(agentType)) return;
    const { ctx, projectId } = buildCtx(tabId, session, session.acpSessionId ?? tabId);
    const decision = decideAgentNotification(
      signInRequired(agentType),
      ctx,
      envFor(tabId, projectId),
      useSettingsStore.getState().settings,
    );
    if (decision) deliverNotification(decision);
  } catch (err) {
    console.warn("agent sign-in notification failed:", err);
  }
}

function updateRetryToast(d: NotificationDecision): void {
  if (!d.channels.toast) return;
  toast(d.title, {
    id: notificationToastId(d.target, d.dedupeKey),
    description: d.body,
    duration: d.toast.durationMs,
    action: { label: "Open", onClick: () => openNotificationTarget(d.target) },
  });
}

// Needs-you notifications still waiting on an answer, per session — what a turn
// ending (or the tab closing) clears when nothing answered them directly.
interface Outstanding {
  kind: NotificationKind;
  dedupeKey: string;
}
const outstanding = new Map<string, Map<string, Outstanding>>();

function noteOutstanding(sid: string, d: NotificationDecision): void {
  if (d.kind !== "permission" && d.kind !== "agent-question") return;
  const m = outstanding.get(sid) ?? new Map<string, Outstanding>();
  m.set(d.dedupeKey, { kind: d.kind, dedupeKey: d.dedupeKey });
  outstanding.set(sid, m);
}

/** Take a session's request down — toast, banner, center item — and forget it.
 *  Only marks the center read when no sibling request of that kind is still
 *  waiting (a second pending permission must stay unread). */
function resolveOutstanding(sid: string, kind: NotificationKind, dedupeKey: string): void {
  const m = outstanding.get(sid);
  m?.delete(dedupeKey);
  const othersWaiting = [...(m?.values() ?? [])].some((o) => o.kind === kind);
  if (m?.size === 0) outstanding.delete(sid);
  clearResolved({
    kind,
    target: { type: "session", tabId: "", sessionId: sid },
    dedupeKey,
    markRead: othersWaiting ? [] : [{ kind, sessionId: sid }],
  });
}

/** A permission request was resolved — answered in-app, by another path, or
 *  cancelled. Idempotent; never throws. */
export function resolveAgentPermission(sessionId: string, requestId: string): void {
  try {
    resolveOutstanding(sessionId, "permission", permissionDedupeKey(sessionId, requestId));
  } catch (err) {
    console.warn("agent permission clear failed:", err);
  }
}

/** The turn is over (or the thread closed): nothing it was waiting on is
 *  answerable any more. */
export function clearSessionAttention(sessionId: string): void {
  try {
    for (const o of outstanding.get(sessionId)?.values() ?? []) {
      resolveOutstanding(sessionId, o.kind, o.dedupeKey);
    }
  } catch (err) {
    console.warn("agent attention clear failed:", err);
  }
}

/** The user answered or dismissed the agent's question. */
export function clearAgentQuestion(tabId: string, requestId: string): void {
  try {
    const session = useChatStore.getState().sessions[tabId];
    const sid = session?.acpSessionId ?? tabId;
    resolveOutstanding(sid, "agent-question", questionDedupeKey(sid, requestId));
  } catch (err) {
    console.warn("agent question clear failed:", err);
  }
}
