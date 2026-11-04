import { toast } from "sonner";
import { fixWithAgentAction } from "@/features/ask-agent/lib/ask-agent";
import type { ErrorContext } from "@/features/ask-agent/lib/agent-context";
import { useGitStore } from "../stores/git-store";

/** Mirror of `atlas_git::GitErrorCode` (kebab-case serde). */
export type GitErrorCode =
  | "auth-failed"
  | "remote-not-found"
  | "network-error"
  | "non-fast-forward"
  | "history-rewritten"
  | "force-push-rejected"
  | "protected-branch"
  | "push-rejected"
  | "merge-conflicts"
  | "rebase-conflicts"
  | "unrelated-histories"
  | "divergent-branches"
  | "local-changes-overwritten"
  | "uncommitted-changes"
  | "nothing-to-commit"
  | "no-upstream"
  | "branch-already-exists"
  | "tag-already-exists"
  | "unknown-ref"
  | "not-a-repository"
  | "lock-file-exists"
  | "hook-failed"
  | "gpg-failed-to-sign"
  | "no-op-in-progress"
  | "generic";

/** Mirror of `atlas_git::GitErrorPayload` (camelCase serde). */
export interface GitErrorPayload {
  code: GitErrorCode;
  message: string;
  rawStderr: string;
  command: string;
  exitCode?: number | null;
  files?: string[];
  hint?: string | null;
}

export function isGitError(e: unknown): e is GitErrorPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as GitErrorPayload).code === "string" &&
    typeof (e as GitErrorPayload).message === "string"
  );
}

/** Codes whose stakes/next-steps warrant the error dialog (with the raw git
 *  output available) rather than a transient toast. */
const DIALOG_CODES: ReadonlySet<GitErrorCode> = new Set([
  "auth-failed",
  "non-fast-forward",
  "history-rewritten",
  "force-push-rejected",
  "protected-branch",
  "push-rejected",
  "hook-failed",
  "lock-file-exists",
  "local-changes-overwritten",
  "gpg-failed-to-sign",
]);

/** Codes that are ordinary outcomes, not failures — quiet info toast. */
const INFO_CODES: ReadonlySet<GitErrorCode> = new Set(["nothing-to-commit", "no-op-in-progress"]);

const TITLES: Partial<Record<GitErrorCode, string>> = {
  "auth-failed": "Authentication failed",
  "non-fast-forward": "Push rejected — pull first",
  "history-rewritten": "Push rejected — history was rewritten",
  "force-push-rejected": "Force push rejected",
  "protected-branch": "Branch is protected",
  "push-rejected": "Push rejected",
  "hook-failed": "A git hook rejected this",
  "lock-file-exists": "Repository is locked",
  "local-changes-overwritten": "Local changes in the way",
  "gpg-failed-to-sign": "Commit signing failed",
};

export function gitErrorTitle(payload: GitErrorPayload): string {
  return TITLES[payload.code] ?? "Git error";
}

/** A typed git failure as the agent gets it: where ("git push"), what the
 *  panel says, git's own output, the command and the repository. `output`
 *  replaces git's stderr when there is more of it (a hook's full output). */
export function gitErrorContext(
  payload: GitErrorPayload,
  repoPath: string | null,
  output?: string,
): ErrorContext {
  const verb = payload.command.split(/\s+/).slice(0, 2).join(" ");
  const log = output?.trim() ? output : payload.rawStderr;
  return {
    kind: "error",
    source: verb.startsWith("git") ? verb : "git",
    message: [gitErrorTitle(payload), payload.message, ...(payload.files ?? [])].join("\n"),
    ...(log ? { log } : {}),
    ...(payload.command ? { command: payload.command } : {}),
    ...(repoPath ? { cwd: repoPath } : {}),
  };
}

/** Anything a git `catch` produced, as an error context: a typed git
 *  failure in full, else `message` (the words the toast shows) or the
 *  rejection's own. */
export function anyGitErrorContext(
  error: unknown,
  repoPath: string | null,
  source = "git",
  message?: string,
): ErrorContext {
  if (isGitError(error)) return gitErrorContext(error, repoPath);
  const own =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
  return { kind: "error", source, message: message ?? own, ...(repoPath ? { cwd: repoPath } : {}) };
}

/**
 * Route a failed git invoke to the right surface: a dialog for actionable
 * failures (auth, rejected pushes, hooks, locks — raw output attached), a
 * toast otherwise. Accepts anything a `catch` can produce; legacy string
 * errors fall back to a plain error toast.
 */
export function handleGitError(e: unknown): void {
  // Every failure toast carries "Fix with agent"; the dialog has its own.
  const repoPath = useGitStore.getState().repoPath;
  if (!isGitError(e)) {
    toast.error(String(e), { action: fixWithAgentAction(anyGitErrorContext(e, repoPath)) });
    return;
  }
  // Not a dead end: the fix is a choice between two pulls, so ask for it.
  if (e.code === "divergent-branches") {
    useGitStore.getState().actions.showPullChoice({ kind: "failed", error: e });
    return;
  }
  if (INFO_CODES.has(e.code)) {
    toast.info(e.message);
    return;
  }
  if (DIALOG_CODES.has(e.code)) {
    useGitStore.getState().actions.showErrorDialog(e);
    return;
  }
  const detail = e.rawStderr.trim();
  toast.error(e.message, {
    description: detail ? (detail.length > 400 ? `${detail.slice(0, 400)}…` : detail) : undefined,
    action: fixWithAgentAction(gitErrorContext(e, repoPath)),
  });
}
