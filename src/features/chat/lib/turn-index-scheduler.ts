/**
 * After an agent turn ends, App refreshes the project's codebase index
 * (incremental + structural: cheap, no LLM) so `memory_search` and the Memory
 * tab see what the turn changed. Every agent kind edits files, so nothing here
 * looks at which agent ran the turn. The trigger used to fire for the native
 * agent only, which left Claude Code and Codex edits unindexed.
 */
import type { ChatSession } from "@/types/agent";

/** The project a session's turn ran in, whichever agent ran it. */
export function sessionProjectPath(
  sessions: Record<string, Pick<ChatSession, "acpSessionId" | "workingDirectory">>,
  acpSessionId: string,
): string | undefined {
  return Object.values(sessions).find((s) => s.acpSessionId === acpSessionId)?.workingDirectory;
}

export interface TurnIndexScheduler {
  /** Queue a rebuild for `projectPath`; a no-op for a turn with no project. */
  schedule: (projectPath: string | undefined) => void;
  /** Drop every pending rebuild (App's effect cleanup). */
  cancelAll: () => void;
}

/**
 * Per-project debounce: a burst of turns in one project runs `run` once,
 * `delayMs` after the last of them. Projects never delay each other.
 */
export function createTurnIndexScheduler(
  run: (projectPath: string) => void,
  delayMs = 4000,
): TurnIndexScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(projectPath) {
      if (!projectPath) return;
      const existing = timers.get(projectPath);
      if (existing) clearTimeout(existing);
      timers.set(
        projectPath,
        setTimeout(() => {
          timers.delete(projectPath);
          run(projectPath);
        }, delayMs),
      );
    },
    cancelAll() {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    },
  };
}
