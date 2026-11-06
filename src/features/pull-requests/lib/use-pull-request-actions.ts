// Running one of a pull request's state changes (merge, ready, close, …)
// from the header, its menu or the composer: one at a time, a toast either
// way, and the reads refreshed after. A refusal toasts what the host most
// likely wanted, since "action failed" would leave the reader pressing the
// same button again.

import { useRef, useState } from "react";
import { toast } from "sonner";

import { classifyPrError, prErrorMessage } from "./pr-errors";
import { openPullRequestTab } from "./open-pull-request-tab";
import { ACTION_FAILURE_LABELS } from "./pull-request-logic";
import { removeAgentCreditsOnMerge } from "./pull-request-prefs";
import {
  usePrActionMutation,
  usePrCommentMutation,
  usePrRevertMutation,
} from "./pull-requests-queries";
import type { PrAction, PrError, PrMergeMethod, PrUpdateMethod } from "./pull-requests-types";

const ACTION_SUCCESS_LABELS: Record<PrAction, string> = {
  merge: "Pull request merged",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
  "update-branch": "Branch updated with its base",
  "enable-auto-merge": "Auto-merge turned on",
  "disable-auto-merge": "Auto-merge turned off",
  "delete-branch": "Branch deleted",
  revert: "Revert opened",
  "approve-workflows": "Workflows approved",
};

const ACTION_FAILURE_HINTS: Record<PrAction, string> = {
  merge:
    "GitHub refused the merge. Check that you have write access, that the required checks have passed, and that the branch does not conflict.",
  ready: "GitHub refused it. Check that you have write access to this repository.",
  draft: "GitHub refused it. Check that you have write access to this repository.",
  close: "GitHub refused it. Check that you have write access, or that you opened it.",
  reopen: "GitHub refused it. Check that you have write access, and that the branch still exists.",
  "update-branch":
    "GitHub refused it. A branch from a fork also needs its author to allow edits from maintainers, and it must not conflict with the base.",
  "enable-auto-merge":
    "GitHub refused it. Check that this repository allows auto-merge and that something is left for it to wait on.",
  "disable-auto-merge":
    "GitHub refused it. Check that you have write access, and that the merge has not already happened.",
  "delete-branch":
    "GitHub refused it. Check that you have write access to the branch's repository, and that the branch has not moved.",
  revert:
    "GitHub refused it. Check that you have write access, that the pull request is merged, and that its changes still revert cleanly.",
  "approve-workflows":
    "GitHub refused it. Check that you have write access, and that the runs are still waiting for approval.",
};

const REBASE_FAILURE_HINT =
  "GitHub refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";

/** The host's own words when they say more than a generic refusal would. */
export function readableFailure(error: PrError, hint: string): string {
  if (error.kind === "failed" || error.kind === "invalid" || error.kind === "unsupported") {
    return error.message ? `${error.message}\n\n${hint}` : hint;
  }
  return prErrorMessage(error);
}

export type PerformPullRequestAction = (
  action: PrAction,
  method?: PrMergeMethod,
  updateMethod?: PrUpdateMethod,
) => Promise<boolean>;

/** `headSha`: the head commit the tab shows. A merge sends it, so GitHub
 *  refuses one whose head moved on since the reader looked. */
export function usePullRequestActions(
  repoPath: string,
  number: number,
  headSha: string | null = null,
) {
  const mutation = usePrActionMutation(repoPath, number);
  const comment = usePrCommentMutation(repoPath, number);
  const revertMutation = usePrRevertMutation(repoPath, number);
  const [pendingAction, setPendingAction] = useState<PrAction | null>(null);
  const busy = useRef(false);

  const run = async (
    action: PrAction,
    method?: PrMergeMethod,
    updateMethod?: PrUpdateMethod,
  ): Promise<boolean> => {
    try {
      await mutation.mutateAsync({
        action,
        mergeMethod: method ?? null,
        updateMethod: updateMethod ?? null,
        expectedHeadOid: action === "merge" || action === "enable-auto-merge" ? headSha : null,
        // The project's `removeAgentCreditsOnMerge` setting, read as the merge is sent.
        removeAgentCredits:
          (action === "merge" || action === "enable-auto-merge") &&
          removeAgentCreditsOnMerge(repoPath),
      });
      toast.success(ACTION_SUCCESS_LABELS[action]);
      return true;
    } catch (raw) {
      const error = classifyPrError(raw);
      toast.error(ACTION_FAILURE_LABELS[action], {
        description: readableFailure(
          error,
          updateMethod === "rebase" ? REBASE_FAILURE_HINT : ACTION_FAILURE_HINTS[action],
        ),
      });
      return false;
    }
  };

  const perform: PerformPullRequestAction = async (action, method, updateMethod) => {
    if (busy.current) return false;
    busy.current = true;
    setPendingAction(action);
    try {
      return await run(action, method, updateMethod);
    } finally {
      busy.current = false;
      setPendingAction(null);
    }
  };

  /** Post a comment, then close or reopen. The comment stands even when the
   *  state change is refused. */
  const commentThen = async (
    body: string,
    action: "close" | "reopen",
  ): Promise<{ commentPosted: boolean }> => {
    if (busy.current) return { commentPosted: false };
    busy.current = true;
    setPendingAction(action);
    try {
      try {
        await comment.mutateAsync(body);
      } catch (raw) {
        toast.error("Could not post the comment", {
          description: prErrorMessage(classifyPrError(raw)),
        });
        return { commentPosted: false };
      }
      await run(action);
      return { commentPosted: true };
    } finally {
      busy.current = false;
      setPendingAction(null);
    }
  };

  /** Revert a merged pull request, then offer the new one's tab. */
  const revert = async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setPendingAction("revert");
    try {
      const opened = await revertMutation.mutateAsync();
      toast.success(`Revert opened as #${opened.number}`, {
        action: {
          label: "Open",
          onClick: () => openPullRequestTab({ repoPath, number: opened.number }),
        },
      });
      return true;
    } catch (raw) {
      toast.error(ACTION_FAILURE_LABELS.revert, {
        description: readableFailure(classifyPrError(raw), ACTION_FAILURE_HINTS.revert),
      });
      return false;
    } finally {
      busy.current = false;
      setPendingAction(null);
    }
  };

  return { pendingAction, perform, commentThen, revert };
}
