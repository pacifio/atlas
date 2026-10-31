// The Commit row's actions, as one run of steps on the session's checkout:
//
//   [new branch] → [stage + commit] → [push, or publish a new branch] → [Create PR]
//
// Each step is an existing git command run by path; the ones that stream
// (`git_commit_v2`, `git_push`, `git_publish_branch`) do it under an op id the
// action store follows, so the row shows the phase and the latest output line
// as it runs. A step that fails stops the run with a toast that stays until
// it is dismissed.
//
// The pull request step ends in the Create PR dialog, prefilled the way
// `gh pr create --fill` would write it: Atlas does not write a title and body
// with a model, so the user keeps or edits them before anything is opened.

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { gitErrorText } from "@/features/notifications/lib/outcome-notifier";
import { classifyPrError, prErrorMessage } from "@/features/pull-requests/lib/pr-errors";
import { prCreateDraft } from "@/features/pull-requests/lib/pull-requests-api";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";

import { useGitActionStore } from "../stores/git-action-store";
import { useSessionDetailsStore } from "../stores/session-details-store";
import {
  actionSteps,
  featureBranchName,
  requiresDefaultBranchConfirmation,
  type GitAction,
} from "./git-quick-action";
import {
  gitCommit,
  gitCreateBranch,
  gitPublishBranch,
  gitPull,
  gitPush,
  gitSnapshot,
  gitStage,
  gitUnstage,
  newOpId,
} from "./session-git-api";
import { refreshSessionGit } from "./use-session-git";

export interface GitActionRequest {
  path: string;
  action: GitAction;
  /** The session it runs for; a pull request it opens is linked to it. */
  sessionId: string | null;
  /** Move the work onto a new branch first. */
  featureBranch?: boolean;
  /** The commit message, required when the action commits. */
  summary?: string;
  description?: string | null;
  /** Commit only these paths; every change when absent. */
  files?: string[];
}

const SUCCESS_TITLE: Record<GitAction, string> = {
  commit: "Committed",
  commit_push: "Committed and pushed",
  push: "Pushed",
  commit_push_pr: "Committed and pushed",
  create_pr: "Pushed",
};

/**
 * Start `action` from the Commit row: ask first when it would push from the
 * default branch, then ask for a commit message when it commits, then run.
 */
export function requestGitAction(
  client: QueryClient,
  request: { path: string; action: GitAction; sessionId: string | null; isDefault: boolean },
): void {
  const { path, action, sessionId } = request;
  if (requiresDefaultBranchConfirmation(action, request.isDefault)) {
    useSessionDetailsStore.getState().actions.promptGitAction({
      kind: "default-branch",
      path,
      action,
      sessionId,
      featureBranch: false,
    });
    return;
  }
  continueGitAction(client, { path, action, sessionId, featureBranch: false });
}

/** Past the default-branch question: the commit message, or straight on. */
export function continueGitAction(
  client: QueryClient,
  request: { path: string; action: GitAction; sessionId: string | null; featureBranch: boolean },
): void {
  if (actionSteps(request.action).commit) {
    useSessionDetailsStore.getState().actions.promptGitAction({ kind: "commit", ...request });
    return;
  }
  void runGitAction(client, request);
}

/** Hands-off guard: one run per checkout at a time. */
const running = new Set<string>();

export async function runGitAction(client: QueryClient, request: GitActionRequest): Promise<void> {
  const { path, action } = request;
  if (running.has(path)) return;
  running.add(path);
  const store = useGitActionStore.getState().actions;
  const steps = actionSteps(action);
  store.start(path, "Starting…");
  let failed = false;
  try {
    const snapshot = await gitSnapshot(path);
    let branch = snapshot.branch;
    let hasUpstream = !!snapshot.upstream;

    if (request.featureBranch) {
      branch = featureBranchName(
        request.summary ?? "",
        snapshot.branches.map((b) => b.name),
      );
      store.phase(path, `Creating ${branch}…`);
      await gitCreateBranch(path, branch);
      hasUpstream = false;
    }

    if (steps.commit) {
      const summary = request.summary?.trim();
      if (!summary) throw new Error("A commit needs a message.");
      const all = [...new Set(snapshot.files.map((f) => f.path))];
      const chosen = request.files ? new Set(request.files) : null;
      // Only what was chosen goes in: anything already staged that was not
      // chosen comes back out of the index first.
      if (chosen) {
        const stray = snapshot.files
          .filter((f) => f.staged && !chosen.has(f.path))
          .map((f) => f.path);
        if (stray.length > 0) await gitUnstage(path, stray);
      }
      const toStage = chosen ? all.filter((p) => chosen.has(p)) : all;
      if (toStage.length === 0) throw new Error("There is nothing to commit.");
      store.phase(path, "Committing…");
      await gitStage(path, toStage);
      const opId = newOpId();
      store.phase(path, "Committing…", opId);
      await gitCommit(path, summary, request.description?.trim() || null, opId);
    }

    if (steps.push) {
      const opId = newOpId();
      store.phase(path, hasUpstream ? "Pushing…" : "Publishing branch…", opId);
      await (hasUpstream ? gitPush(path, opId) : gitPublishBranch(path, opId));
    }

    if (steps.pr) {
      store.phase(path, "Preparing pull request…");
      const prefill = await prCreateDraft(path);
      await invalidatePullRequestQueries(client, path);
      useSessionDetailsStore.getState().actions.requestCreatePr({
        projectPath: path,
        draft: false,
        prefill,
        sessionId: request.sessionId,
      });
    }

    store.finish(path, {
      title: SUCCESS_TITLE[action],
      description: steps.pr ? "Review the pull request to open it." : branch || null,
    });
  } catch (error) {
    failed = true;
    store.finish(path, null);
    toast.error("Git action failed", {
      description: describe(error),
      duration: Number.POSITIVE_INFINITY,
    });
  } finally {
    running.delete(path);
    await refreshSessionGit(client, path);
    if (!failed && steps.push) await invalidatePullRequestQueries(client, path);
  }
}

/** Pull the branch's upstream into it. */
export async function runPull(client: QueryClient, path: string): Promise<void> {
  if (running.has(path)) return;
  running.add(path);
  const store = useGitActionStore.getState().actions;
  store.start(path, "Pulling…");
  try {
    const opId = newOpId();
    store.phase(path, "Pulling…", opId);
    await gitPull(path, opId);
    store.finish(path, { title: "Pulled", description: null });
  } catch (error) {
    store.finish(path, null);
    toast.error("Pull failed", {
      description: describe(error),
      duration: Number.POSITIVE_INFINITY,
    });
  } finally {
    running.delete(path);
    await refreshSessionGit(client, path);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  // A pull request read fails with a classified error; git with its payload.
  if (typeof error === "object" && error !== null && "kind" in error) {
    return prErrorMessage(classifyPrError(error));
  }
  return gitErrorText(error);
}
