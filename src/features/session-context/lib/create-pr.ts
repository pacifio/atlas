// "Create PR": get the branch onto the remote if it is not there yet (publish
// a new branch, push one that is ahead), then show the title and body it
// would open with, then open it with `gh pr create` (`pr_create`).
//
// Atlas does not write the title and body with a model, so the dialog shows
// what `gh pr create --fill` would write — one commit's own message, or the
// branch name and the commit list — and the user keeps or edits it before
// anything is opened.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { openPullRequestTab } from "@/features/pull-requests/lib/open-pull-request-tab";
import { useGitStore } from "@/features/git/stores/git-store";
import { prErrorMessage, classifyPrError } from "@/features/pull-requests/lib/pr-errors";
import { prCreate, prCreateDraft } from "@/features/pull-requests/lib/pull-requests-api";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";
import type { PrCreated, PrCreateInput } from "@/features/pull-requests/lib/pull-requests-types";

import { useSessionDetailsStore } from "../stores/session-details-store";
import { publishBranch, pushBranch } from "./git-actions";

/** The prefill for the current branch; its `baseBranch` is also how the
 *  overlay knows the default branch, which is never offered a PR. */
export function useCreatePrDraft(projectPath: string | null, branch: string | null) {
  return useQuery({
    queryKey: ["session-context", "pr-draft", projectPath ?? "", branch ?? ""],
    queryFn: () => prCreateDraft(projectPath!),
    enabled: !!projectPath && !!branch,
    staleTime: 60_000,
  });
}

/** Push what needs pushing, then open the Create PR dialog. `sessionId` is
 *  the session it is opened from; the pull request is linked to it. */
export async function startCreatePr(
  projectPath: string,
  draft: boolean,
  sessionId: string | null,
): Promise<void> {
  const { branchesFull, ahead } = useGitStore.getState();
  const current = branchesFull.find((b) => b.isCurrent && !b.isRemote);
  if (!current) {
    toast.error("Check out a branch before opening a pull request.");
    return;
  }
  if (!current.upstream) {
    if (!(await publishBranch())) return;
  } else if (ahead > 0) {
    if (!(await pushBranch())) return;
  }
  try {
    const prefill = await prCreateDraft(projectPath);
    if (!prefill.headBranch) {
      toast.error("A pull request cannot be opened from a detached HEAD.");
      return;
    }
    useSessionDetailsStore.getState().actions.requestCreatePr({
      projectPath,
      draft,
      prefill,
      sessionId,
    });
  } catch (raw) {
    toast.error("Could not prepare the pull request", {
      description: prErrorMessage(classifyPrError(raw)),
    });
  }
}

/** Open the pull request the dialog confirmed, link it to `sessionId`, show
 *  it in its own tab, and say where it is on the host. */
export async function submitCreatePr(
  client: QueryClient,
  projectPath: string,
  input: PrCreateInput,
  sessionId: string | null,
): Promise<PrCreated> {
  const created = await prCreate(projectPath, input, sessionId);
  await invalidatePullRequestQueries(client, projectPath);
  openPullRequestTab({ repoPath: projectPath, number: created.number, title: input.title });
  toast.success(`Opened ${input.draft ? "draft " : ""}pull request #${created.number}`, {
    action: { label: "Open on GitHub", onClick: () => openPullRequest(created.url) },
  });
  return created;
}
