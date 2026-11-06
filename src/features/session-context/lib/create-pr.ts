// "Create PR": once the Commit row has the branch on the remote
// (`run-git-action.ts`), the dialog shows the title and body it would open
// with, then opens it with `gh pr create` (`pr_create`).
//
// Atlas does not write the title and body with a model, so the dialog shows
// what `gh pr create --fill` would write — one commit's own message, or the
// branch name and the commit list — and the user keeps or edits it before
// anything is opened.

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { openPullRequestTab } from "@/features/pull-requests/lib/open-pull-request-tab";
import { prCreate } from "@/features/pull-requests/lib/pull-requests-api";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";
import type { PrCreated, PrCreateInput } from "@/features/pull-requests/lib/pull-requests-types";

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
