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

  const key: SessionKey = {
    agent_id: session.acpAgentId,
    session_id: session.acpSessionId,
  };
  const before = session.messages.length;

  let prompt: string | null;
  try {
    prompt = await agents.rewindLastTurn(key);
  } catch (err) {
    toast.error(`Could not rewind: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // `null` covers two cases the engine does not distinguish: it refused
  // because there was nothing left to drop, and it did not answer at all. The
  // wording says only what is certain — asserting "nothing to retry" at a dead
  // engine would send the user looking in the wrong place. Either way nothing
  // was removed, so there is nothing to restore.
  if (prompt === null) {
    toast.error("Could not rewind — nothing to retry, or the agent did not respond");
    return;
  }

  await awaitRewind(tabId, before);

  // Two awaits have passed since `key` was captured. A tab that switched agent
  // or rebound in between is a DIFFERENT session, and sending the old key's
  // prompt into it would put one conversation's text in another's transcript.
  // The rewind already landed; saying so is better than compounding it.
  const now = useChatStore.getState().sessions[tabId];
  if (now?.acpSessionId !== key.session_id || now?.acpAgentId !== key.agent_id) {
    toast.error("Rewound, but the session changed — your prompt was not re-sent");
    return;
  }

  // The stored prompt is the WIRE text — mentions expanded, injected context
  // and the next-steps directive included. Re-sending it verbatim reproduces
  // the original turn rather than a lossily-recomposed version of it, and the
  // transcript strips both suffixes for display the same way it does for a
  // freshly composed send (`derivedUser` in `turn-rows.ts`).
  //
  // Attachments do not survive: the thread records what was sent, not the
  // composer state that produced it.
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
    actions.addMessage(tabId, "assistant", `agent send error: ${msg}`);
    actions.updateSessionStatus(tabId, "error");
    logEvent({
      source: "agent",
      kind: "stream-error",
      summary: `retry send failed: ${msg.slice(0, 120)}`,
      payload: { tabId, acpSessionId: key.session_id, retry: true },
    });
  }
}
