// Retry the last turn: rewind it on the agent, then re-send the prompt
// that started it.
//
// # Why this is not "send the text again"
//
// Appending the same prompt to the bottom of the thread is not a retry — it is
// the user re-typing, and it leaves the failed turn in the model's context for
// the second attempt to trip over. A retry has to REMOVE the turn first, which
// is a destructive backend operation, not a UI one.
//
// Native-agent-only, for the reason set out in `retry-gate.ts`.
//
// # Why rewind and send are two calls
//
// They fail apart. A rewind that lands followed by a send that does not must
// leave the user holding their prompt rather than a silently shortened thread,
// and that is only expressible if the caller sees both outcomes.

import { toast } from "sonner";
import type { SessionKey } from "@/types/agents";
import { useChatStore } from "../stores/chat-store";
import { agents } from "./agents-api";
import { sessionCanRetry } from "./retry-gate";
import { catalogEntry } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";

/**
 * Tabs with a rewind already in flight.
 *
 * The status gate cannot cover this. `updateSessionStatus(tabId, "running")`
 * only happens AFTER the rewind returns, so between the first click and that
 * point the session still reads idle and `sessionCanRetry` still says yes — a
 * double-click therefore issued two rollbacks and destroyed two turns, not
 * one. Claimed synchronously, before the first await, because anything async
 * reopens the same window it is trying to close.
 */
const inFlight = new Set<string>();

/**
 * Wait until the store reflects the rewind, so the re-sent message is not
 * spliced off by the `history_rewound` delta that is still in flight.
 *
 * The rewind's `EntriesRemoved` event and the command's own response travel on
 * different channels; nothing orders them. Rather than guess, this waits for
 * the effect to be observable and gives up after `timeoutMs` — the delta
 * normally lands in single-digit milliseconds, and proceeding late is better
 * than hanging on a delta that was dropped.
 */
function awaitRewind(tabId: string, before: number, timeoutMs = 3_000): Promise<boolean> {
  const shorter = () => (useChatStore.getState().sessions[tabId]?.messages.length ?? 0) < before;
  if (shorter()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const unsubscribe = useChatStore.subscribe(() => {
      if (shorter()) done(true);
    });
  });
}

/**
 * Rewind the last turn and re-run it.
 *
 * Fire-and-forget from the UI: the reply streams back through the usual
 * `atlas:agents` deltas, exactly as an ordinary send does.
 */
export async function retryLastTurn(tabId: string): Promise<void> {
  const store = useChatStore.getState();
  const session = store.sessions[tabId];
  if (!session?.acpAgentId || !session.acpSessionId) return;
  // Re-checked at click time, not just at render time: the turn may have
  // started streaming between the hover and the click.
  if (!sessionCanRetry(session, catalogEntry(session.agentType)?.supportsRewind === true)) {
    return;
  }

  if (inFlight.has(tabId)) return;
  inFlight.add(tabId);
  try {
    await runRetry(tabId, {
      agent_id: session.acpAgentId,
      session_id: session.acpSessionId,
    });
  } finally {
    inFlight.delete(tabId);
  }
}

async function runRetry(tabId: string, key: SessionKey): Promise<void> {
  const before = useChatStore.getState().sessions[tabId]?.messages.length ?? 0;

  let prompt: string | null;
  try {
    prompt = await agents.rewindLastTurn(key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(`Could not rewind: ${msg}`);
    logEvent({
      source: "agent",
      kind: "stream-error",
      summary: `retry rewind failed: ${msg.slice(0, 120)}`,
      payload: { tabId, acpSessionId: key.session_id, retry: true },
    });
    return;
  }
  // `null` is "the engine declined", which is almost always an empty thread —
  // but the request layer folds a refusal, a dead channel, and a channel that
  // died AFTER the rollback ran into one error, so this is not a promise that
  // nothing moved. The wording claims only what is certain; asserting "nothing
  // to retry" at a dead engine would send the user looking in the wrong place.
  // Nothing is enqueued here because in the overwhelmingly common case there
  // is no prompt to hand back.
  if (prompt === null) {
    toast.error("Could not rewind — nothing to retry, or the agent did not respond");
    return;
  }

  // From here the rewind HAS landed and the prompt exists only in this
  // closure — every bail-out below has to hand it back rather than drop it.
  // `enqueueMessage` is that hand-back: the composer shows a queued chip the
  // user can edit or send, and the drain effect only fires on a status or
  // binding transition, so nothing re-sends behind their back.
  const preserve = (why: string) => {
    useChatStore.getState().actions.enqueueMessage(tabId, prompt as string);
    toast.error(`${why} — your prompt is waiting in the composer`);
    logEvent({
      source: "agent",
      kind: "stream-error",
      summary: `retry not re-sent: ${why}`,
      payload: { tabId, acpSessionId: key.session_id, retry: true },
    });
  };

  // A false answer means the truncation never became observable. Sending
  // anyway is the worst of both: a late `history_rewound` splices off the
  // message just added, and a delta that never comes leaves the rewound turn
  // on screen with a duplicate under it.
  if (!(await awaitRewind(tabId, before))) {
    preserve("The rewind did not reach the transcript");
    return;
  }

  // Two awaits have passed since `key` was captured. A tab that switched agent
  // or rebound in between is a DIFFERENT session, and sending the old key's
  // prompt into it would put one conversation's text in another's transcript.
  const now = useChatStore.getState().sessions[tabId];
  if (now?.acpSessionId !== key.session_id || now?.acpAgentId !== key.agent_id) {
    preserve("The session changed before the retry could be sent");
    return;
  }

  // The stored prompt is the WIRE text — mentions expanded, injected context
  // and the next-steps directive included — so it is closer to the original
  // than a recomposition from the visible bubble would be, and the transcript
  // strips both suffixes for display the same way it does for a freshly
  // composed send (`derivedUser` in `turn-rows.ts`).
  //
  // It is NOT byte-identical. The thread flattens content blocks, so a
  // resource link comes back as a bare URI and mixed blocks lose the newlines
  // the original input carried (`thread.rs:99` vs `sink.rs:351`); no
  // `resourceLinks` are re-sent, and attachments are not reconstructed at all.
  // A prompt that was pure prose round-trips exactly; one that mixed prose and
  // `@`-mentions comes back flattened.
  const actions = useChatStore.getState().actions;
  actions.addMessage(tabId, "user", prompt);
  actions.updateSessionStatus(tabId, "running");
  logEvent({
    source: "chat",
    kind: "send-agent",
    summary: prompt.slice(0, 120),
    payload: { tabId, retry: true },
  });

  // Outcomes, not just the attempt: an ordinary send logs `stream-started` /
  // an error, and a retry that is invisible past its first line cannot be told
  // apart from a normal turn when reading the log back.
  try {
    await agents.send(key, prompt);
    logEvent({
      source: "agent",
      kind: "stream-started",
      summary: `retry dispatched to ${key.session_id}`,
      payload: { tabId, acpSessionId: key.session_id, retry: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Recheck: `agents.send` is another await, and writing an error bubble
    // through `tabId` after the tab rebound would blame the wrong session.
    const still = useChatStore.getState().sessions[tabId];
    if (still?.acpSessionId === key.session_id && still?.acpAgentId === key.agent_id) {
      actions.addMessage(tabId, "assistant", `agent send error: ${msg}`);
      actions.updateSessionStatus(tabId, "error");
    }
    logEvent({
      source: "agent",
      kind: "stream-error",
      summary: `retry send failed: ${msg.slice(0, 120)}`,
      payload: { tabId, acpSessionId: key.session_id, retry: true },
    });
  }
}
