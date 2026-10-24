// The header's controls: the one prominent action (Merge, Ready for review,
// auto-merge, Resolve conflicts, or the state once it is done), Check out,
// the ⋯ menu with everything else, and in the tab bar the checks popover or
// Approve workflows. A merge, auto-merge, close, revert, approval or branch
// delete needs a second press on the same control.

import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hammer,
  Link,
  MessageCircleQuestion,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Unlink,
  type LucideIcon,
} from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import {
  checkStatusLabel,
  CHECKS_STATE_LABELS,
  groupChecks,
  MERGE_METHOD_LABELS,
  summarizeChecks,
  type PrimaryControl,
} from "../lib/pull-request-logic";
import type {
  PrAction,
  PrCheck,
  PrChecksState,
  PrDetail,
  PrMergeMethod,
} from "../lib/pull-requests-types";
import { useInlineConfirm } from "../lib/use-inline-confirm";
import type { PerformPullRequestAction } from "../lib/use-pull-request-actions";
import type { CheckoutMode, PullRequestAgentActions } from "../lib/use-pull-request-agent-actions";
import type { SessionPullRequestLink } from "../lib/use-session-pull-request-link";
import { StatePill } from "./pull-request-header";
import {
  CheckStatusIcon,
  CHECKS_STATE_PRESENTATION,
  type StatePresentation,
} from "./pull-request-presentation";
import { ChecksButton } from "./pull-request-triggers";

// ── the primary control ─────────────────────────────────────────────────

function ArmedAutoMerge({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Badge variant="info">
          <GitMerge aria-hidden className="size-3.5" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}: GitHub merges this on its own once its requirements are met
      </TooltipContent>
    </Tooltip>
  );
}

/** A label that keeps the width of its longest wording, so the confirming
 *  press lands on the same button. */
function SteadyLabel({ widest, shown }: { widest: readonly string[]; shown: string }) {
  return (
    <span className="inline-grid">
      {widest.map((text) => (
        <span key={text} aria-hidden className="invisible col-start-1 row-start-1">
          {text}
        </span>
      ))}
      <span className="col-start-1 row-start-1">{shown}</span>
    </span>
  );
}

export function PullRequestPrimaryAction({
  scopeKey,
  primary,
  autoMergeArmed,
  armedAutoMergeLabel,
  mergeMethod,
  statePresentation,
  pendingAction,
  perform,
  resolveConflicts = null,
}: {
  scopeKey: string;
  primary: PrimaryControl;
  autoMergeArmed: boolean;
  armedAutoMergeLabel: string;
  mergeMethod: PrMergeMethod;
  statePresentation: StatePresentation;
  pendingAction: PrAction | null;
  perform: PerformPullRequestAction;
  /** "Resolve conflicts", where an agent can take them; else a badge says so. */
  resolveConflicts?: ReactNode;
}) {
  const confirm = useInlineConfirm(scopeKey);
  const busy = pendingAction !== null;
  const mergeLabel = MERGE_METHOD_LABELS[mergeMethod];
  const autoMergeLabel = `Auto-merge (${mergeLabel.toLowerCase()})`;

  if (primary === "resolve") {
    if (resolveConflicts) return resolveConflicts;
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <Badge variant="destructive">
            <GitPullRequestClosed aria-hidden className="size-3.5" />
            Conflicts
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          This branch conflicts with its base; resolve them in a checkout and push.
        </TooltipContent>
      </Tooltip>
    );
  }
  if (primary === "ready") {
    return (
      <Button size="xs" disabled={busy} onClick={() => void perform("ready")}>
        <GitPullRequestArrow aria-hidden className="size-3.5" />
        {pendingAction === "ready" ? "Marking ready…" : "Ready for review"}
      </Button>
    );
  }
  if (primary === "enable-auto-merge" || primary === "merge") {
    const action = primary;
    const armed = confirm.isArmed(action);
    const idle = action === "merge" ? mergeLabel : autoMergeLabel;
    const confirmText = action === "merge" ? "Confirm merge?" : "Confirm auto-merge?";
    const pendingText = action === "merge" ? "Merging…" : "Turning on…";
    const shown = pendingAction === action ? pendingText : armed ? confirmText : idle;
    return (
      <>
        {autoMergeArmed ? <ArmedAutoMerge label={armedAutoMergeLabel} /> : null}
        <Button
          size="xs"
          disabled={busy}
          aria-label={shown}
          {...confirm.props(action, () => void perform(action, mergeMethod))}
        >
          {armed ? (
            <Check aria-hidden className="size-3.5" />
          ) : (
            <GitMerge aria-hidden className="size-3.5" />
          )}
          <SteadyLabel widest={[idle, confirmText]} shown={shown} />
        </Button>
      </>
    );
  }
  if (primary === "auto-merge-armed") return <ArmedAutoMerge label={armedAutoMergeLabel} />;
  if (primary === "merged" || primary === "closed") {
    return <StatePill presentation={statePresentation} />;
  }
  return autoMergeArmed ? <ArmedAutoMerge label={armedAutoMergeLabel} /> : null;
}

// ── header buttons beside the primary control ───────────────────────────

/** "Resolve conflicts": a session on the pull request's branch with the task
 *  of bringing it up to date with its base. */
export function ResolveConflictsButton({
  pending,
  disabled,
  onResolve,
}: {
  pending: boolean;
  disabled: boolean;
  onResolve: () => void;
}) {
  const label = pending ? "Preparing…" : "Resolve conflicts";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={disabled}
          onClick={onResolve}
          aria-label={label}
        >
          <GitPullRequestClosed aria-hidden className="size-3.5" />
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        This branch conflicts with its base. An agent session on the branch brings it up to date.
      </TooltipContent>
    </Tooltip>
  );
}

/** "Approve workflows to run": a fork's runs wait for someone with write
 *  access. A second press approves, as a merge does. */
export function ApproveWorkflowsButton({
  scopeKey,
  pendingAction,
  perform,
}: {
  scopeKey: string;
  pendingAction: PrAction | null;
  perform: PerformPullRequestAction;
}) {
  const confirm = useInlineConfirm(`${scopeKey}:approve`);
  const idle = "Approve workflows to run";
  const confirmText = "Confirm approve?";
  const shown =
    pendingAction === "approve-workflows"
      ? "Approving…"
      : confirm.isArmed("approve-workflows")
        ? confirmText
        : idle;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ml-auto inline-flex shrink-0" />}>
        <Button
          size="xs"
          variant="warning-outline"
          disabled={pendingAction !== null}
          aria-label={shown}
          {...confirm.props("approve-workflows", () => void perform("approve-workflows"))}
        >
          <Play aria-hidden className="size-3.5" />
          <SteadyLabel widest={[idle, confirmText]} shown={shown} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Workflow runs from this fork are waiting for approval before they run.
      </TooltipContent>
    </Tooltip>
  );
}

/** "Check out": the head in a worktree of its own, or the project's own
 *  checkout switched to it. */
export function CheckoutMenu({
  pending,
  onCheckout,
}: {
  /** The mode being prepared, or `null`. */
  pending: CheckoutMode | null;
  onCheckout: (mode: CheckoutMode) => void;
}) {
  const label = pending ? "Checking out…" : "Check out";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              disabled={pending !== null}
              render={<Button size="xs" variant="outline" aria-label={label} />}
            />
          }
        >
          <GitBranch aria-hidden className="size-3.5" />
          {label}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Check out this pull request</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="w-72">
        <DropdownMenuItem onClick={() => onCheckout("worktree")}>
          <GitBranch className="mt-0.5 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>In a separate worktree</span>
            <span className="text-2xs text-muted-foreground">
              Its own folder and session. Nothing you have open moves.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCheckout("local")}>
          <FolderGit2 className="mt-0.5 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>In this repository</span>
            <span className="text-2xs text-muted-foreground">
              Switches the branch you are working in, like `gh pr checkout`.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── the ⋯ menu ──────────────────────────────────────────────────────────

/** One item with a second line beneath its label. */
function TwoLine({
  icon: Icon,
  label,
  detail,
  detailClassName,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  detailClassName?: string;
}) {
  return (
    <>
      <Icon className="mt-0.5 self-start" />
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        <span className={cn("text-2xs text-muted-foreground", detailClassName)}>{detail}</span>
      </span>
    </>
  );
}

/**
 * Everything else the reader can do with the pull request, in the order the
 * header's overflow lists it: the session link and Refresh, the agent
 * actions, the state changes (and the merge method), the links, then the
 * one-way doors — close, reopen or revert, and deleting the branch.
 */
export function PullRequestActionsMenu({
  scopeKey,
  detail,
  refreshing,
  onRefresh,
  can,
  autoMergeArmed,
  showsDraftToggle,
  showsMergeNow,
  showsAutoMerge,
  showsMergeMethods,
  allowedMergeMethods,
  mergeMethod,
  onSelectMergeMethod,
  showsDeleteBranch,
  pendingAction,
  perform,
  onRevert,
  agent,
  sessionLink,
  onWriteGuide,
  onCopyLink,
  onCopyNumber,
}: {
  scopeKey: string;
  detail: Pick<PrDetail, "url" | "number" | "state" | "isDraft" | "headBranch">;
  agent: PullRequestAgentActions;
  /** Linked to the session beside the tab, or not; `null` with no session. */
  sessionLink: SessionPullRequestLink | null;
  /** Starts the guide and shows its tab. */
  onWriteGuide: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  can: (action: PrAction) => boolean;
  autoMergeArmed: boolean;
  showsDraftToggle: boolean;
  showsMergeNow: boolean;
  showsAutoMerge: boolean;
  showsMergeMethods: boolean;
  allowedMergeMethods: readonly PrMergeMethod[];
  mergeMethod: PrMergeMethod;
  onSelectMergeMethod: (method: PrMergeMethod) => void;
  showsDeleteBranch: boolean;
  pendingAction: PrAction | null;
  perform: PerformPullRequestAction;
  /** Opens the revert as a new pull request. */
  onRevert: () => void;
  onCopyLink: () => void;
  onCopyNumber: () => void;
}) {
  const confirm = useInlineConfirm(`${scopeKey}:menu`);
  const busy = pendingAction !== null;
  const copyLinkShortcut = useActionShortcut("pullRequest.copyLink");
  const copyNumberShortcut = useActionShortcut("pullRequest.copyNumber");
  const open = detail.state === "open";
  const stateItems =
    open && (showsDraftToggle || showsMergeNow || showsAutoMerge || autoMergeArmed);
  const methods = open && showsMergeMethods;

  /** A menu item that needs a second press: the first arms it and keeps the
   *  menu open, the second runs it and closes. */
  const confirmed = (action: string, run: () => void) => ({
    closeOnClick: confirm.isArmed(action),
    ...confirm.props(action, run),
  });

  const endGroup =
    open && can("close") ? (
      <DropdownMenuItem
        variant="destructive"
        disabled={busy}
        {...confirmed("close", () => void perform("close"))}
      >
        <GitPullRequestClosed />
        {confirm.isArmed("close") ? "Confirm close?" : "Close pull request"}
      </DropdownMenuItem>
    ) : detail.state === "closed" && can("reopen") ? (
      <DropdownMenuItem disabled={busy} onClick={() => void perform("reopen")}>
        <RotateCcw />
        Reopen pull request
      </DropdownMenuItem>
    ) : detail.state === "merged" && can("revert") ? (
      <DropdownMenuItem
        variant={confirm.isArmed("revert") ? "destructive" : "default"}
        disabled={busy}
        {...confirmed("revert", onRevert)}
      >
        <RotateCcw />
        {pendingAction === "revert"
          ? "Reverting…"
          : confirm.isArmed("revert")
            ? "Confirm revert?"
            : "Revert changes"}
      </DropdownMenuItem>
    ) : null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <IconButton
                  icon={refreshing ? RefreshCw : MoreHorizontal}
                  label={refreshing ? "Refreshing pull request" : "More pull request actions"}
                  size="sm"
                />
              }
            />
          }
        />
        <TooltipContent side="bottom">More pull request actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="w-80">
        {sessionLink ? (
          <DropdownMenuItem disabled={sessionLink.pending} onClick={sessionLink.toggle}>
            {sessionLink.linked ? <Unlink /> : <Link />}
            {sessionLink.linked ? "Unlink from this session" : "Link to this session"}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          Refresh
        </DropdownMenuItem>
        <AgentMenuItems agent={agent} onWriteGuide={onWriteGuide} />
        <DropdownMenuSeparator />
        {stateItems ? (
          <>
            {showsDraftToggle ? (
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
              >
                {detail.isDraft ? <GitPullRequestArrow /> : <GitPullRequestDraft />}
                {detail.isDraft ? "Ready for review" : "Convert to draft"}
              </DropdownMenuItem>
            ) : null}
            {showsMergeNow ? (
              <DropdownMenuItem
                disabled={busy}
                {...confirmed("merge", () => void perform("merge", mergeMethod))}
              >
                {confirm.isArmed("merge") ? <Check /> : <GitMerge />}
                {confirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
              </DropdownMenuItem>
            ) : null}
            {autoMergeArmed && can("disable-auto-merge") ? (
              <DropdownMenuItem disabled={busy} onClick={() => void perform("disable-auto-merge")}>
                <GitMerge />
                Turn off auto-merge
              </DropdownMenuItem>
            ) : showsAutoMerge ? (
              <DropdownMenuItem
                disabled={busy}
                {...confirmed(
                  "enable-auto-merge",
                  () => void perform("enable-auto-merge", mergeMethod),
                )}
              >
                {confirm.isArmed("enable-auto-merge") ? <Check /> : <GitMerge />}
                {confirm.isArmed("enable-auto-merge")
                  ? "Confirm auto-merge?"
                  : "Turn on auto-merge"}
              </DropdownMenuItem>
            ) : null}
            {methods ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {methods ? (
          <DropdownMenuRadioGroup
            value={mergeMethod}
            onValueChange={(method) => onSelectMergeMethod(method as PrMergeMethod)}
          >
            {allowedMergeMethods.map((method) => (
              <DropdownMenuRadioItem key={method} value={method} disabled={busy} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <GitMerge aria-hidden className="size-3.5" />
                  {MERGE_METHOD_LABELS[method]}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : null}
        {stateItems || methods ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onClick={() => openPullRequest(detail.url)}>
          <ArrowUpRight />
          Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyLink}>
          <Link />
          Copy link
          {copyLinkShortcut ? (
            <DropdownMenuShortcut>{copyLinkShortcut.label}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyNumber}>
          <Copy />
          Copy PR number
          {copyNumberShortcut ? (
            <DropdownMenuShortcut>{copyNumberShortcut.label}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        {endGroup ? (
          <>
            <DropdownMenuSeparator />
            {endGroup}
          </>
        ) : null}
        {showsDeleteBranch ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              {...confirmed("delete-branch", () => void perform("delete-branch"))}
            >
              <TwoLine
                icon={Trash2}
                label={
                  pendingAction === "delete-branch"
                    ? "Deleting branch…"
                    : confirm.isArmed("delete-branch")
                      ? "Confirm delete?"
                      : "Delete branch"
                }
                detail={detail.headBranch}
                detailClassName="truncate"
              />
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ⋯ menu's agent group: ask, explain, fix, and the guide. */
function AgentMenuItems({
  agent,
  onWriteGuide,
}: {
  agent: PullRequestAgentActions;
  onWriteGuide: () => void;
}) {
  const handing = agent.pending !== null;
  const { guide } = agent;
  return (
    <>
      <DropdownMenuItem disabled={handing} onClick={agent.ask}>
        <TwoLine
          icon={MessageCircleQuestion}
          label={agent.pending === "ask" ? "Opening…" : "Ask a question"}
          detail={
            agent.attachesToComposer
              ? "Adds the pull request to this session's composer."
              : `Opens a ${agent.agentLabel} session that knows which pull request you mean.`
          }
        />
      </DropdownMenuItem>
      <DropdownMenuItem disabled={handing} onClick={() => agent.explain()}>
        <TwoLine
          icon={BookOpen}
          label={agent.pending === "explain" ? "Opening…" : "Explain this PR"}
          detail="A walk through the diff and what to read closely."
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={handing || agent.fixFindings === null}
        onClick={agent.fixFindings ?? undefined}
      >
        <Hammer />
        {agent.pending === "findings" ? "Preparing…" : agent.fixFindingsLabel}
      </DropdownMenuItem>
      {guide.canWrite ? (
        <DropdownMenuItem disabled={guide.running} onClick={onWriteGuide}>
          <Sparkles />
          {guide.running
            ? "Writing guide…"
            : guide.guide === null
              ? "Write guide"
              : "Rewrite guide"}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

// ── checks ──────────────────────────────────────────────────────────────

function ChecksList({
  checks,
  onFix,
  fixing,
}: {
  checks: readonly PrCheck[];
  onFix: ((check: PrCheck) => void) | null;
  fixing: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupChecks(checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  const visible = [...attention, ...running, ...(showAll || !canCollapse ? completed : [])];
  if (checks.length === 0) {
    return <p className="text-xs text-muted-foreground">No checks reported.</p>;
  }
  return (
    <>
      <ul className="-me-1 max-h-64 space-y-1 overflow-y-auto pe-1">
        {visible.map((check, index) => (
          <li
            key={`${index}:${check.name}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 text-xs"
          >
            <CheckStatusIcon status={check.status} />
            <span className="min-w-0 truncate" title={check.description ?? check.name}>
              {check.name}
            </span>
            <span className="whitespace-nowrap text-muted-foreground">
              {checkStatusLabel(check)}
            </span>
            {check.url ? (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => openPullRequest(check.url!)}
              >
                Details
              </button>
            ) : (
              <span />
            )}
            {onFix && (check.status === "failure" || check.status === "cancelled") ? (
              <Button size="xs" variant="ghost" disabled={fixing} onClick={() => onFix(check)}>
                <Hammer aria-hidden className="size-3" />
                Fix
              </Button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : `Show all ${checks.length}`}
        </Button>
      ) : null}
    </>
  );
}

/** The tab bar's checks line: the rollup's glyph opens the list. */
export function PullRequestChecksStatus({
  checks,
  checksState,
  truncated,
  onFix = null,
  fixing = false,
}: {
  checks: readonly PrCheck[];
  checksState: PrChecksState | null;
  truncated: boolean;
  /** "Fix" on a failing check: a session on the pull request's branch. */
  onFix?: ((check: PrCheck) => void) | null;
  fixing?: boolean;
}) {
  const summary = summarizeChecks(checks);
  if (checksState === null) {
    return <span className="ml-auto truncate text-xs text-muted-foreground">{summary}</span>;
  }
  const presentation = CHECKS_STATE_PRESENTATION[checksState];
  return (
    <Popover>
      <PopoverTrigger render={<ChecksButton aria-label={`Checks: ${summary}`} />}>
        <presentation.Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", presentation.toneClassName)}
        />
        <span className="truncate">{summary}</span>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-96">
        <p className="mb-1 text-sm font-medium">{CHECKS_STATE_LABELS[checksState]}</p>
        <p className="mb-2 text-xs text-muted-foreground">
          {summary}
          {truncated ? " · more checks ran than GitHub lists here" : ""}
        </p>
        <ChecksList checks={checks} onFix={onFix} fixing={fixing} />
      </PopoverContent>
    </Popover>
  );
}
