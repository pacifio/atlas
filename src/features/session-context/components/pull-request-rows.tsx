// The session's pull requests, under the branch row.
//
// The one that matters now (an open one, else the latest) is a two-line row:
// its state glyph and title, then `#N`, its checks, a watch eye when the
// session watches it, and at the end the one action it is waiting on:
//
//   Resolve   it conflicts with its base (opens its tab, where an agent can
//             take the conflicts)
//   Ready     a draft, which the viewer may mark ready
//   Merge     open and mergeable; a second click confirms, with the method
//             the project prefers (the pull request tab's own rules)
//
// Nothing while its checks run or fail. The rest fold under "Show N more" as
// one-line rows. A click opens a pull request in its own tab; right-click
// offers what the session's pull request panel does (open, open on GitHub,
// copy the link, watch, unlink), or "Link to this session" for one found on
// the branch but not linked yet.

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link,
  Link2,
  Plus,
  type LucideIcon,
} from "lucide-react";

import { SessionPullRequestMenuItems } from "@/features/pull-requests/components/session-pull-request-menu";
import { openPullRequestTab } from "@/features/pull-requests/lib/open-pull-request-tab";
import { classifyPrError, prErrorMessage } from "@/features/pull-requests/lib/pr-errors";
import {
  allowedMergeMethods,
  canPerform,
  MERGE_METHOD_LABELS,
  resolveMergeMethod,
} from "@/features/pull-requests/lib/pull-request-logic";
import { projectMergeMethod } from "@/features/pull-requests/lib/pull-request-prefs";
import { usePrDetail } from "@/features/pull-requests/lib/pull-requests-queries";
import type { PrChecksState, PrDetail } from "@/features/pull-requests/lib/pull-requests-types";
import { sessionCheckouts } from "@/features/pull-requests/lib/session-checkouts";
import {
  copySessionLink,
  openLinkOnHost,
  openSessionLink,
} from "@/features/pull-requests/lib/session-pull-request-actions";
import { LINK_SOURCE_LABEL } from "@/features/pull-requests/lib/session-pull-request-links";
import { linkSessionPullRequest } from "@/features/pull-requests/lib/session-pull-requests-api";
import { useInlineConfirm } from "@/features/pull-requests/lib/use-inline-confirm";
import { usePullRequestActions } from "@/features/pull-requests/lib/use-pull-request-actions";
import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";

import type { SessionPullRequest, SessionPullRequests } from "../lib/session-pull-requests";
import { DetailsRow, RowIcon, RowLabel, RowMeta } from "./details-rows";

export type PullRequestRowAction = "resolve" | "ready" | "merge";

/** The one action an open pull request waits on, or `null`. Pure, for the test. */
export function resolvePullRequestRowAction(
  detail: Pick<
    PrDetail,
    | "state"
    | "isDraft"
    | "mergeability"
    | "checksState"
    | "capabilities"
    | "viewerPermissions"
    | "mergeCapabilities"
  >,
): PullRequestRowAction | null {
  if (detail.state !== "open") return null;
  if (detail.mergeability === "conflicting") return "resolve";
  if (detail.isDraft) return canPerform(detail, "ready") ? "ready" : null;
  if (detail.checksState === "pending" || detail.checksState === "failing") return null;
  return canPerform(detail, "merge") && allowedMergeMethods(detail).length > 0 ? "merge" : null;
}

function prIcon(pr: Pick<SessionPullRequest, "state" | "isDraft">): {
  icon: LucideIcon;
  className?: string;
} {
  if (pr.state === "merged") return { icon: GitMerge, className: "text-primary" };
  if (pr.state === "closed") return { icon: GitPullRequestClosed };
  if (pr.isDraft) return { icon: GitPullRequestDraft };
  return { icon: GitPullRequest, className: "text-success" };
}

const CHECKS: Record<PrChecksState, { icon: LucideIcon; className: string; label: string }> = {
  passing: { icon: CircleCheck, className: "text-success", label: "Checks passing" },
  failing: { icon: CircleX, className: "text-error", label: "Checks failing" },
  pending: { icon: CircleDashed, className: "text-warning", label: "Checks running" },
};

export function PullRequestRows({ path, prs }: { path: string; prs: SessionPullRequests }) {
  const [expanded, setExpanded] = useState(false);
  if (!prs.current) return null;
  return (
    <div data-details-pr-list>
      <PullRequestMenu path={path} pr={prs.current} prs={prs}>
        {prs.current.state === "open" ? (
          <CurrentPullRequestRow path={path} pr={prs.current} prs={prs} />
        ) : (
          <PullRequestRow path={path} pr={prs.current} />
        )}
      </PullRequestMenu>
      {expanded &&
        prs.rest.map((pr) => (
          <PullRequestMenu key={pr.number} path={path} pr={pr} prs={prs}>
            <PullRequestRow path={path} pr={pr} />
          </PullRequestMenu>
        ))}
      {prs.rest.length > 0 && (
        <DetailsRow onClick={() => setExpanded(!expanded)} className="text-muted-foreground">
          <RowIcon icon={Plus} className={expanded ? "rotate-45" : undefined} />
          <RowLabel>{expanded ? "Show less" : `Show ${prs.rest.length} more`}</RowLabel>
        </DetailsRow>
      )}
    </div>
  );
}

const openTab = (path: string, pr: SessionPullRequest) =>
  openPullRequestTab({ repoPath: path, number: pr.number, title: pr.title });

/** A pull request that is not the open one: one line. */
function PullRequestRow({ path, pr }: { path: string; pr: SessionPullRequest }) {
  const { icon, className } = prIcon(pr);
  return (
    <DetailsRow onClick={() => openTab(path, pr)} title={`${pr.title}\n${pr.url}`}>
      <RowIcon icon={icon} className={className} />
      <RowLabel>{pr.title}</RowLabel>
      <RowMeta>#{pr.number}</RowMeta>
    </DetailsRow>
  );
}

/** The open pull request: two lines, its checks, and the action it waits on. */
function CurrentPullRequestRow({
  path,
  pr,
  prs,
}: {
  path: string;
  pr: SessionPullRequest;
  prs: SessionPullRequests;
}) {
  const detail = usePrDetail(path, pr.number).data ?? null;
  const live = detail ?? pr;
  const { icon, className } = prIcon(live);
  const checksState = detail ? detail.checksState : pr.checksState;
  const checks = checksState && !live.isDraft ? CHECKS[checksState] : null;
  const watching = prs.links.some(
    (l) => l.url.toLowerCase() === pr.url.toLowerCase() && l.watching,
  );
  const action = detail ? resolvePullRequestRowAction(detail) : null;
  const source = pr.source ? `\n${LINK_SOURCE_LABEL[pr.source]}` : "";
  return (
    <div className="flex items-center gap-1 rounded-md hover:bg-element-hover">
      <DetailsRow
        multiline
        onClick={() => openTab(path, pr)}
        title={`${live.title}\n${pr.url}${source}`}
        className="flex-1 items-start hover:bg-transparent"
      >
        <RowIcon icon={icon} className={`mt-0.5 ${className ?? ""}`} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate">{live.title}</span>
          <span className="flex items-center gap-1.5 text-2xs font-normal text-muted-foreground">
            <span className="tabular-nums">#{pr.number}</span>
            {checks && (
              <checks.icon size={12} className={checks.className} aria-label={checks.label} />
            )}
            {watching && <Eye size={12} aria-label="Watching" />}
          </span>
        </span>
      </DetailsRow>
      {detail && action && (
        <span className="me-1 shrink-0">
          <RowAction path={path} pr={pr} detail={detail} action={action} />
        </span>
      )}
    </div>
  );
}

function RowAction({
  path,
  pr,
  detail,
  action,
}: {
  path: string;
  pr: SessionPullRequest;
  detail: PrDetail;
  action: PullRequestRowAction;
}) {
  const { pendingAction, perform } = usePullRequestActions(path, pr.number, detail.headSha);
  const confirm = useInlineConfirm(`details:${path}:${pr.number}`);
  const busy = pendingAction !== null;
  if (action === "resolve") {
    return (
      <Button size="xs" variant="ghost" onClick={() => openTab(path, pr)}>
        Resolve
      </Button>
    );
  }
  if (action === "ready") {
    return (
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void perform("ready")}>
        {pendingAction === "ready" ? "Marking…" : "Ready"}
      </Button>
    );
  }
  const method = resolveMergeMethod(allowedMergeMethods(detail), null, projectMergeMethod(path));
  const armed = confirm.isArmed("merge");
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy}
      title={MERGE_METHOD_LABELS[method]}

      {...confirm.props("merge", () => void perform("merge", method))}
    >
      {armed && <Check aria-hidden className="size-3.5" />}
      {pendingAction === "merge" ? "Merging…" : armed ? "Confirm?" : "Merge"}
    </Button>
  );
}

/** Right-click: the session panel's actions for a linked pull request, or
 *  "Link to this session" for one found on the branch. */
function PullRequestMenu({
  path,
  pr,
  prs,
  children,
}: {
  path: string;
  pr: SessionPullRequest;
  prs: SessionPullRequests;
  children: ReactNode;
}) {
  const link = prs.links.find((l) => l.url.toLowerCase() === pr.url.toLowerCase()) ?? null;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {link && prs.threadId ? (
          <SessionPullRequestMenuItems
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            threadId={prs.threadId}
            link={link}
            onOpen={() => openSessionLink(link, sessionCheckouts(null, path))}
          />
        ) : (
          <>
            <ContextMenuItem onClick={() => openTab(path, pr)}>
              <GitPullRequest aria-hidden />
              Open #{pr.number}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => openLinkOnHost(pr)}>
              <ArrowUpRight aria-hidden />
              Open on GitHub
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void copySessionLink(pr)}>
              <Link aria-hidden />
              Copy link
            </ContextMenuItem>
            {prs.threadId && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => void linkBranchPullRequest(prs.threadId!, path, pr.number)}
                >
                  <Link2 aria-hidden />
                  Link to this session
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

async function linkBranchPullRequest(threadId: string, repoPath: string, number: number) {
  try {
    await linkSessionPullRequest(threadId, repoPath, number);
    toast.success(`Linked #${number} to this session`);
  } catch (raw) {
    toast.error("Could not link the pull request", {
      description: prErrorMessage(classifyPrError(raw)),
    });
  }
}
