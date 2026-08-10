import { toast } from "sonner";
import { useGitStore } from "../stores/git-store";

/** Mirror of `atlas_git::GitErrorCode` (kebab-case serde). */
export type GitErrorCode =
  | "auth-failed"
  | "remote-not-found"
  | "network-error"
  | "non-fast-forward"
  | "force-push-rejected"
  | "protected-branch"
  | "push-rejected"
  | "merge-conflicts"
  | "rebase-conflicts"
  | "unrelated-histories"
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

/**
 * Route a failed git invoke to the right surface: a dialog for actionable
 * failures (auth, rejected pushes, hooks, locks — raw output attached), a
 * toast otherwise. Accepts anything a `catch` can produce; legacy string
 * errors fall back to a plain error toast.
 */
export function handleGitError(e: unknown): void {
  if (!isGitError(e)) {
    toast.error(String(e));
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
  });
}
