import { agents } from "./agents-api";
import { errInfo } from "./agent-signin";
import { snapshotMessageToWire } from "./snapshot-message";
import type { AgentInfo } from "@/types/acp";
import type { SessionKey, SessionMessage, SessionSnapshot } from "@/types/agents";

type WireMessage = ReturnType<typeof snapshotMessageToWire>;

/**
 * Two-stage session resume, shared by every "open a past chat" path
 * (`session-sidebar.handleOpenAgent`, `openAgentSession`).
 *
 * The problem it solves: `agents.loadSession` computes the visible transcript in
 * its first few milliseconds and then blocks for SECONDS on the agent handshake
 * plus the ACP `session/load` replay. Awaiting it before painting meant the user
 * watched a skeleton while the content was already sitting in memory. Measured
 * on a 34 MB / 6.7k-line Claude transcript: the disk replay is ~42 ms, the JSON
 * that crosses IPC is 1.28 MB, and `JSON.parse` + the wire map cost under 4 ms —
 * so first paint is bounded by ~50 ms of real work and everything beyond that
 * was pure waiting on the agent.
 *
 * So we split it:
 *   - **stage 1 (fast, disk-only)** — `agents.replayTranscript` paints the thread.
 *   - **stage 2 (slow, concurrent)** — `ensureAgent` + `agents.loadSession` make
 *     the session sendable, then `agents.snapshot` reconciles.
 *
 * Both stages start in the SAME tick, so stage 2 is never delayed by stage 1.
 */
export interface ResumeCallbacks {
  /** Paint messages into the thread. Called once for the fast replay, and again
   *  from the snapshot ONLY if the snapshot actually differs. */
  paint: (messages: WireMessage[]) => void;
  /** Drop the skeleton. Fired as soon as anything is painted. */
  onPainted: () => void;
  /** True when a newer click/open has superseded this one — polled before every
   *  mutation so a superseded resume never repaints a tab the user has already
   *  navigated away from (mirrors the sidebar's load-token guard). */
  isStale: () => boolean;
}

/** Cheap equality probe between the fast-path replay and the authoritative
 *  snapshot. Both come from the same parser over the same file, so on a normal
 *  resume they match exactly and we can skip the second paint entirely — which
 *  matters because a repaint re-runs the virtualizer's measurement pass over
 *  every mounted row. We compare length plus the last message's shape rather
 *  than deep-equality: the only realistic divergence is a session that grew (a
 *  live turn landed) or a manager cache hit carrying live state the disk lacks. */
function sameThread(a: SessionMessage[], b: SessionMessage[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const x = a[a.length - 1];
  const y = b[b.length - 1];
  return (
    x.role === y.role &&
    x.content.length === y.content.length &&
    x.tool_calls.length === y.tool_calls.length
  );
}

/** Which stage of the resume failed. Callers map this to their own message +
 *  rollback: a `spawn` failure means no agent (nothing to roll back), a `load`
 *  failure must clear the optimistic binding so the tab isn't stranded pointing
 *  at a session the backend never loaded, and `snapshot` leaves the load intact. */
export type ResumeStage = "spawn" | "load" | "snapshot";

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
  /** Whether the fast path painted before the bind resolved. */
  fastPainted: boolean;
  agent: AgentInfo;
  key: SessionKey;
  snapshot: SessionSnapshot;
}

/**
 * Run the two-stage resume. Throws whatever `ensure`/`loadSession` throws so
 * callers keep their existing error handling (toast + rollback); a failure in the
 * FAST stage is swallowed, since it's an optimisation and the slow stage remains
 * authoritative.
 */
export async function resumeSessionFast(opts: {
  pluginId: string;
  sessionId: string;
  cwd: string;
  ensure: () => Promise<AgentInfo>;
  cb: ResumeCallbacks;
}): Promise<ResumeResult> {
  const { pluginId, sessionId, cwd, ensure, cb } = opts;

  // Kick off the SLOW chain first so it owns the full wall-clock window — the
  // fast replay must never sit in front of the agent spawn.
  const slow = (async () => {
    let agent: AgentInfo;
    try {
      agent = await ensure();
    } catch (err) {
      throw new ResumeError("spawn", err);
    }
    try {
      const key = await agents.loadSession(agent.agent_id, sessionId, cwd);
      return { agent, key };
    } catch (err) {
      throw new ResumeError("load", err);
    }
  })();
  // The fast stage awaits its own promise below; without this the slow chain
  // could reject before anyone is awaiting it and surface as an unhandled
  // rejection in the window between the two stages.
  slow.catch(() => {});

  // Stage 1 — disk replay. Best-effort: any failure (unknown plugin, missing
  // file) just means we fall through to the snapshot paint below. Empty is the
  // documented "no on-disk transcript" answer for Codex, not an error.
  let fastMessages: SessionMessage[] = [];
  let fastPainted = false;
  try {
    fastMessages = await agents.replayTranscript(pluginId, sessionId, cwd);
    if (fastMessages.length > 0 && !cb.isStale()) {
      cb.paint(fastMessages.map(snapshotMessageToWire));
      cb.onPainted();
      fastPainted = true;
    }
  } catch {
    // Optimisation only — the authoritative path below still runs.
  }

  // Stage 2 — the real bind. Errors propagate to the caller's handler, tagged
  // with the stage that failed.
  const { agent, key } = await slow;
  let snapshot: SessionSnapshot;
  try {
    snapshot = await agents.snapshot(key);
  } catch (err) {
    throw new ResumeError("snapshot", err);
  }

  // Only repaint when the snapshot actually says something different. On a clean
  // resume it doesn't, and skipping saves a full virtualizer re-measure.
  //
  // And never let a SHORTER snapshot replace the fast paint: stage 1 read the
  // JSONL just now, so it is strictly fresher disk truth. The manager's
  // load_session is an idempotent cache — a session whose transcript grew
  // while cached hands back a stale, shorter snapshot, and repainting from it
  // deleted the newest user messages from the visible thread.
  const snapshotIsStale = fastPainted && snapshot.messages.length < fastMessages.length;
  if (
    !cb.isStale() &&
    !snapshotIsStale &&
    (!fastPainted || !sameThread(fastMessages, snapshot.messages))
  ) {
    cb.paint(snapshot.messages.map(snapshotMessageToWire));
    cb.onPainted();
  }

  return { fastPainted, agent, key, snapshot };
}
