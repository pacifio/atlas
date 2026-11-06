// Branch, pull requests, the git action and what changed: the Version
// control group, read from the session's own checkout by path
// (`useSessionGit`). A pull request session's worktree and a background
// project's checkout are just paths here, so there is no special case.
//
//   Branch      the branch, and a picker to switch or create one
//   PRs         the session's pull requests, the open one with its action
//   Commit      the action the checkout calls for, split with its menu
//   Changes     lines added and removed since the branch left the default
//               branch, opening the session's changes beside it

import { FileDiff } from "lucide-react";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

import { useSessionPullRequests } from "../lib/session-pull-requests";
import { useSessionGit } from "../lib/use-session-git";
import { useGitActionStore } from "../stores/git-action-store";
import { BranchRow } from "./branch-row";
import { CommitRow } from "./commit-row";
import { DetailsRow, DetailsSection, DiffStat, RowIcon, RowLabel } from "./details-rows";
import { PullRequestRows } from "./pull-request-rows";

export function VersionControlSection({
  tabId,
  projectPath,
  workPath,
  compact,
}: {
  tabId: string;
  projectPath: string;
  /** Where the session works: the checkout every row reads and acts on. */
  workPath: string;
  compact: boolean;
}) {
  const git = useSessionGit(workPath).data;
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const branch = git?.snapshot.isRepo && !git.snapshot.detached ? git.snapshot.branch : null;
  const prs = useSessionPullRequests(workPath, branch || null, sessionId);
  // A run started before the card opened still shows.
  const running = useGitActionStore((s) => !!s.runs[workPath]);

  if (!git?.snapshot.isRepo) return null;
  return (
    <DetailsSection label="Version control">
      <BranchRow path={workPath} git={git} />
      <PullRequestRows path={workPath} prs={prs} />
      <CommitRow
        path={workPath}
        git={git}
        // Until the pull requests answer, nothing offers one: a "Create PR"
        // that turns into "Push" a moment later moved under the pointer.
        hasOpenPr={prs.loading || prs.hasOpen}
        sessionId={sessionId}
        compact={compact && !running}
      />
      <ChangesRow tabId={tabId} projectPath={projectPath} sessionId={sessionId} git={git} />
    </DetailsSection>
  );
}

function ChangesRow({
  tabId,
  projectPath,
  sessionId,
  git,
}: {
  tabId: string;
  projectPath: string;
  sessionId: string | null;
  git: NonNullable<ReturnType<typeof useSessionGit>["data"]>;
}) {
  const open = () => {
    if (!sessionId) return;
    openSessionChanges({
      projectPath,
      sessionId,
      file: "",
      title: useLayoutStore.getState().tabs.find((t) => t.id === tabId)?.title,
    });
  };
  const base = git.compare?.defaultBranch;
  return (
    <DetailsRow
      onClick={open}
      disabled={!sessionId}
      title={
        sessionId
          ? base && !git.compare?.isDefault
            ? `Since the branch left ${base}, uncommitted changes included`
            : "Uncommitted changes"
          : "The session's changes open once it has started."
      }
    >
      <RowIcon icon={FileDiff} />
      <RowLabel>Changes</RowLabel>
      {git.compare && (
        <DiffStat additions={git.compare.additions} deletions={git.compare.deletions} />
      )}
    </DetailsRow>
  );
}
