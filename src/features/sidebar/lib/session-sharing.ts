// Whether a session is shared with the team, and how many comments it has —
// for a session that is not open in a tab, which has no comments controller
// running for it.
//
// Not on the session row: sharing lives in the project's capture store and the
// comments on the server, so putting either on `threads_projects` would open a
// capture store per project, and call the server per row, on every list read.
// The hover card asks for one session while it is open instead, through the
// same two commands the open session's comments controller uses.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { comments, visibleCount, type CommentThreads } from "@/features/artifacts/lib/comments-api";

interface CommentTargetWire {
  remoteProjectId: string;
  sessionId: string;
}

/** Visible comments across the session and every entry in it. */
export function commentTotal(threads: CommentThreads): number {
  let total = visibleCount(threads.session);
  for (const bucket of Object.values(threads.byAnchor)) total += visibleCount(bucket);
  return total;
}

/** `null` when the session is not shared (or the answer is not in yet);
 *  otherwise its comment count. */
async function readSharing(
  projectPath: string,
  nativeSessionId: string,
): Promise<{ comments: number } | null> {
  const target = await invoke<CommentTargetWire | null>("chat_comment_target", {
    projectPath,
    nativeSessionId,
  }).catch(() => null);
  if (!target) return null;
  const threads = await comments
    .list(target.remoteProjectId, target.sessionId)
    .catch((): CommentThreads | null => null);
  return { comments: threads ? commentTotal(threads) : 0 };
}

/** Sharing for a session the window does not have open. `enabled` is false
 *  for an open one, whose comments controller already knows. */
export function useClosedSessionSharing(
  projectPath: string,
  nativeSessionId: string,
  enabled: boolean,
): { comments: number } | null {
  const { data } = useQuery({
    queryKey: ["session-sharing", projectPath, nativeSessionId],
    queryFn: () => readSharing(projectPath, nativeSessionId),
    enabled: enabled && projectPath !== "" && nativeSessionId !== "",
    staleTime: 60_000,
    retry: false,
  });
  return data ?? null;
}
