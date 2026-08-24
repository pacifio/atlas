// Elicitations an agent raises outside any session.
//
// The session-scoped ones belong to a chat and are rendered by that chat's
// panel. These have no session: they are the questions asked during SIGN-IN —
// a device code to type, a page to visit — and they can arrive before the
// agent has ever opened a session, from any surface that triggers a login
// (the chat's sign-in dialog, the Marketplace, a mid-turn auth failure).
//
// So this mounts once, at the app root, and renders the SAME `ElicitationModal`
// the chat uses. No new visual pattern: it is the same dialog, sourced from the
// connection instead of the thread.

import { useEffect, useState } from "react";
import {
  listenAgentElicitation,
  listenAgentElicitationResolved,
  type RequestElicitation,
} from "../lib/agents-api";
import { ElicitationModal } from "./elicitation-modal";

/** Add a question to the queue, unless it is already in it.
 *
 *  A queue, not a slot: two agents can be signing in at once, and a question
 *  the user is never shown is one its agent waits on forever. Oldest is
 *  answered first — the one that has been blocking longest.
 *
 *  Deduped by request id because the backend refuses to announce the same
 *  entry twice, and a remount must not double it either. */
export function enqueueElicitation(
  queue: RequestElicitation[],
  next: RequestElicitation,
): RequestElicitation[] {
  return queue.some((q) => q.requestId === next.requestId) ? queue : [...queue, next];
}

export function AgentElicitationHost() {
  const [pending, setPending] = useState<RequestElicitation[]>([]);

  useEffect(() => {
    const unlisten = listenAgentElicitation((elicitation) => {
      setPending((queue) => enqueueElicitation(queue, elicitation));
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // The agent can answer its own question: a device-code login completes in the
  // browser and it sends `session/complete_elicitation`. Drop the dialog rather
  // than leave it asking for something that already happened.
  useEffect(() => {
    const unlisten = listenAgentElicitationResolved((requestId) => {
      setPending((queue) => queue.filter((q) => q.requestId !== requestId));
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const current = pending[0];
  if (!current) return null;
  return (
    <ElicitationModal
      key={current.requestId}
      pending={current}
      onClose={() => setPending((queue) => queue.filter((q) => q.requestId !== current.requestId))}
    />
  );
}
