import { agents } from "./agents-api";
import { resumeThread } from "./history-api";
import { errInfo } from "./agent-signin";
import { snapshotMessageToWire } from "./snapshot-message";
import type { AgentInfo } from "@/types/acp";
import type { SessionKey, SessionMessage, SessionSnapshot } from "@/types/agents";

type WireMessage = ReturnType<typeof snapshotMessageToWire>;

/**
 * Session resume, shared by every "open a past chat" path
 * (`session-sidebar.handleOpenAgent`, `openAgentSession`).
 *
 * **One paint, after the session is loaded** — Zed's model
 * (`conversation_view.rs:1149-1206`: the view is not built until `session/load`
 * resolves, and the thread accumulates replayed entries invisibly until then).
 *
 * This replaced a two-stage resume that painted the on-disk transcript first
 * and the authoritative snapshot second. The idea was that the disk content was
 * already there and the agent handshake was pure waiting — true, but the disk
 * transcript stores prose ONLY. It has no tool calls, no thinking, no plan
 * (`agent_transcript.rs` stores role/content/timestamp/model, and
 * `transcript_to_messages` hard-codes `tool_calls: Vec::new()`). So the first
 * paint was *guaranteed* to be an incomplete render of the same conversation,
 * and the second paint — a whole-list replace that re-keyed every message —
 * remounted the transcript seconds later. That is exactly the "messages and
 * tool calls are missing and then suddenly they all load" the user reported;
 * it was the design working as written, not a race.
 *
 * A skeleton for the length of the agent handshake is the honest trade: nothing
 * is shown until what is shown is complete and correct.
 *
 * The disk transcript still has one job here — see `paintableMessages`.
 */
export interface ResumeCallbacks {
  /** Paint messages into the thread. Called exactly ONCE, after the session is
   *  loaded and its full transcript is known. */
  paint: (messages: WireMessage[]) => void;
  /** Drop the skeleton. Fired with the paint. */
  onPainted: () => void;
  /** True when a newer click/open has superseded this one — polled before every
   *  mutation so a superseded resume never repaints a tab the user has already
   *  navigated away from (mirrors the sidebar's load-token guard). */
  isStale: () => boolean;
}

/**
 * What to show for a loaded session: the agent's own replayed transcript when
 * there is one, else Atlas's recording of it.
 *
 * The snapshot is authoritative whenever it has content — it comes from the
 * ACP thread the agent just replayed into, so it carries tool calls and
 * thinking that Atlas's transcript never stored. But an agent that only
 * supports `session/resume` (no history replay), or one that failed to replay,
 * hands back an EMPTY thread. For those, Atlas's own transcript is the only
 * surviving record of the conversation, and showing nothing would read as data
 * loss. Prose-only history beats a blank thread.
 */
async function paintableMessages(
  snapshot: SessionSnapshot,
  sessionId: string,
  cwd: string,
): Promise<SessionMessage[]> {
  if (snapshot.messages.length > 0) return snapshot.messages;
  try {
    return await agents.replayTranscript(sessionId, cwd);
  } catch {
    // Best-effort: an unreadable transcript just means the empty thread stands.
    return [];
  }
}

/** Which stage of the resume failed. Callers map this to their own message +
 *  rollback: a `spawn` failure means no agent (nothing to roll back), a `load`
 *  failure must clear the optimistic binding so the tab isn't stranded pointing
 *  at a session the backend never loaded, and `snapshot` leaves the load intact.
 *
 *  `resume` is the history path's single step: `threads_resume` starts the
 *  agent *and* reopens the session in one call, so which half failed is not
 *  knowable from here — and it does not matter, because either way no binding
 *  exists and the optimistic one must go. Claiming `load` or `spawn` would be
 *  a guess dressed as a fact. */
export type ResumeStage = "spawn" | "load" | "snapshot" | "resume";

export class ResumeError extends Error {
  /** `atlas_acp::ErrorClass` wire token from the backend, when it sent one. */
  readonly kind: string | null;

  constructor(
    readonly stage: ResumeStage,
    readonly cause: unknown,
  ) {
    // `errInfo`, not String(cause): both stages this wraps (`agents_spawn`,
    // `agents_load_session`) reject with a structured `{message, kind}`, which
    // stringifies to "[object Object]".
    const info = errInfo(cause);
    super(info.message);
    this.name = "ResumeError";
    this.kind = info.kind;
  }
}

export interface ResumeResult {
  agent: AgentInfo;
  key: SessionKey;
  snapshot: SessionSnapshot;
}

/**
 * Load a session, then paint it once. Throws whatever `ensure`/`loadSession`
 * throws so callers keep their existing error handling (toast + rollback).
 */
export async function resumeSessionFast(opts: {
  sessionId: string;
  cwd: string;
  ensure: () => Promise<AgentInfo>;
  cb: ResumeCallbacks;
}): Promise<ResumeResult> {
  const { sessionId, cwd, ensure, cb } = opts;

  let agent: AgentInfo;
  try {
    agent = await ensure();
  } catch (err) {
    throw new ResumeError("spawn", err);
  }

  let key: SessionKey;
  try {
    // Resolves after the agent has replayed the session, so the thread behind
    // `key` is already complete when we read it.
    key = await agents.loadSession(agent.agent_id, sessionId, cwd);
  } catch (err) {
    throw new ResumeError("load", err);
  }

  let snapshot: SessionSnapshot;
  try {
    snapshot = await agents.snapshot(key);
  } catch (err) {
    throw new ResumeError("snapshot", err);
  }

  const messages = await paintableMessages(snapshot, sessionId, cwd);
  if (!cb.isStale()) {
    cb.paint(messages.map(snapshotMessageToWire));
    cb.onPainted();
  }

  return { agent, key, snapshot };
}

/** What opening a history row produced. */
export interface ResumedThreadResult extends Omit<ResumeResult, "agent"> {
  /**
   * The agent could only continue the session, not replay it. The old messages
   * are not coming back and the user has to be told — a conversation that
   * reopens empty with no explanation reads as data loss.
   */
  resumedWithoutHistory: boolean;
}

/**
 * Open a history row: same single-paint shape as [`resumeSessionFast`], with
 * the load driven by the thread rather than by a session id.
 *
 * The difference that matters is which protocol call is made. `threads_resume`
 * starts the agent if it is not running and then picks `session/load` or
 * `session/resume` by what that agent advertised, so this path works for an
 * agent that can only continue a conversation — and says so when it did. When
 * it did, the thread comes back empty and `paintableMessages` falls back to
 * Atlas's own transcript.
 */
export async function resumeThreadFast(opts: {
  threadId: string;
  /** The thread's OWN working directory — not the open project's. A row from
   *  another worktree resumes into the worktree it belongs to. */
  cwd: string;
  /** The agent's session id, when the thread has one. Drafts have none, and
   *  there is nothing on disk to replay for them. */
  sessionId: string | null;
  cb: ResumeCallbacks;
}): Promise<ResumedThreadResult> {
  const { threadId, cwd, sessionId, cb } = opts;

  let resumed: Awaited<ReturnType<typeof resumeThread>>;
  try {
    resumed = await resumeThread(threadId);
  } catch (err) {
    throw new ResumeError("resume", err);
  }

  let snapshot: SessionSnapshot;
  try {
    snapshot = await agents.snapshot(resumed.key);
  } catch (err) {
    throw new ResumeError("snapshot", err);
  }

  const messages = sessionId
    ? await paintableMessages(snapshot, sessionId, cwd)
    : snapshot.messages;
  if (!cb.isStale()) {
    cb.paint(messages.map(snapshotMessageToWire));
    cb.onPainted();
  }

  return {
    key: resumed.key,
    snapshot,
    resumedWithoutHistory: resumed.resumedWithoutHistory,
  };
}
