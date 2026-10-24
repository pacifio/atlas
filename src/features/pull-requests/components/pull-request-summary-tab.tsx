// The Summary tab: who reviews it and how they ruled, its labels, the
// description (editable in place), the checks, and the conversation —
// filtered (bots, finished threads), sorted, and paged ten at a time.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Hammer,
  ListFilter,
  Tag,
  Users,
} from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import { classifyPrError } from "../lib/pr-errors";
import {
  canEditPullRequest,
  checkStatusLabel,
  conversationItems,
  filterConversation,
  findingKey,
  isFinished,
  itemComments,
  latestReviewOutcomes,
  orderByTime,
  pageConversation,
  reviewOutcome,
  sectionCollapseAnchorScrollTop,
  visibleBody,
  bodyPreview,
  type CommentFilter,
  type ConversationItem,
  type Finding,
} from "../lib/pull-request-logic";
import { saveCommentFilter, savedCommentFilter } from "../lib/pull-request-prefs";
import { usePrUpdateMutation } from "../lib/pull-requests-queries";
import type {
  PrActivity,
  PrComment,
  PrDetail,
  PrError,
  PrReviewThread,
} from "../lib/pull-requests-types";
import type { PullRequestAgentActions } from "../lib/use-pull-request-agent-actions";
import { readableFailure } from "../lib/use-pull-request-actions";
import {
  EditButton,
  PullRequestMarkdown,
  PullRequestMarkdownEditor,
} from "./pull-request-markdown";
import {
  ActorLabel,
  actorTitle,
  CheckStatusIcon,
  LabelChip,
  ReviewOutcomeBadge,
  reviewOutcomeLabel,
  reviewOutcomeRingClassName,
} from "./pull-request-presentation";
import { LabelPicker, ReviewerPicker } from "./pull-request-pickers";
import { ReactionBar } from "./pull-request-reactions";
import { ActivityUnavailableState, ConversationGhost } from "./pull-request-states";
import { PullRequestCommentActions } from "./pull-request-comment-actions";
import { CheckLogButton } from "./pull-request-check-log";
import { VerdictRing } from "./pull-request-triggers";

export const COMMENT_PAGE = 10;
const CLAMP_PX = 240;

// ── pieces ──────────────────────────────────────────────────────────────

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-6 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

/** A collapsible section whose heading sticks while its body scrolls past.
 *  Collapsing it while pinned keeps the heading where it was pressed. */
function Section({
  title,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headingRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const toggle = () => {
    if (open) {
      const heading = headingRef.current;
      const section = heading?.closest<HTMLElement>("[data-pr-summary-section]");
      const scroller = heading?.closest<HTMLElement>("[data-pr-summary-scroll]");
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        });
        if (target !== null) scroller.scrollTop = target;
      }
    }
    setOpen(!open);
  };
  return (
    <section aria-label={title} data-pr-summary-section>
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex w-full items-center bg-background pr-4"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <span>{title}</span>
          <ChevronRight
            aria-hidden
            className={cn("size-3.5 opacity-60 transition-transform", open && "rotate-90")}
          />
        </button>
        {actions}
      </div>
      <div id={bodyId} hidden={!open} className="px-4 pb-4">
        {open ? children : null}
      </div>
    </section>
  );
}

/** A long comment is clamped to a screenful with a fade, and opens on request. */
function ClampedMarkdown({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.getBoundingClientRect().height > CLAMP_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={cn("min-w-0", className)}>
      <div className={cn("relative", !expanded && "max-h-60 overflow-hidden")}>
        <div ref={content}>
          <PullRequestMarkdown text={text} />
        </div>
        {overflowing && !expanded ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
          />
        ) : null}
      </div>
      {overflowing ? (
        <Button
          size="xs"
          variant="ghost"
          className="mt-2"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show full comment"}
        </Button>
      ) : null}
    </div>
  );
}

function CommentIdentity({ comment }: { comment: PrComment }) {
  const when = timeAgo(comment.createdAt, { suffix: true });
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <ActorLabel actor={comment.author} className="max-w-full" />
      {comment.url ? (
        <button
          type="button"
          onClick={() => openPullRequest(comment.url!)}
          title={`${new Date(comment.createdAt).toLocaleString()} · open on GitHub`}
          className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
        >
          <time dateTime={comment.createdAt}>{when}</time>
        </button>
      ) : (
        <time
          dateTime={comment.createdAt}
          title={new Date(comment.createdAt).toLocaleString()}
          className="text-muted-foreground"
        >
          {when}
        </time>
      )}
      {comment.editedAt ? <span className="text-muted-foreground">edited</span> : null}
    </div>
  );
}

function CommentLocation({ comment, thread }: { comment: PrComment; thread?: PrReviewThread }) {
  const path = thread?.path ?? comment.path;
  if (!path) return null;
  const label = `${path}${thread?.line ? `:${thread.line}` : ""}`;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="truncate font-mono" title={label}>
        {label}
      </span>
      {thread?.isOutdated ? <span className="shrink-0">Outdated</span> : null}
    </div>
  );
}

function reviewStateLabel(state: string): string {
  const words = state.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function MoreReplies({ count, url }: { count: number; url: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {count > 0
          ? `${count.toLocaleString()} more ${count === 1 ? "reply" : "replies"}`
          : "More replies"}
      </span>
      {url ? (
        <button
          type="button"
          onClick={() => openPullRequest(url)}
          className="cursor-pointer hover:text-foreground hover:underline"
        >
          View on GitHub
        </button>
      ) : null}
    </div>
  );
}

// ── the tab ─────────────────────────────────────────────────────────────

export function PullRequestSummaryTab({
  scrollerRef,
  repoPath,
  detail,
  activity,
  activityPending,
  activityError,
  onRetryActivity,
  agent,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  repoPath: string;
  detail: PrDetail;
  activity: PrActivity | null;
  activityPending: boolean;
  activityError: PrError | null;
  onRetryActivity: () => void;
  agent: PullRequestAgentActions;
}) {
  const update = usePrUpdateMutation(repoPath, detail.number);
  const [editingBody, setEditingBody] = useState(false);
  const [shownCount, setShownCount] = useState(COMMENT_PAGE);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [filter, setFilterState] = useState<CommentFilter>(savedCommentFilter);
  const setFilter = (next: CommentFilter) => {
    setFilterState(next);
    saveCommentFilter(next);
  };

  const comments = activity?.comments ?? [];
  const items = conversationItems(comments, activity?.reviewThreads ?? []);
  const filtered = filterConversation(items, filter);
  const countOf = (list: readonly ConversationItem[]) =>
    list.reduce((n, item) => n + itemComments(item).length, 0);
  const loadedCount = countOf(items);
  const hiddenByFilter = loadedCount - countOf(filtered);
  const { shown, hidden } = pageConversation(filtered, shownCount);
  const visible = orderByTime(shown, order);

  // Every verdict, read from the whole conversation rather than the window
  // shown: a review older than the visible comments still stands.
  const outcomes = latestReviewOutcomes(comments, activity?.commits ?? []);
  const outcomeByLogin = new Map(
    outcomes.flatMap((entry) => (entry.actor ? [[entry.actor.login.toLowerCase(), entry]] : [])),
  );
  const requested = new Set(detail.reviewers.map((r) => r.actor.login.toLowerCase()));
  const reviewerEntries = [
    ...detail.reviewers.map((reviewer) => {
      const entry = outcomeByLogin.get(reviewer.actor.login.toLowerCase());
      return {
        key: `${reviewer.kind}:${reviewer.actor.login}`,
        actor: reviewer.actor,
        outcome: entry?.outcome ?? null,
        stale: entry?.stale ?? false,
      };
    }),
    // Someone who ruled without being asked; GitHub drops a reviewer from the
    // requested list once they have reviewed.
    ...outcomes
      .filter((entry) => entry.actor && !requested.has(entry.actor.login.toLowerCase()))
      .map((entry) => ({
        key: entry.key,
        actor: entry.actor,
        outcome: entry.outcome,
        stale: entry.stale,
      })),
  ];

  const saveBody = (body: string) => {
    update.mutate(
      { title: null, body },
      {
        onSuccess: () => setEditingBody(false),
        onError: (raw) =>
          toast.error("Could not save the description", {
            description: readableFailure(classifyPrError(raw), "GitHub refused the change."),
          }),
      },
    );
  };

  const canReact = detail.capabilities.reactions;

  const fixButton = (finding: Finding) =>
    agent.fixFinding ? (
      <Button
        size="xs"
        variant="ghost"
        disabled={agent.pending !== null}
        onClick={() => agent.fixFinding?.(finding)}
      >
        <Hammer aria-hidden className="size-3" />
        {agent.pending === findingKey(finding) ? "Preparing…" : agent.fixLabel}
      </Button>
    ) : null;

  const commentCard = (comment: PrComment, thread: PrReviewThread | undefined, reply = false) => {
    const body = visibleBody(comment.body);
    const outcome = reviewOutcome(comment.reviewState);
    const finding: Finding | null =
      reply ||
      (comment.kind !== "review" && comment.kind !== "review-comment") ||
      outcome === "approved"
        ? null
        : thread
          ? { kind: "thread", thread }
          : body
            ? { kind: "comment", comment }
            : null;
    return (
      <article
        key={comment.id}
        // Offscreen comments skip style, layout and paint: bot comments carry
        // pages of highlighted code, and a long conversation has hundreds.
        className="group rounded-lg border border-border bg-background [contain-intrinsic-block-size:160px] [content-visibility:auto]"
      >
        <div className="flex flex-wrap items-baseline gap-2 rounded-t-lg bg-card px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <CommentIdentity comment={comment} />
            {outcome ? (
              <ReviewOutcomeBadge outcome={outcome} />
            ) : comment.reviewState ? (
              <span>{reviewStateLabel(comment.reviewState)}</span>
            ) : null}
          </div>
          {finding ? fixButton(finding) : null}
          <ReactionBar
            className="ml-auto justify-end"
            reactions={comment.reactions}
            canReact={canReact}
            subjectId={comment.id}
          />
        </div>
        {reply ? null : (
          <div className="px-3">
            <CommentLocation comment={comment} thread={thread} />
          </div>
        )}
        <PullRequestCommentActions className="px-3 py-2.5" comment={comment}>
          {body ? <ClampedMarkdown text={body} /> : null}
        </PullRequestCommentActions>
      </article>
    );
  };

  const renderItem = (item: ConversationItem) => {
    const comment = item.kind === "comment" ? item.comment : item.root;
    const thread = item.kind === "thread" ? item.thread : undefined;
    const replies =
      item.kind === "thread" && item.replies.length > 0 ? (
        <div className="ml-4 space-y-2 border-l-2 border-border pl-3">
          {item.replies.map((reply) => commentCard(reply, undefined, true))}
        </div>
      ) : null;
    const more =
      item.kind === "thread" && item.hasMoreReplies ? (
        <MoreReplies count={item.moreReplies} url={item.url} />
      ) : null;
    if (isFinished(comment, thread)) {
      return (
        <FinishedItem
          key={`${item.kind}:${item.id}`}
          comment={comment}
          thread={thread}
          label={thread?.isResolved ? "Resolved" : "Review dismissed"}
          replyCount={item.kind === "thread" ? item.replies.length + item.moreReplies : 0}
          replies={replies}
          more={more}
          reactions={
            <ReactionBar
              className="ml-auto justify-end"
              reactions={comment.reactions}
              canReact={canReact}
              subjectId={comment.id}
            />
          }
        />
      );
    }
    if (item.kind === "comment") return commentCard(comment, undefined);
    return (
      <div key={`thread:${item.id}`} className="space-y-2">
        {commentCard(comment, thread)}
        {replies}
        {more}
      </div>
    );
  };

  const olderButton =
    hidden > 0 ? (
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => setShownCount(shownCount + COMMENT_PAGE)}
      >
        Show {Math.min(hidden, COMMENT_PAGE)} older{" "}
        {hidden === 1 ? "conversation" : "conversations"} ({hidden} hidden)
      </Button>
    ) : null;

  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto pb-20" data-pr-summary-scroll>
      <section className="px-4 pt-2.5 pb-1">
        <div className="space-y-1.5">
          <MetaRow icon={<Users className="size-3.5" />} label="Reviewers">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {reviewerEntries.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex items-center -space-x-1">
                  {reviewerEntries.map((entry) => {
                    const verdict = entry.outcome
                      ? reviewOutcomeLabel(entry.outcome, entry.stale)
                      : null;
                    return (
                      <Tooltip key={entry.key}>
                        <TooltipTrigger
                          render={
                            <VerdictRing
                              ring={
                                entry.outcome
                                  ? reviewOutcomeRingClassName(entry.outcome, entry.stale)
                                  : null
                              }
                            />
                          }
                        >
                          <ActorLabel actor={entry.actor} tooltip={false} variant="avatar" />
                          {verdict ? <span className="sr-only">{verdict}</span> : null}
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          {verdict
                            ? `${actorTitle(entry.actor)} — ${verdict}`
                            : actorTitle(entry.actor)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </span>
              )}
              {detail.capabilities.reviewers.request &&
              detail.capabilities.reviewers.listCandidates ? (
                <ReviewerPicker allowed={detail.viewerPermissions.requestReviewers} />
              ) : null}
            </span>
          </MetaRow>
          {detail.labels.length > 0 || detail.capabilities.labels ? (
            <MetaRow icon={<Tag className="size-3.5" />} label="Labels">
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {detail.labels.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  detail.labels.map((label) => <LabelChip key={label.name} label={label} />)
                )}
                {detail.capabilities.labels ? (
                  <LabelPicker allowed={detail.viewerPermissions.labels} />
                ) : null}
              </span>
            </MetaRow>
          ) : null}
        </div>
      </section>

      <Section
        title="Description"
        actions={
          // The pull request's own reactions sit on the heading, out of the
          // description's way.
          activity ? (
            <ReactionBar
              className="justify-end"
              reactions={activity.reactions}
              canReact={canReact}
              subjectId={null}
              quietAdd={false}
            />
          ) : null
        }
      >
        <div className="group">
          {editingBody ? (
            <PullRequestMarkdownEditor
              allowEmpty
              value={detail.body}
              label="Pull request description"
              placeholder="Describe this pull request"
              saving={update.isPending}
              onSave={saveBody}
              onCancel={() => setEditingBody(false)}
            />
          ) : (
            <div className="flex items-start gap-1">
              <PullRequestMarkdown
                className="min-w-0 flex-1"
                text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
              />
              {canEditPullRequest(detail) ? (
                <EditButton label="Edit description" onClick={() => setEditingBody(true)} />
              ) : null}
            </div>
          )}
        </div>
      </Section>

      <Section title={`Checks (${detail.checks.length})`} defaultOpen={false}>
        {detail.checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No checks reported.</p>
        ) : (
          <div className="space-y-0.5">
            {detail.checks.map((check, index) => {
              const failing = check.status === "failure" || check.status === "cancelled";
              return (
                <div
                  key={`${index}:${check.name}:${check.url ?? ""}`}
                  className="flex items-center gap-2 rounded-md pr-1 hover:bg-element-hover [contain-intrinsic-block-size:36px] [content-visibility:auto]"
                >
                  <button
                    type="button"
                    disabled={!check.url}
                    onClick={() => check.url && openPullRequest(check.url)}
                    className={cn(
                      "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left text-xs leading-5 [&>svg]:mt-0.5",
                      check.url ? "cursor-pointer" : "cursor-default",
                    )}
                  >
                    <CheckStatusIcon status={check.status} />
                    <span className="min-w-0 flex-1 break-words">
                      {check.workflow ? (
                        <span className="text-muted-foreground">{check.workflow} / </span>
                      ) : null}
                      {check.name}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {checkStatusLabel(check)}
                    </span>
                  </button>
                  <CheckLogButton check={check} />
                  {failing ? fixButton({ kind: "check", check }) : null}
                </div>
              );
            })}
            {detail.checksTruncated ? (
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                More checks ran than GitHub lists here.{" "}
                <button
                  type="button"
                  className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => openPullRequest(`${detail.url}/checks`)}
                >
                  See them all on GitHub
                </button>
              </p>
            ) : null}
          </div>
        )}
      </Section>

      <Section
        title={`Comments (${activity?.commentCount ?? "…"})`}
        actions={
          <div className="flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="xs" variant="ghost" aria-label="Filter comments" />}
              >
                <ListFilter aria-hidden className="size-3" />
                {hiddenByFilter > 0 ? `${hiddenByFilter} hidden` : "Filter"}
                <ChevronDown aria-hidden className="size-3 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Show</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={filter.bots}
                    closeOnClick={false}
                    onCheckedChange={(bots) => setFilter({ ...filter, bots })}
                  >
                    Bot comments
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={filter.resolved}
                    closeOnClick={false}
                    onCheckedChange={(resolved) => setFilter({ ...filter, resolved })}
                  >
                    Resolved or dismissed
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="xs"
              variant="ghost"
              aria-label={
                order === "newest" ? "Show oldest comments first" : "Show newest comments first"
              }
              onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
            >
              <ArrowDownUp aria-hidden className="size-3" />
              {order === "newest" ? "Newest first" : "Oldest first"}
            </Button>
          </div>
        }
      >
        {activityPending ? (
          <ConversationGhost />
        ) : activityError ? (
          <ActivityUnavailableState error={activityError} onRetry={onRetryActivity} />
        ) : (
          <>
            {activity?.commentsTruncated ? (
              <p className="mb-2 rounded-md border border-warning bg-warning-muted px-2 py-1.5 text-xs">
                This conversation is only partly loaded: {loadedCount.toLocaleString()}{" "}
                {loadedCount === 1 ? "comment is" : "comments are"} here; open it on GitHub to read
                the rest.
              </p>
            ) : null}
            {items.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : filtered.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {hiddenByFilter === 1
                  ? "The only comment is hidden by the filter."
                  : `All ${hiddenByFilter} comments are hidden by the filter.`}
              </p>
            ) : (
              <div className="space-y-3">
                {order === "oldest" ? olderButton : null}
                {visible.map(renderItem)}
                {order === "newest" ? olderButton : null}
                {shownCount > COMMENT_PAGE ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() => setShownCount(COMMENT_PAGE)}
                  >
                    Show only the {COMMENT_PAGE} most recent
                  </Button>
                ) : null}
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/** A resolved thread or dismissed review: one line, opened on request. */
function FinishedItem({
  comment,
  thread,
  label,
  replyCount,
  replies,
  more,
  reactions,
}: {
  comment: PrComment;
  thread: PrReviewThread | undefined;
  label: string;
  replyCount: number;
  replies: ReactNode;
  more: ReactNode;
  reactions: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const body = visibleBody(comment.body);
  return (
    <article className="group rounded-lg border border-border [contain-intrinsic-block-size:44px] [content-visibility:auto]">
      <div className="p-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <CommentIdentity comment={comment} />
          {replyCount > 0 ? (
            <span className="shrink-0 py-1 text-xs text-muted-foreground">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-element-hover hover:text-foreground"
          >
            {label}
            <ChevronDown
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
          </button>
          {reactions}
        </div>
        <CommentLocation comment={comment} thread={thread} />
        {!open && body ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 block w-full cursor-pointer truncate text-left text-xs text-muted-foreground hover:text-foreground"
          >
            {bodyPreview(body)}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="px-3 pb-3">
          {body ? <ClampedMarkdown className="mt-2" text={body} /> : null}
          {replies ? <div className="mt-3">{replies}</div> : null}
        </div>
      ) : null}
      {more ? <div className="px-3 pb-3">{more}</div> : null}
    </article>
  );
}
