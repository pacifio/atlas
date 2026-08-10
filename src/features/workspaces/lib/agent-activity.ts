import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/features/chat/stores/chat-store";

/**
 * Running-agent activity per workspace, derived from the chat store.
 *
 * Why derive instead of a dedicated store: every HOT workspace's chat sessions
 * are resident in `chat-store` (keyed by unique tab id), and a workspace with a
 * running agent is never discarded — so a running session is always present
 * here with its `workingDirectory` (== the workspace path). Counting those by
 * path gives an accurate per-workspace running count without a parallel store
 * or threading `cwd` through the agent delta bus.
 */

const ACTIVE: ReadonlySet<string> = new Set(["running", "waiting"]);

/** Non-reactive: running-session count for a workspace path. Used by the
 *  residency manager to avoid discarding a workspace with live agents. */
function runningCountForPath(path: string): number {
  const sessions = useChatStore.getState().sessions;
  let n = 0;
  for (const s of Object.values(sessions)) {
    if (s.workingDirectory === path && ACTIVE.has(s.status)) n++;
  }
  return n;
}

export function isWorkspaceRunning(path: string): boolean {
  return runningCountForPath(path) > 0;
}

/** Reactive: set of LIVE running chat keys (each running session's tab id +
 *  acp session id). The workspace "Chats" section uses this to mark a recent
 *  chat as active from the live chat-store rather than a persisted (and
 *  restart-stale) status field. */
export function useRunningChatKeys(): Set<string> {
  const keys = useChatStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((sess) => ACTIVE.has(sess.status))
        .flatMap((sess) => [sess.id, sess.acpSessionId])
        .filter((x): x is string => !!x)
        .sort(),
    ),
  );
  return useMemo(() => new Set(keys), [keys]);
}
