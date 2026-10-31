// The header's parts: the crumbs row (repository and number, swapped for the
// number and title once the title has scrolled away), the title editor, the
// expanded body (author, checkout command, base ← head, files and diff stat),
// and the one-line condensed row that replaces it.

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, FileDiff, TriangleAlert, GitMerge } from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import { classifyPrError } from "../lib/pr-errors";
import { canEditPullRequest, checkoutCommand } from "../lib/pull-request-logic";
import { usePrUpdateMutation } from "../lib/pull-requests-queries";
import type { PrDetail, PrUpdateMethod } from "../lib/pull-requests-types";
import { readableFailure } from "../lib/use-pull-request-actions";
import { EditButton } from "./pull-request-markdown";
import {
  ActorLabel,
  DiffStat,
  MetaLine,
  type StatePresentation,
} from "./pull-request-presentation";
import { CopyButton, NumberLinkButton, StaleBaseButton } from "./pull-request-triggers";

// ── crumbs ──────────────────────────────────────────────────────────────

const ROW =
  "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none";

function NumberLink({
  detail,
  toneClassName,
  focusable,
}: {
  detail: Pick<PrDetail, "url" | "number">;
  toneClassName: string;
  focusable: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <NumberLinkButton
            tone={toneClassName}
            tabIndex={focusable ? undefined : -1}
            onClick={() => openPullRequest(detail.url)}
            aria-label={`Open pull request #${detail.number} on GitHub`}
          />
        }
      >
        #{detail.number}
        <ExternalLink aria-hidden className="size-2.5" />
      </TooltipTrigger>
      <TooltipContent side="top">Open on GitHub</TooltipContent>
    </Tooltip>
  );
}

export function PullRequestCrumbs({
  detail,
  toneClassName,
  condensed,
  repositoryUrl,
  onBack = null,
}: {
  detail: Pick<PrDetail, "url" | "number" | "repository" | "title">;
  toneClassName: string;
  condensed: boolean;
  repositoryUrl: string | null;
  /** Back to the tab this one was opened from; `null` hides the arrow. */
  onBack?: (() => void) | null;
}) {
  return (
    <div className={cn("flex h-7 min-w-0 items-center gap-1", onBack ? "pl-2.5" : "pl-4")}>
      {onBack ? <IconButton icon={ArrowLeft} label="Back" size="xs" onClick={onBack} /> : null}
      <CrumbRows
        detail={detail}
        toneClassName={toneClassName}
        condensed={condensed}
        repositoryUrl={repositoryUrl}
      />
    </div>
  );
}

function CrumbRows({
  detail,
  toneClassName,
  condensed,
  repositoryUrl,
}: {
  detail: Pick<PrDetail, "url" | "number" | "repository" | "title">;
  toneClassName: string;
  condensed: boolean;
  repositoryUrl: string | null;
}) {
  return (
    <div className="grid h-7 min-w-0 flex-1 items-center overflow-hidden">
      <div
        aria-hidden={condensed}
        inert={condensed}
        className={cn(
          ROW,
          condensed
            ? "pointer-events-none -translate-y-1 opacity-0 duration-100"
            : "translate-y-0 opacity-100 delay-50 duration-150",
        )}
      >
        {repositoryUrl ? (
          <button
            type="button"
            onClick={() => openPullRequest(repositoryUrl)}
            title={`Open ${detail.repository} on GitHub`}
            className="min-w-0 cursor-pointer truncate text-left font-medium underline-offset-2 hover:text-foreground hover:underline"
          >
            {detail.repository}
          </button>
        ) : (
          <span className="min-w-0 truncate font-medium">{detail.repository}</span>
        )}
        <NumberLink detail={detail} toneClassName={toneClassName} focusable={!condensed} />
      </div>
      <div
        aria-hidden={!condensed}
        inert={!condensed}
        className={cn(
          ROW,
          condensed
            ? "translate-y-0 opacity-100 delay-50 duration-150"
            : "pointer-events-none translate-y-1 opacity-0 duration-100",
        )}
      >
        <NumberLink detail={detail} toneClassName={toneClassName} focusable={condensed} />
        <span className="min-w-0 truncate font-medium text-foreground" title={detail.title}>
          {detail.title}
        </span>
      </div>
    </div>
  );
}

// ── title ───────────────────────────────────────────────────────────────

/** The title, renamed in place when the viewer may edit the pull request.
 *  The new title shows at once; a refusal puts the old one back. */
export function PullRequestTitleEditor({
  repoPath,
  detail,
}: {
  repoPath: string;
  detail: Pick<PrDetail, "number" | "title" | "capabilities" | "viewerPermissions">;
}) {
  const update = usePrUpdateMutation(repoPath, detail.number);
  const [draft, setDraft] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  // Once the read catches up with the saved title, stop overriding it.
  if (optimistic !== null && optimistic === detail.title) setOptimistic(null);
  const shown = optimistic ?? detail.title;

  const save = (next: string) => {
    const title = next.trim();
    setDraft(null);
    if (title.length === 0 || title === shown) return;
    setOptimistic(title);
    update.mutate(
      { title, body: null },
      {
        onError: (raw) => {
          setOptimistic(null);
          toast.error("The title could not be saved", {
            description: readableFailure(classifyPrError(raw), "GitHub refused the new title."),
          });
        },
      },
    );
  };

  if (draft === null) {
    return (
      <div className="group flex min-h-7 min-w-0 items-center gap-1">
        <h1 className="min-w-0 flex-1 truncate text-base leading-snug font-semibold" title={shown}>
          {shown}
        </h1>
        {canEditPullRequest(detail) ? (
          <EditButton label="Edit title" onClick={() => setDraft(shown)} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the pencil, so typing is next
        autoFocus
        size="sm"
        value={draft}
        aria-label="Pull request title"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            save(draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={draft.trim().length === 0}
          onClick={() => save(draft)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ── branches ────────────────────────────────────────────────────────────

export interface BaseFreshness {
  behindBy: number | null;
  methods: PrUpdateMethod[];
}

/** The base branch, with a warning that opens Update branch when the pull
 *  request has fallen behind it. */
export function BaseBranch({
  baseBranch,
  freshness,
  pending,
  onUpdate,
  compact = false,
}: {
  baseBranch: string;
  freshness: BaseFreshness | null;
  pending: boolean;
  onUpdate: (method: PrUpdateMethod) => void;
  compact?: boolean;
}) {
  const icon = compact ? "size-3" : "size-3.5";
  if (!freshness) {
    return (
      <code className="min-w-0 max-w-2/5 shrink-0 truncate" title={baseBranch}>
        {baseBranch}
      </code>
    );
  }
  const behind =
    freshness.behindBy === null
      ? ""
      : ` by ${freshness.behindBy.toLocaleString()} ${freshness.behindBy === 1 ? "commit" : "commits"}`;
  const summary = `This branch is out of date with ${baseBranch}${behind}.`;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={120}
        aria-label={summary}
        render={<StaleBaseButton />}
      >
        <code className="min-w-0 truncate">{baseBranch}</code>
        <TriangleAlert aria-hidden className={cn(icon, "shrink-0")} />
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-80 p-2">
        <p className="text-xs text-foreground">{summary}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">It can be updated cleanly.</p>
        {freshness.methods.length > 0 ? (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {freshness.methods.map((method) => (
              <Button
                key={method}
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => onUpdate(method)}
              >
                <GitMerge aria-hidden className="size-3" />
                {method === "rebase" ? "Update with rebase" : "Update branch"}
              </Button>
            ))}
          </span>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Text that copies itself when pressed, and says so. */
export function CopyableCode({
  value,
  copyLabel,
  className,
}: {
  value: string;
  copyLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(value))) {
      toast.error("Could not copy to the clipboard");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <CopyButton
            placement={className}
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : `${copyLabel}: ${value}`}
          />
        }
      >
        <code
          className={cn(
            "col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-150",
            copied ? "opacity-0" : "opacity-100",
          )}
        >
          {value}
        </code>
        <span
          aria-hidden
          className={cn(
            "col-start-1 row-start-1 truncate text-center transition-opacity duration-150",
            copied ? "opacity-100" : "opacity-0",
          )}
        >
          Copied
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {copied ? "Copied" : copyLabel}: {value}
      </TooltipContent>
    </Tooltip>
  );
}

// ── body and condensed row ──────────────────────────────────────────────

function fileCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;
}

/** Title, who opened it and when, the checkout command, then base ← head
 *  with the size of the change. */
export function PullRequestHeaderBody({
  repoPath,
  detail,
  freshness,
  pending,
  onUpdate,
}: {
  repoPath: string;
  detail: PrDetail;
  freshness: BaseFreshness | null;
  pending: boolean;
  onUpdate: (method: PrUpdateMethod) => void;
}) {
  return (
    <div className="mt-1 min-w-0 px-4 pb-4">
      <PullRequestTitleEditor repoPath={repoPath} detail={detail} />
      <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <MetaLine className="min-w-0 whitespace-nowrap">
          <ActorLabel key="author" actor={detail.author} />
          <span key="updated" title={new Date(detail.updatedAt).toLocaleString()}>
            updated {timeAgo(detail.updatedAt, { suffix: true })}
          </span>
        </MetaLine>
        {detail.state === "open" ? (
          <CopyableCode
            value={checkoutCommand(detail.number)}
            copyLabel="Copy checkout command"
            className="ml-auto font-mono"
          />
        ) : null}
      </div>
      <div className="mt-4 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono">
          <BaseBranch
            baseBranch={detail.baseBranch}
            freshness={freshness}
            pending={pending}
            onUpdate={onUpdate}
          />
          <ArrowLeft aria-label="receives changes from" className="size-3.5 shrink-0 opacity-60" />
          <CopyableCode value={detail.headBranch} copyLabel="Copy branch name" />
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
          <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
            <FileDiff aria-hidden className="size-3.5" />
            {fileCount(detail.changedFiles)}
          </span>
          <DiffStat additions={detail.additions} deletions={detail.deletions} />
        </span>
      </div>
    </div>
  );
}

export function PullRequestCondensedRow({
  detail,
  freshness,
  pending,
  onUpdate,
}: {
  detail: PrDetail;
  freshness: BaseFreshness | null;
  pending: boolean;
  onUpdate: (method: PrUpdateMethod) => void;
}) {
  return (
    <div className="min-w-0 px-4 pt-1 pb-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          <ActorLabel actor={detail.author} variant="avatar" className="shrink-0" />
          <span className="shrink-0">{timeAgo(detail.updatedAt)}</span>
        </span>
        <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-2xs">
          <BaseBranch
            baseBranch={detail.baseBranch}
            freshness={freshness}
            pending={pending}
            onUpdate={onUpdate}
            compact
          />
          <ArrowLeft aria-label="receives changes from" className="size-3 shrink-0 opacity-60" />
          <code className="min-w-0 flex-1 truncate" title={detail.headBranch}>
            {detail.headBranch}
          </code>
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2 text-2xs">
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            aria-label={`${fileCount(detail.changedFiles)} changed`}
          >
            <FileDiff aria-hidden className="size-3" />
            {detail.changedFiles.toLocaleString()}
          </span>
          <DiffStat additions={detail.additions} deletions={detail.deletions} />
        </span>
      </div>
    </div>
  );
}

/** The state glyph and word as a pill, for a merged or closed pull request
 *  where the header's primary control would otherwise be. */
export function StatePill({ presentation }: { presentation: StatePresentation }): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex h-control-xs shrink-0 items-center gap-1 rounded border border-border px-1.5 text-2xs font-medium",
        presentation.toneClassName,
      )}
    >
      <presentation.Icon aria-hidden className="size-3.5" />
      {presentation.label}
    </span>
  );
}
