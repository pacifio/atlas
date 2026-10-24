// Branch, pull requests and the one git action worth a click: the Version
// control group. What changed is the Details card's own Changes section.
//
// Reads the git store, which mirrors the ACTIVE project's repository. The
// section renders only when that repository is this session's project, so a
// background project's chat never shows another repo's branch.
//
// A session that works in another checkout — a pull request session's
// worktree (`sessionWorkPath`) — is not the repository the git store mirrors.
// Its branch, the push / pull / publish verbs and Create PR would all act on
// the project's own checkout, so they are left out there; what stays is
// what belongs to the session itself: its linked pull requests.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Eye,
  Link,
  CircleCheck,
  CircleDashed,
  CircleX,
  CloudDownload,
  CloudUpload,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  List,
  Plus,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { openPullRequestTab } from "@/features/pull-requests/lib/open-pull-request-tab";
import { openPullRequestListTab } from "@/features/pull-requests/lib/open-pull-request-list-tab";
import { openSessionPullRequestsTab } from "@/features/pull-requests/lib/open-session-pull-requests-tab";
import { SessionPullRequestMenuItems } from "@/features/pull-requests/components/session-pull-request-menu";
import { classifyPrError, prErrorMessage } from "@/features/pull-requests/lib/pr-errors";
import { sessionCheckouts } from "@/features/pull-requests/lib/session-checkouts";
import {
  copySessionLink,
  openLinkOnHost,
  openSessionLink,
} from "@/features/pull-requests/lib/session-pull-request-actions";
import { linkSessionPullRequest } from "@/features/pull-requests/lib/session-pull-requests-api";
import { openLinkPullRequestDialog } from "@/features/pull-requests/components/link-pull-request-dialog";
import {
  LINK_SOURCE_LABEL,
  linkKey,
} from "@/features/pull-requests/lib/session-pull-request-links";
import { useGitStore } from "@/features/git/stores/git-store";
import type { PrChecksState } from "@/features/pull-requests/lib/pull-requests-types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/ui/dropdown-menu";

import { startCreatePr, useCreatePrDraft } from "../lib/create-pr";
import {
  fetchRemotes,
  publishBranch,
  pullBranch,
  pushBranch,
  revealSourceControl,
} from "../lib/git-actions";
import { resolveQuickAction, type QuickAction } from "../lib/quick-action";
import {
  useSessionPullRequests,
  type SessionPullRequest,
  type SessionPullRequests,
} from "../lib/session-pull-requests";
import { BranchPicker } from "./branch-picker";
import {
  ContextRow,
  ContextSection,
  ContextSplitRow,
  RowIcon,
  RowLabel,
  RowMeta,
} from "./context-rows";

export function VersionControlSection({
  tabId,
  projectPath,
  workPath = projectPath,
}: {
  tabId: string | null;
  projectPath: string;
  /** Where the session works; a worktree when it is not `projectPath`. */
  workPath?: string;
}) {
  const repoPath = useGitStore.use.repoPath();
  const isRepo = useGitStore.use.isRepo();
  const worktree = workPath !== projectPath;
  const ours = repoPath === projectPath && isRepo && !worktree;

  // Fresh numbers on open: the store is patched by the watcher, but ahead /
  // behind against the upstream only move on a snapshot.
  useEffect(() => {
    if (ours) void useGitStore.getState().actions.refresh(projectPath);
  }, [ours, projectPath]);

  if (worktree) return <WorktreeRows tabId={tabId} projectPath={projectPath} />;
  if (!ours) return null;
  return <VersionControlRows tabId={tabId} projectPath={projectPath} />;
}

/** A worktree session: its own pull requests and changes, nothing that would
 *  act on the project's checkout. */
function WorktreeRows({ tabId, projectPath }: { tabId: string | null; projectPath: string }) {
  const sessionId = useChatStore((s) => (tabId ? (s.sessions[tabId]?.acpSessionId ?? null) : null));
  // No branch: the git store's is the project's, not the worktree's.
  const prs = useSessionPullRequests(projectPath, null, sessionId);
  return (
    <ContextSection title="Version control" showHeading={false}>
      <PullRequestRows projectPath={projectPath} prs={prs} />
      <PullRequestLinkRows projectPath={projectPath} prs={prs} />
    </ContextSection>
  );
}

function VersionControlRows({ tabId, projectPath }: { tabId: string | null; projectPath: string }) {
  const branch = useGitStore.use.branch();
  const sessionId = useChatStore((s) => (tabId ? (s.sessions[tabId]?.acpSessionId ?? null) : null));
  const prs = useSessionPullRequests(projectPath, branch || null, sessionId);
  return (
    <ContextSection title="Version control" showHeading={false}>
      <BranchPicker />
      <PullRequestRows projectPath={projectPath} prs={prs} />
      <PullRequestLinkRows projectPath={projectPath} prs={prs} />
      <QuickActionRow projectPath={projectPath} sessionId={sessionId} prs={prs} />
    </ContextSection>
  );
}

function prIcon(pr: SessionPullRequest): { icon: LucideIcon; className?: string } {
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

/**
 * The session's pull requests (`useSessionPullRequests`: its links and the
 * branch's own): the one that matters now, then the rest behind "Show N
 * more". Each opens in its own surface tab (`openPullRequestTab`).
 */
function PullRequestRows({ projectPath, prs }: { projectPath: string; prs: SessionPullRequests }) {
  const [expanded, setExpanded] = useState(false);
  if (!prs.current) return null;
  return (
    <>
      <PullRequestRow projectPath={projectPath} pr={prs.current} prs={prs} />
      {expanded &&
        prs.rest.map((pr) => (
          <PullRequestRow key={pr.number} projectPath={projectPath} pr={pr} prs={prs} />
        ))}
      {!expanded && prs.rest.length > 0 && (
        <ContextRow onClick={() => setExpanded(true)} className="text-muted-foreground">
          <Plus size={14} className="shrink-0" aria-hidden />
          <RowLabel>Show {prs.rest.length} more</RowLabel>
        </ContextRow>
      )}
    </>
  );
}

/**
 * One pull request. A click opens its tab; a right-click offers what the
 * session's pull request panel does (Open, Open on GitHub, Copy link, Watch,
 * Unlink) for a linked one, and Link to this session for a branch pull
 * request not linked yet.
 */
function PullRequestRow({
  projectPath,
  pr,
  prs,
}: {
  projectPath: string;
  pr: SessionPullRequest;
  prs: SessionPullRequests;
}) {
  const { icon, className } = prIcon(pr);
  const checks = pr.state === "open" && pr.checksState ? CHECKS[pr.checksState] : null;
  const link = prs.links.find((l) => l.url.toLowerCase() === pr.url.toLowerCase()) ?? null;
  const openTab = () =>
    openPullRequestTab({ repoPath: projectPath, number: pr.number, title: pr.title });
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>
        <ContextRow
          onClick={openTab}
          title={`${pr.title} — ${pr.url}${pr.source ? `\n${LINK_SOURCE_LABEL[pr.source]}` : ""}`}
        >
          <RowIcon icon={icon} className={className} />
          <RowLabel>{pr.title}</RowLabel>
          {link?.watching && (
            <span title="Watching" className="inline-flex shrink-0">
              <Eye size={12} aria-label="Watching" />
            </span>
          )}
          {checks && (
            <span title={checks.label} className="inline-flex shrink-0">
              <checks.icon size={12} className={checks.className} aria-label={checks.label} />
            </span>
          )}
          <RowMeta>#{pr.number}</RowMeta>
        </ContextRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {link && prs.threadId ? (
          <SessionPullRequestMenuItems
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            threadId={prs.threadId}
            link={link}
            onOpen={() => openSessionLink(link, sessionCheckouts(null, projectPath))}
          />
        ) : (
          <>
            <ContextMenuItem onClick={openTab}>
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
                  onClick={() => void linkBranchPullRequest(prs.threadId!, projectPath, pr.number)}
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

/** The session's pull request count (opening its panel), "Link a pull
 *  request…" and "View all pull requests", under the rows. */
function PullRequestLinkRows({
  projectPath,
  prs,
}: {
  projectPath: string;
  prs: SessionPullRequests;
}) {
  const { threadId, links } = prs;
  const open = links.filter((l) => !l.snapshot || l.snapshot.state === "open").length;
  return (
    <>
      {threadId && links.length > 0 && (
        <ContextRow
          onClick={() => openSessionPullRequestsTab({ threadId, cwd: projectPath })}
          title="Every pull request linked to this session, with their checks and chains"
        >
          <RowIcon icon={GitPullRequest} />
          <RowLabel>Session pull requests</RowLabel>
          <RowMeta>
            {open > 0 && open < links.length ? `${open} open · ` : ""}
            {links.length} linked
          </RowMeta>
        </ContextRow>
      )}
      <ContextRow
        onClick={() => {
          if (threadId) {
            openLinkPullRequestDialog({
              threadId,
              repoPath: projectPath,
              linked: links.map(linkKey),
            });
          }
        }}
        disabled={!threadId}
        title={threadId ? undefined : "A pull request can be linked once the session has started."}
        className="text-muted-foreground"
      >
        <Link2 size={14} className="shrink-0" aria-hidden />
        <RowLabel>Link a pull request…</RowLabel>
      </ContextRow>
      <ContextRow
        onClick={() => openPullRequestListTab({ repoPath: projectPath })}
        className="text-muted-foreground"
      >
        <List size={14} className="shrink-0" aria-hidden />
        <RowLabel>View all pull requests</RowLabel>
      </ContextRow>
    </>
  );
}

const QUICK_ICON: Record<QuickAction["kind"], LucideIcon> = {
  push: CloudUpload,
  publish: CloudUpload,
  pull: CloudDownload,
  "create-pr": GitPullRequestArrow,
  "open-changes": GitCommitHorizontal,
  hint: CloudUpload,
};

function runQuickAction(action: QuickAction, projectPath: string, sessionId: string | null): void {
  switch (action.kind) {
    case "push":
      void pushBranch();
      return;
    case "publish":
      void publishBranch();
      return;
    case "pull":
      void pullBranch();
      return;
    case "create-pr":
      void startCreatePr(projectPath, false, sessionId);
      return;
    case "open-changes":
      revealSourceControl();
      return;
    case "hint":
      return;
  }
}

function QuickActionRow({
  projectPath,
  sessionId,
  prs,
}: {
  projectPath: string;
  sessionId: string | null;
  prs: SessionPullRequests;
}) {
  const isRepo = useGitStore.use.isRepo();
  const branch = useGitStore.use.branch();
  const branches = useGitStore.use.branchesFull();
  const changedFiles = useGitStore((s) => s.files.length);
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const busy = useGitStore((s) => !!s.activeOp?.running);
  const current = branches.find((b) => b.isCurrent && !b.isRemote);
  const draft = useCreatePrDraft(projectPath, branch || null).data;

  const action = resolveQuickAction({
    isRepo,
    branch,
    detached: !current,
    changedFiles,
    upstream: current?.upstream ?? null,
    ahead,
    behind,
    busy,
    // Until both reads answer, nothing offers a PR: a "Create PR" that turns
    // into "Push" a moment later is a button that moved under the pointer.
    hasOpenPr: prs.loading || prs.hasOpen,
    isDefaultBranch: draft ? draft.baseBranch === branch : true,
  });
  if (!action) return null;

  const hasUpstream = !!current?.upstream;
  const offersPr = action.kind === "create-pr";
  return (
    <ContextSplitRow
      onClick={() => runQuickAction(action, projectPath, sessionId)}
      disabled={action.kind === "hint"}
      title={action.kind === "hint" ? action.hint : undefined}
      menuLabel="More git actions"
      menu={
        <>
          {offersPr && (
            <>
              <DropdownMenuItem onClick={() => void startCreatePr(projectPath, true, sessionId)}>
                <GitPullRequestDraft />
                {hasUpstream && ahead === 0 ? "Create draft PR" : "Push & create draft PR"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => void pullBranch()} disabled={!hasUpstream || busy}>
            <CloudDownload />
            Pull
            {behind > 0 && <span className="ml-auto tabular-nums">{behind}</span>}
          </DropdownMenuItem>
          {hasUpstream ? (
            <DropdownMenuItem onClick={() => void pushBranch()} disabled={busy || ahead === 0}>
              <CloudUpload />
              Push
              {ahead > 0 && <span className="ml-auto tabular-nums">{ahead}</span>}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => void publishBranch()} disabled={busy || !current}>
              <CloudUpload />
              Publish branch
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void fetchRemotes()} disabled={busy}>
            <RefreshCw />
            Fetch
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={revealSourceControl}>
            <GitCommitHorizontal />
            Open Source Control
          </DropdownMenuItem>
        </>
      }
    >
      <RowIcon icon={QUICK_ICON[action.kind]} />
      <RowLabel>{action.label}</RowLabel>
      {action.kind === "push" && <RowMeta>{ahead} ↑</RowMeta>}
      {action.kind === "pull" && <RowMeta>{behind} ↓</RowMeta>}
    </ContextSplitRow>
  );
}
