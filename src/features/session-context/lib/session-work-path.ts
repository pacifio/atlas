// Where the session described by the overlay actually works.
//
// A session usually runs in its project's checkout, but not always: a pull
// request session runs in a worktree under app data (`pr_prepare_checkout`,
// bound with `setBindCwd`). The overlay's project rows still belong to the
// project; what acts on files — opening in an editor or terminal, running a
// project script, the git verbs — must act where the session works, or a
// "Push" in a worktree session would push the project's own branch.

import { useChatStore } from "@/features/chat/stores/chat-store";
import { isUnderRoot } from "@/lib/file-links";

interface SessionCwd {
  bindCwd?: string;
  workingDirectory?: string;
}

/**
 * The directory the session works in: its bound working directory when that
 * is a separate checkout (outside the project), else the project. A working
 * directory inside the project (a subfolder) is the same repository, so the
 * project answers for it.
 */
export function sessionWorkPath(
  session: SessionCwd | undefined,
  projectPath: string | null,
): string | null {
  const cwd = session?.bindCwd || session?.workingDirectory || null;
  if (!cwd) return projectPath;
  if (!projectPath) return cwd;
  return isUnderRoot(cwd, projectPath) ? projectPath : cwd;
}

/** `sessionWorkPath` for a tab's session. A string selector: re-renders only
 *  when the answer changes. */
export function useSessionWorkPath(tabId: string | null, projectPath: string | null) {
  return useChatStore((s) => sessionWorkPath(tabId ? s.sessions[tabId] : undefined, projectPath));
}
