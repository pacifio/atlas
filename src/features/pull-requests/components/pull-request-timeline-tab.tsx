// The Timeline tab: the pull request's whole history down one rail —
// commits, comments, reviews and every state change — newest or oldest
// first. Runs of comments fold into one row with a count, as do runs of
// commits, one person's label changes, review requests and force-pushes.
//
// Long histories: the model is built once per read (`useMemo`), each row is
// memoised, and every row is `content-visibility: auto`, so the browser
// skips style, layout and paint for rows off screen and nothing runs per
// event on scroll. Comment bodies mount only once their row is opened.

import { memo, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  ArrowDownUp,
  ChevronDown,
  CircleCheck,
  ExternalLink,
  Eye,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  GitMerge,
  MessageSquare,
  Tag,
  Upload,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import { classifyPrError } from "../lib/pr-errors";
import { latestReviewOutcomes, reviewOutcome, type ReviewOutcome } from "../lib/pull-request-logic";
import {
  buildTimeline,
  forcePushSpan,
  groupTimeline,
  isStaleVerdict,
  newestCommitTime,
  shortOid,
  uniqueActors,
  type TimelineEvent,
  type TimelineOrder,
  type TimelineRow,
  type TimelineThread,
} from "../lib/pull-request-timeline";
import { usePrTimelineHistory } from "../lib/pull-requests-queries";
import type { PrActivity, PrActor, PrDetail, PrError, PrLabel } from "../lib/pull-requests-types";
import { PullRequestCommentActions } from "./pull-request-comment-actions";
import { PullRequestMarkdown } from "./pull-request-markdown";
import {
  ActorAvatar,
  actorTitle,
  DiffStat,
  LabelChip,
  MetaLine,
  ReviewOutcomeIcon,
  reviewOutcomeLabel,
  reviewOutcomeToneClassName,
  STATE_PRESENTATION,
} from "./pull-request-presentation";
import { ReactionBar } from "./pull-request-reactions";
import { ActivityUnavailableState } from "./pull-request-states";

/** Offscreen rows skip rendering; this is the height each is assumed to
 *  have until it is first laid out. */
const ROW =
  "relative mb-5 pl-12 [contain-intrinsic-block-size:auto_48px] [content-visibility:auto]";

/** Commit runs longer than this start folded. */
const OPEN_COMMIT_RUN = 5;

// ── pieces ──────────────────────────────────────────────────────────────

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {timeAgo(at, { suffix: true })}
    </time>
  );
}

function ActorName({ actor }: { actor: PrActor | null }) {
  return (
    <span className="font-semibold text-foreground" title={actorTitle(actor)}>
      {actor?.login ?? "ghost"}
    </span>
  );
}

function Sha({ oid }: { oid: string | null | undefined }) {
  const short = shortOid(oid);
  return short ? (
    <code className="font-mono text-2xs text-secondary-foreground" title={oid ?? undefined}>
      {short}
    </code>
  ) : null;
}

function TimelineMarker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "absolute top-1/2 left-0 z-10 flex size-8 -translate-y-1/2 items-center justify-center bg-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

function IconMarker({
  icon: Icon,
  toneClassName,
  className,
}: {
  icon: LucideIcon;
  toneClassName?: string;
  className?: string;
}) {
  return (
    <TimelineMarker className={className}>
      <span className="flex size-7 items-center justify-center rounded-full border border-border bg-background">
        <Icon aria-hidden className={cn("size-3.5 text-muted-foreground", toneClassName)} />
      </span>
    </TimelineMarker>
  );
}

function ActorMarker({
  actors,
  fallback,
  className,
  muted = false,
}: {
  actors: readonly PrActor[];
  fallback: LucideIcon;
  className?: string;
  muted?: boolean;
}) {
  const actor = actors[0];
  if (!actor) return <IconMarker icon={fallback} className={className} />;
  return (
    <TimelineMarker className={className}>
      <ActorAvatar
        actor={actor}
        className={cn("size-7 text-2xs transition-opacity", muted && "opacity-45 grayscale")}
      />
    </TimelineMarker>
  );
}

function OpenOnHost({ url }: { url: string | null }) {
  return url ? (
    <IconButton
      icon={ExternalLink}
      label="Open on GitHub"
      size="xs"
      variant="ghost"
      onClick={() => openPullRequest(url)}
    />
  ) : null;
}

function reviewStateLabel(state: string): string {
  const words = state.toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function TimelineBody({ body }: { body: string }) {
  return (
    <div className="mt-2 min-w-0">
      <PullRequestMarkdown text={body} />
    </div>
  );
}

// ── comments ────────────────────────────────────────────────────────────

function ConversationCard({
  event,
  canReact,
  showPath = true,
}: {
  event: TimelineEvent;
  canReact: boolean;
  showPath?: boolean;
}) {
  return (
    <article className="group py-2">
      <div className="flex min-w-0 flex-wrap items-start gap-2 px-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <ActorName actor={event.actor} />
            <span className="text-muted-foreground">
              {event.kind === "review" ? "reviewed" : "commented"}
            </span>
            {event.reviewState && event.kind === "review" ? (
              <span className="text-2xs font-medium text-muted-foreground">
                {reviewStateLabel(event.reviewState)}
              </span>
            ) : null}
          </div>
          <MetaLine className="mt-1 flex-wrap text-2xs text-muted-foreground">
            <When at={event.at} />
            {event.editedAt ? <span>edited</span> : null}
            {showPath && event.path ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <FileCode2 aria-hidden className="size-3 shrink-0" />
                <span className="truncate font-mono">{event.path}</span>
              </span>
            ) : null}
          </MetaLine>
        </div>
        {event.comment && (canReact || event.reactions.length > 0) ? (
          <ReactionBar
            className="ml-auto justify-end"
            reactions={event.reactions}
            canReact={canReact}
            subjectId={event.id}
          />
        ) : null}
        <OpenOnHost url={event.url} />
      </div>
      <PullRequestCommentActions className="px-2" comment={event.comment}>
        {event.body ? <TimelineBody body={event.body} /> : null}
      </PullRequestCommentActions>
    </article>
  );
}

function FoldButton({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-3 py-2 text-left transition-opacity hover:opacity-100",
        open ? "text-foreground opacity-100" : "text-muted-foreground opacity-70",
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

function ConversationGroup({ events, canReact }: { events: TimelineEvent[]; canReact: boolean }) {
  const [open, setOpen] = useState(false);
  const actors = uniqueActors(events);
  const first = events[0];
  return (
    <div className={ROW}>
      <ActorMarker actors={actors} fallback={MessageSquare} className="top-6" muted={!open} />
      <FoldButton open={open} onToggle={() => setOpen(!open)}>
        <span className="block text-xs font-semibold">
          {count(events.length, "comment", "comments")}
        </span>
        <span className="block truncate text-2xs text-muted-foreground">
          {actors.length > 0
            ? `${actors
                .slice(0, 3)
                .map((a) => a.login)
                .join(", ")}${actors.length > 3 ? ` +${actors.length - 3}` : ""} · `
            : ""}
          <When at={first.at} />
        </span>
      </FoldButton>
      {open ? (
        <div className="mt-1 space-y-1">
          {events.map((event) => (
            <ConversationCard key={event.id} event={event} canReact={canReact} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MoreReplies({ thread }: { thread: TimelineThread }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 px-2 py-1 text-xs text-muted-foreground">
      <span>
        {thread.moreReplies > 0
          ? `${count(thread.moreReplies, "more reply", "more replies")}`
          : "More replies"}
      </span>
      {thread.url ? (
        <button
          type="button"
          onClick={() => openPullRequest(thread.url!)}
          className="cursor-pointer hover:text-foreground hover:underline"
        >
          View on GitHub
        </button>
      ) : null}
    </div>
  );
}

function ReviewThreadEvent({
  event,
  thread,
  canReact,
}: {
  event: TimelineEvent;
  thread: TimelineThread;
  canReact: boolean;
}) {
  const dismissed = reviewOutcome(event.reviewState) === "dismissed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !dismissed);
  const replyCount = thread.replies.length + thread.moreReplies;
  const location = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  return (
    <div className={cn(ROW, "group")}>
      <ActorMarker
        actors={event.actor ? [event.actor] : []}
        fallback={MessageSquare}
        className="top-6"
        muted={!expanded}
      />
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2 py-2 text-left text-2xs text-muted-foreground hover:text-foreground"
      >
        <FileCode2 aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono" title={location}>
          {location}
        </span>
        {thread.isResolved ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success">
            <CircleCheck aria-hidden className="size-3" />
            Resolved
          </span>
        ) : null}
        {dismissed ? <span className="shrink-0 font-medium">Review dismissed</span> : null}
        {thread.isOutdated ? <span className="shrink-0 font-medium">Outdated</span> : null}
        {expanded ? null : (
          <span className="shrink-0">
            · {event.actor?.login ?? "ghost"}
            {replyCount > 0 ? ` · ${count(replyCount, "reply", "replies")}` : null}
          </span>
        )}
        <ChevronDown
          aria-hidden
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <>
          <ConversationCard event={event} canReact={canReact} showPath={false} />
          {thread.replies.length > 0 ? (
            <div className="ml-2 space-y-1 border-l border-border pl-3">
              {thread.replies.map((reply) => (
                <ConversationCard
                  key={reply.id}
                  event={reply}
                  canReact={canReact}
                  showPath={false}
                />
              ))}
            </div>
          ) : null}
          {thread.hasMoreReplies ? <MoreReplies thread={thread} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** A verdict given before the newest commits: quiet, explained on hover. */
function StaleVerdictLabel(props: ComponentProps<"span">) {
  return <span {...props} className="cursor-help font-medium text-muted-foreground" />;
}

function ReviewVerdictEvent({
  event,
  outcome,
  stale,
  canReact,
}: {
  event: TimelineEvent;
  outcome: ReviewOutcome;
  stale: boolean;
  canReact: boolean;
}) {
  const label = reviewOutcomeLabel(outcome).toLowerCase();
  return (
    <div className={cn(ROW, "group")}>
      <ActorMarker
        actors={event.actor ? [event.actor] : []}
        fallback={MessageSquare}
        className="top-6"
      />
      <div className="flex min-w-0 flex-wrap items-start gap-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <ActorName actor={event.actor} />
            <ReviewOutcomeIcon outcome={outcome} />
            {stale ? (
              <Tooltip>
                <TooltipTrigger render={<StaleVerdictLabel />}>
                  {label}
                  <span className="sr-only">, before the latest commits</span>
                </TooltipTrigger>
                <TooltipContent side="top">{reviewOutcomeLabel(outcome, true)}</TooltipContent>
              </Tooltip>
            ) : (
              <span className={cn("font-medium", reviewOutcomeToneClassName(outcome))}>
                {label}
              </span>
            )}
          </div>
          <MetaLine className="mt-0.5 flex-wrap text-2xs text-muted-foreground">
            <When at={event.at} />
            {event.editedAt ? <span>edited</span> : null}
          </MetaLine>
        </div>
        {event.comment && (canReact || event.reactions.length > 0) ? (
          <ReactionBar
            className="ml-auto justify-end"
            reactions={event.reactions}
            canReact={canReact}
            subjectId={event.id}
          />
        ) : null}
        <OpenOnHost url={event.url} />
      </div>
      <PullRequestCommentActions comment={event.comment}>
        {event.body ? <TimelineBody body={event.body} /> : null}
      </PullRequestCommentActions>
    </div>
  );
}

// ── commits ─────────────────────────────────────────────────────────────

function CommitLine({
  event,
  onViewCommit,
}: {
  event: TimelineEvent;
  onViewCommit?: (oid: string) => void;
}) {
  const commit = event.commit!;
  const content = (
    <span className="flex min-w-0 items-center gap-2.5 py-1">
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs font-medium text-foreground",
            onViewCommit && "group-hover/commit:text-primary",
          )}
        >
          {commit.headline || "Untitled commit"}
        </span>
        <MetaLine className="mt-0.5 flex-wrap text-2xs text-muted-foreground">
          <Sha oid={commit.oid} />
          <span className="truncate">
            {commit.authors.map((a) => a.login).join(", ") || "unknown author"}
          </span>
          <When at={event.at} />
        </MetaLine>
      </span>
      {commit.additions !== null && commit.deletions !== null ? (
        <DiffStat
          additions={commit.additions}
          deletions={commit.deletions}
          className="ml-auto shrink-0 text-2xs"
        />
      ) : null}
    </span>
  );
  // Step 4's commit picker hands this in; until then a commit only reads.
  return onViewCommit ? (
    <button
      type="button"
      aria-label={`View commit ${commit.oid.slice(0, 7)} in Code`}
      onClick={() => onViewCommit(commit.oid)}
      className="group/commit block w-full min-w-0 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {content}
    </button>
  ) : (
    <div className="min-w-0">{content}</div>
  );
}

function CommitRun({
  events,
  onViewCommit,
}: {
  events: TimelineEvent[];
  onViewCommit?: (oid: string) => void;
}) {
  const [open, setOpen] = useState(events.length <= OPEN_COMMIT_RUN);
  const authors = uniqueActors(events);
  if (events.length === 1) {
    return (
      <div className={ROW}>
        <ActorMarker actors={authors} fallback={GitCommitHorizontal} />
        <CommitLine event={events[0]} onViewCommit={onViewCommit} />
      </div>
    );
  }
  return (
    <div className={ROW}>
      <IconMarker icon={GitCommitHorizontal} className="top-6" />
      <FoldButton open={open} onToggle={() => setOpen(!open)}>
        <span className="block text-xs font-semibold">
          {count(events.length, "commit", "commits")}
        </span>
        <span className="block truncate text-2xs text-muted-foreground">
          {authors
            .slice(0, 3)
            .map((a) => a.login)
            .join(", ")}
          {authors.length > 3 ? ` +${authors.length - 3}` : ""} · <When at={events[0].at} />
        </span>
      </FoldButton>
      {open ? (
        <div className="space-y-0.5 border-l border-border pl-3">
          {events.map((event) => (
            <CommitLine key={event.id} event={event} onViewCommit={onViewCommit} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── state changes ───────────────────────────────────────────────────────

function StateChange({
  icon,
  toneClassName,
  actor,
  at,
  children,
}: {
  icon: LucideIcon;
  toneClassName?: string;
  actor: PrActor | null;
  at: string;
  children: ReactNode;
}) {
  return (
    <div className={ROW}>
      <IconMarker icon={icon} toneClassName={toneClassName} />
      <div className="py-1.5 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {actor ? <ActorName actor={actor} /> : null}
          <span className="text-muted-foreground">{children}</span>
        </div>
        <div className="mt-0.5 text-2xs text-muted-foreground">
          <When at={at} />
        </div>
      </div>
    </div>
  );
}

function LifecycleEvent({ event, detail }: { event: TimelineEvent; detail: PrDetail }) {
  const { actor, at } = event;
  switch (event.kind) {
    case "opened":
      return (
        <StateChange icon={GitPullRequestArrow} toneClassName="text-success" actor={actor} at={at}>
          opened this pull request
        </StateChange>
      );
    case "merged":
      return (
        <StateChange
          icon={STATE_PRESENTATION.merged.Icon}
          toneClassName={STATE_PRESENTATION.merged.toneClassName}
          actor={actor}
          at={at}
        >
          merged {event.mergeCommitOid ? <Sha oid={event.mergeCommitOid} /> : "this"}
          {event.baseBranch ? (
            <>
              {" "}
              into <code className="font-mono text-2xs">{event.baseBranch}</code>
            </>
          ) : null}
        </StateChange>
      );
    case "closed":
      return (
        <StateChange
          icon={GitPullRequestClosed}
          toneClassName={STATE_PRESENTATION.closed.toneClassName}
          actor={actor}
          at={at}
        >
          closed this pull request
        </StateChange>
      );
    case "reopened":
      return (
        <StateChange icon={GitPullRequestArrow} toneClassName="text-success" actor={actor} at={at}>
          reopened this pull request
        </StateChange>
      );
    case "ready-for-review":
      return (
        <StateChange icon={Eye} actor={actor} at={at}>
          marked this pull request as ready for review
        </StateChange>
      );
    case "converted-to-draft":
      return (
        <StateChange icon={GitPullRequestDraft} actor={actor} at={at}>
          marked this pull request as a draft
        </StateChange>
      );
    case "head-ref-deleted":
      return (
        <StateChange icon={GitBranch} actor={actor} at={at}>
          deleted the <code className="font-mono text-2xs">{detail.headBranch}</code> branch
        </StateChange>
      );
    default:
      return (
        <StateChange icon={GitMerge} actor={actor} at={at}>
          {event.kind}
        </StateChange>
      );
  }
}

function Labels({ labels }: { labels: PrLabel[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
    </span>
  );
}

function LabelsChange({ row }: { row: TimelineRow & { kind: "labels" } }) {
  return (
    <StateChange icon={Tag} actor={row.actor} at={row.at}>
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {row.added.length > 0 ? (
          <>
            added <Labels labels={row.added} />
          </>
        ) : null}
        {row.added.length > 0 && row.removed.length > 0 ? "and" : null}
        {row.removed.length > 0 ? (
          <>
            removed <Labels labels={row.removed} />
          </>
        ) : null}
      </span>
    </StateChange>
  );
}

function ReviewRequests({ row }: { row: TimelineRow & { kind: "review-requests" } }) {
  return (
    <StateChange icon={UserPlus} actor={row.actor} at={row.at}>
      requested a review from{" "}
      {row.reviewers.map((reviewer, index) => (
        <span key={reviewer?.login ?? `gone:${index}`}>
          {index > 0 ? (index === row.reviewers.length - 1 ? " and " : ", ") : null}
          {reviewer ? (
            <span className="font-medium text-foreground" title={actorTitle(reviewer)}>
              {reviewer.login}
            </span>
          ) : (
            "someone no longer visible"
          )}
        </span>
      ))}
    </StateChange>
  );
}

function ForcePushes({ row }: { row: TimelineRow & { kind: "force-pushes" } }) {
  const { beforeOid, afterOid } = forcePushSpan(row.events);
  const latest = row.events.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
  return (
    <StateChange icon={Upload} actor={row.actor} at={latest.at}>
      force-pushed
      {row.events.length > 1 ? ` ${count(row.events.length, "time", "times")}` : ""}
      {beforeOid || afterOid ? (
        <>
          {beforeOid ? (
            <>
              {" "}
              from <Sha oid={beforeOid} />
            </>
          ) : null}
          {afterOid ? (
            <>
              {" "}
              to <Sha oid={afterOid} />
            </>
          ) : null}
        </>
      ) : null}
    </StateChange>
  );
}

// ── rows ────────────────────────────────────────────────────────────────

const Row = memo(function Row({
  row,
  detail,
  canReact,
  newestCommit,
  onViewCommit,
}: {
  row: TimelineRow;
  detail: PrDetail;
  canReact: boolean;
  newestCommit: string | null;
  onViewCommit?: (oid: string) => void;
}) {
  switch (row.kind) {
    case "comments":
      return <ConversationGroup events={row.events} canReact={canReact} />;
    case "commits":
      return <CommitRun events={row.events} onViewCommit={onViewCommit} />;
    case "labels":
      return <LabelsChange row={row} />;
    case "review-requests":
      return <ReviewRequests row={row} />;
    case "force-pushes":
      return <ForcePushes row={row} />;
    case "event": {
      const { event } = row;
      if (event.thread) {
        return <ReviewThreadEvent event={event} thread={event.thread} canReact={canReact} />;
      }
      const outcome = event.kind === "review" ? reviewOutcome(event.reviewState) : null;
      if (outcome) {
        return (
          <ReviewVerdictEvent
            event={event}
            outcome={outcome}
            stale={isStaleVerdict(event, newestCommit)}
            canReact={canReact}
          />
        );
      }
      return <LifecycleEvent event={event} detail={detail} />;
    }
  }
});

function TimelineGhost() {
  return (
    <div role="status" aria-label="Loading the timeline" className="animate-pulse">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="relative mb-5 flex items-center gap-4">
          <span aria-hidden className="size-7 shrink-0 rounded-full bg-muted" />
          <span className="flex-1 space-y-2">
            <span
              aria-hidden
              className={cn("block h-3 rounded bg-muted", index % 2 ? "w-1/2" : "w-2/3")}
            />
            <span aria-hidden className="block h-2.5 w-20 rounded bg-muted" />
          </span>
        </div>
      ))}
    </div>
  );
}

// ── the tab bar's counts and order ──────────────────────────────────────

/** Beside the Timeline tab: comments · commits (and approvals, when any
 *  stand), then the order toggle. The counts dim while the conversation
 *  loads, and say "—" when it could not be read. */
export function TimelineCounts({
  detail,
  activity,
  pending,
  error,
  order,
  onOrderChange,
}: {
  detail: Pick<PrDetail, "commitCount">;
  activity: PrActivity | null;
  pending: boolean;
  error: PrError | null;
  order: TimelineOrder;
  onOrderChange: (order: TimelineOrder) => void;
}) {
  const comments = activity?.commentCount ?? 0;
  const commits = detail.commitCount;
  const approvals =
    activity && !activity.commentsTruncated
      ? latestReviewOutcomes(activity.comments, activity.commits).filter(
          (entry) => entry.outcome === "approved" && !entry.stale,
        ).length
      : 0;
  const shown = (n: number) => (error ? "—" : pending ? "…" : n.toLocaleString());
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      <MetaLine
        className={cn(
          "text-2xs whitespace-nowrap transition-opacity",
          (pending || error) && "opacity-40",
        )}
      >
        <span
          key="comments"
          className="inline-flex items-center gap-1 tabular-nums"
          aria-label={error ? "Comments unavailable" : count(comments, "comment", "comments")}
        >
          <MessageSquare aria-hidden className="size-3" />
          {shown(comments)}
        </span>
        <span
          key="commits"
          className="inline-flex items-center gap-1 tabular-nums"
          aria-label={count(commits, "commit", "commits")}
        >
          <GitCommitHorizontal aria-hidden className="size-3" />
          {commits.toLocaleString()}
        </span>
        {approvals > 0 ? (
          <span
            key="approvals"
            className={cn(
              "inline-flex items-center gap-1 tabular-nums",
              reviewOutcomeToneClassName("approved"),
            )}
            aria-label={count(approvals, "approval", "approvals")}
          >
            <CircleCheck aria-hidden className="size-3" />
            {approvals.toLocaleString()}
          </span>
        ) : null}
      </MetaLine>
      <Button
        size="xs"
        variant="ghost"
        aria-label={
          order === "newest" ? "Show oldest activity first" : "Show newest activity first"
        }
        onClick={() => onOrderChange(order === "newest" ? "oldest" : "newest")}
      >
        <ArrowDownUp aria-hidden className="size-3" />
        {order === "newest" ? "Newest first" : "Oldest first"}
      </Button>
    </div>
  );
}

// ── the tab ─────────────────────────────────────────────────────────────

export function PullRequestTimelineTab({
  scrollerRef,
  repoPath,
  detail,
  activity,
  order,
  onViewCommit,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  repoPath: string;
  detail: PrDetail;
  /** Reactions, edit marks, review threads and commit stats; the history
   *  reads without it. */
  activity: PrActivity | null;
  /** Newest or oldest first: the tab bar's toggle (`TimelineCounts`). */
  order: TimelineOrder;
  /** Opens one commit in the Code tab. */
  onViewCommit?: (oid: string) => void;
}) {
  const history = usePrTimelineHistory(repoPath, detail.number);
  const items = history.data?.items;
  const events = useMemo(() => (items ? buildTimeline(items, activity) : []), [items, activity]);
  const rows = useMemo(() => groupTimeline(events, order), [events, order]);
  const newestCommit = useMemo(() => newestCommitTime(events), [events]);
  const canReact = detail.capabilities.reactions;

  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto pb-20" data-pr-timeline-scroll>
      <div className="mx-auto max-w-3xl px-4 pt-6">
        {history.isPending ? (
          <TimelineGhost />
        ) : !history.data ? (
          <ActivityUnavailableState
            title="Could not load the timeline"
            error={classifyPrError(history.error)}
            onRetry={() => void history.refetch()}
          />
        ) : (
          <>
            {history.data.truncated ? (
              <p className="mb-4 rounded-md border border-warning bg-warning-muted px-2 py-1.5 text-xs">
                This history is longer than Atlas reads: the oldest{" "}
                {history.data.items.length.toLocaleString()} events are here; open the pull request
                on GitHub for the rest.
              </p>
            ) : null}
            {rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <GitPullRequestArrow aria-hidden className="mb-2 size-5" />
                <p className="text-xs">No activity yet.</p>
              </div>
            ) : (
              <div className="relative">
                <span aria-hidden className="absolute top-1 bottom-5 left-[15px] w-px bg-border" />
                {rows.map((row) => (
                  <Row
                    key={row.key}
                    row={row}
                    detail={detail}
                    canReact={canReact}
                    newestCommit={newestCommit}
                    onViewCommit={onViewCommit}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
