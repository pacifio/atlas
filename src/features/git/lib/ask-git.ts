// Source control's side of "ask the agent" (`@/features/ask-agent`): what a
// changed file, a hunk, a commit, a conflict or a failure is as an
// `AgentContext`, and the asks the panel offers for each.
//
// Nothing here runs git. Every ask opens the box or drafts into a session;
// whatever the agent then does, it does in its own session, where the user
// sees it. Pure, so the shapes are table tests (`ask-git.test.ts`).

import type {
  AgentContext,
  CommitContext,
  DiffHunkContext,
  ErrorContext,
} from "@/features/ask-agent/lib/agent-context";

import type { DiffHunk } from "./diff";

/** The quick prompts on a changed file and on a hunk. */
export const CHANGE_ASKS = [
  "Explain this change",
  "Undo just this part",
  "Split into separate commits",
] as const;

/** The asks on a commit in History. Short: they are the buttons' labels in
 *  the ask box, and the commit chip says which commit. */
export const COMMIT_ASKS = {
  explain: "Explain this commit",
  revert: "Revert this commit",
} as const;

/** A hunk as git prints it: the `@@` header, then each line with its marker. */
export function hunkText(hunk: DiffHunk): string {
  const body = hunk.lines.map(
    (l) => `${l.type === "add" ? "+" : l.type === "remove" ? "-" : " "}${l.content}`,
  );
  return [hunk.header, ...body].join("\n");
}

export function hunkContext(path: string, hunk: DiffHunk, staged: boolean): DiffHunkContext {
  return { kind: "diff_hunk", path, hunk: hunkText(hunk), staged };
}

/** A whole file's diff as one chip. `diff` is `git diff` output for the file;
 *  the per-file header lines go, the hunks stay. Null when there is nothing
 *  to show (a binary file, or the change was undone meanwhile). */
export function fileDiffContext(
  path: string,
  diff: string,
  staged: boolean,
): DiffHunkContext | null {
  const start = diff.search(/^@@ /m);
  if (start < 0) return null;
  return { kind: "diff_hunk", path, hunk: diff.slice(start).replace(/\n+$/, ""), staged };
}

export function commitContext(sha: string, subject: string): CommitContext {
  return { kind: "commit", sha, subject };
}

/** A streamed op's printed lines, oldest first, as one log. */
export function opOutputText(lines: readonly { text: string }[]): string {
  return lines.map((l) => l.text).join("\n");
}

/** A failed "Commit, push & PR" step: the step, the command it ran, and
 *  everything it printed. */
export function shipErrorContext(
  failure: { step: string; message: string; command?: string; output?: string },
  repoPath: string,
): ErrorContext {
  return {
    kind: "error",
    source: `Commit, push & PR: ${failure.step}`,
    message: failure.message,
    ...(failure.output?.trim() ? { log: failure.output } : {}),
    ...(failure.command ? { command: failure.command } : {}),
    cwd: repoPath,
  };
}

export type InProgressOp = "merge" | "rebase" | "cherry-pick" | "revert";

/** The prompt for "Resolve with agent": finish the stopped op's conflicts,
 *  never continue or abort it, so the user keeps that call. */
export function resolveConflictsPrompt(op: InProgressOp, summary: string): string {
  return [
    `Resolve the ${op} conflicts in these files${summary ? ` (${summary})` : ""}.`,
    "Keep the intent of both sides; where they truly disagree, ask me.",
    `Remove every conflict marker and stage each resolved file, but do not run \`git ${op} --continue\` or abort: I'll do that.`,
  ].join(" ");
}

/** The conflicted files as one chip the agent can read. */
export function conflictsContext(
  files: readonly { path: string; markerCount: number }[],
  op: InProgressOp,
): AgentContext {
  const lines = files.map(
    (f) =>
      `${f.path} (${f.markerCount > 0 ? `${f.markerCount} conflict marker${f.markerCount === 1 ? "" : "s"}` : "no markers left"})`,
  );
  return { kind: "quote", text: lines.join("\n"), source: `Conflicted files in the ${op}` };
}

/** "Write with agent": the staged files, for a message written from
 *  `git diff --cached`. The agent reads the diff itself, all of it, rather
 *  than a capped excerpt. */
export function stagedFilesContext(paths: readonly string[]): AgentContext {
  return { kind: "quote", text: paths.join("\n"), source: "Staged files" };
}

export const WRITE_COMMIT_PROMPT = [
  "Write a commit message for the staged changes (`git diff --cached`).",
  "A summary line under 72 characters in the imperative mood, a blank line, then a short body saying why, only if it needs one.",
  "Reply with the message only. Do not commit, stage or change anything: I'll paste it into the commit box and commit it myself.",
].join(" ");
