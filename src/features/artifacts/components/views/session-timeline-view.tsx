import { memo, useMemo } from "react";
import { Brain, Check, Loader2, Sparkles, User } from "lucide-react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

import type { SessionDetail as Detail, TimelineEntry } from "../../types";
import { commentActivity } from "../../lib/comment-activity";
import {
  anchorKindFor,
  useOpenSignal,
  visibleCount,
  type Comment,
  type RowComments,
} from "../../lib/session-detail-context";
import { kindLabel, NODE_CENTRE, time, type Group } from "../../lib/session-timeline";
import { ActionCluster } from "../action-cluster";
import { AgentGlyph } from "../agent-glyph";
import { CopyButton } from "../code-block";
import { avatarUser, CommentButton } from "../comment-thread";
import { Checkpoint } from "./session-checkpoint-card";
import { Body, Clamp, Prompt } from "./session-entry-body";
import { Calls, CallStat } from "./session-tool-calls-view";

/**
 * The rendered window of the timeline.
 *
 * Split out and memoised because the scroll loop publishes two pieces of state
 * — the fade's `more` and the jump button's `activeAnchor` — and without this
 * boundary every tick of either re-rendered every row, every code block and
 * every markdown body in the window. Now a scroll that changes only where the
 * reader is re-renders the action bar and the fade, and the list is skipped
 * outright.
 *
 * `landed` is the one prop that still moves per row, and it moves once per jump.
 */
export const Timeline = memo(function Timeline({
  groups,
  projectPath,
  sessionId,
  agent,
  expandTools,
  landed,
  register,
  comments,
}: {
  groups: Group[];
  projectPath: string;
  sessionId: string;
  agent: string | null;
  expandTools: boolean;
  landed: string | null;
  register: (id: string, node: HTMLDivElement | null) => void;
  comments: RowComments | null;
}) {
  return (
    <>
      {groups.map((group, i) => (
        <Row
          key={group.id}
          group={group}
          first={i === 0}
          last={i === groups.length - 1}
          projectPath={projectPath}
          sessionId={sessionId}
          agent={agent}
          expandTools={expandTools}
          isLanded={group.entries.some((e) => e.id === landed)}
          landedCallId={
            // Including the run's FIRST call, which this used to exclude as
            // "already the row head, nothing to unfold". The ring does not need
            // the unfold — but the comment button does: a tool_call group never
            // renders one on its header (see `isCallRun`), so the only place to
            // hang the first call's thread off is its own row inside the fold.
            group.kind === "tool_call" && landed
              ? (group.entries.find((e) => e.id === landed)?.id ?? null)
              : null
          }
          register={register}
          comments={comments}
        />
      ))}
    </>
  );
});

/**
 * One node on the rail plus its content.
 *
 * The rail is a hairline in a 26px gutter, drawn per row and joined by the rows
 * above and below — half-height at the two ends so it starts and stops at a node
 * rather than running off into the page.
 */
const Row = memo(function Row({
  group,
  first,
  last,
  projectPath,
  sessionId,
  agent,
  expandTools,
  isLanded,
  landedCallId,
  register,
  comments,
}: {
  group: Group;
  first: boolean;
  last: boolean;
  projectPath: string;
  sessionId: string;
  agent: string | null;
  /** The global "always expand" switch from the filter drawer. */
  expandTools: boolean;
  /** A jump just landed here — ringed briefly. */
  isLanded: boolean;
  /** The landed entry, when it is one of this row's calls: the run has to
   *  unfold for it, both to ring it and to give its comment thread somewhere to
   *  open. `null` for every other row, so a jump does not re-render the whole
   *  window. */
  landedCallId: string | null;
  register: (id: string, node: HTMLDivElement | null) => void;
  /** `null` on a Session that is not shared — there is nothing to anchor to. */
  comments: RowComments | null;
}) {
  const head = group.entries[0];
  const openSignal = useOpenSignal(head.id);
  // A group of tool calls speaks for several anchors, not one. Every comment
  // surface below branches on it, so it is named once here.
  const isCallRun = group.kind === "tool_call";
  // Every thread on this row: the entry's own, plus each call's when the row is
  // a run of them. The activity lines under a folded run are the only place a
  // thread on its fifth call is visible without opening it.
  const threads = useMemo(
    () =>
      !comments
        ? undefined
        : isCallRun
          ? group.entries.flatMap((e) => comments.byAnchor[e.id] ?? [])
          : comments.byAnchor[head.id],
    [comments, isCallRun, group.entries, head.id],
  );
  return (
    <div
      ref={(node) => register(head.id, node)}
      className={cn(
        "atlas-entry grid grid-cols-[32px_minmax(0,1fr)] gap-3.5 rounded-md transition-colors",
        isLanded && "ring-1 ring-border-strong",
      )}
    >
      <div className="relative flex justify-center">
        <span
          aria-hidden
          className="absolute left-1/2 -ml-px w-px bg-border-subtle"
          style={{
            top: first ? NODE_CENTRE : 0,
            bottom: last ? `calc(100% - ${NODE_CENTRE}px)` : 0,
          }}
        />
        <Node kind={group.kind} agent={agent} status={head.toolStatus} />
      </div>

      <div className="group/row min-w-0 pb-6">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-base font-medium",
              group.kind === "checkpoint"
                ? "text-success"
                : group.kind === "prompt"
                  ? "text-[var(--foreground)]"
                  : "text-[var(--secondary-foreground)]",
            )}
          >
            {kindLabel(group)}
          </span>
          <span className="text-border-strong">·</span>
          <span className="font-mono text-xs text-[var(--muted-foreground)]">{time(head.at)}</span>
          {group.kind === "tool_call" && group.entries.length > 1 && (
            <span className="font-mono text-xs text-disabled">{group.entries.length} calls</span>
          )}
          {group.kind === "tool_call" && <CallStat calls={group.entries} />}

          {/* The row's controls, pushed right. The spacer is unconditional: a
           *  row with a comment button and no copy button still needs them
           *  over there, and two independent `flex-1`s would split the gap. */}
          <span className="flex-1" />
          <ActionCluster
            // A discussed row keeps its controls on screen. Hiding them behind
            // hover was the bug: the comment pill was visible (it has to be —
            // it is how a discussion announces itself) while the copy button
            // beside it was not, so the row showed a lone pill with a hole
            // next to it until the pointer arrived.
            pinned={comments && !isCallRun ? visibleCount(comments.byAnchor[head.id]) > 0 : false}
          >
            {/* Comment first, copy second. The comment button is the one that
             *  grows — faces and a count once a discussion exists — so
             *  outermost would make the copy button's position depend on how
             *  many people had replied. Every kind can be commented on, not
             *  just the two that can be copied: a tool call and a Checkpoint
             *  are exactly the things worth asking about.
             *
             *  A run of calls is the exception: this header can only anchor the
             *  FIRST of them, so each call carries its own button instead (see
             *  `CallRow`) and the aggregate lives on the fold. */}
            {comments && !isCallRun && (
              <CommentButton
                bare
                anchorKind={anchorKindFor(group.kind)}
                anchorId={head.id}
                comments={comments.byAnchor[head.id]}
                actions={comments.actions}
                directory={comments.directory}
                openSignal={openSignal}
              />
            )}
            {(group.kind === "prompt" || group.kind === "response") && head.text && (
              <CopyButton text={head.text} className="opacity-100" />
            )}
          </ActionCluster>
        </div>

        {isCallRun ? (
          <Calls
            calls={group.entries}
            projectPath={projectPath}
            expandAll={expandTools}
            comments={comments}
            revealId={landedCallId}
          />
        ) : group.kind === "checkpoint" ? (
          <Checkpoint entry={head} projectPath={projectPath} sessionId={sessionId} />
        ) : group.kind === "prompt" ? (
          <Prompt entry={head} projectPath={projectPath} />
        ) : (
          <Clamp>
            <div className="mt-1.5 text-base leading-[1.65] text-[var(--secondary-foreground)]">
              <Body entry={head} projectPath={projectPath} markdown={group.kind === "response"} />
            </div>
          </Clamp>
        )}

        {comments && <ActivityLog comments={threads} directory={comments.directory} />}
      </div>
    </div>
  );
});

/**
 * What was said about this node, under it.
 *
 * The record shows the work; these lines show the conversation about the work.
 * A count on a button says a discussion exists — it does not say a colleague
 * replied to you twenty minutes ago, which is the thing worth noticing while
 * reading past.
 *
 * Deliberately not interactive: the thread lives one click away in the pill
 * above, and a second way to open it would be a second place for the popover's
 * state to live.
 */
const ActivityLog = memo(function ActivityLog({
  comments,
  directory,
}: {
  comments: Comment[] | undefined;
  directory: OrgDirectory;
}) {
  const lines = useMemo(() => commentActivity(comments, directory), [comments, directory]);
  if (lines.length === 0) return null;

  return (
    // The lines are 14px faces against 11px text, so they read as a dense block
    // at a gap that would be fine for prose. Given room they read as a list.
    <div className="mt-4 flex flex-col gap-2">
      {lines.map((line) => {
        const member = directory.byId.get(line.authorId) ?? null;
        return (
          <div key={line.id} className="flex min-w-0 items-center gap-1.5">
            {member ? (
              <AccountAvatar user={avatarUser(member)} size={14} />
            ) : (
              <span className="size-[14px] shrink-0 rounded-full bg-element-selected" />
            )}
            <span className="min-w-0 truncate text-xs text-[var(--muted-foreground)]">
              <span className="text-[var(--secondary-foreground)]">{line.actorName}</span>{" "}
              {!line.isReply
                ? "commented on this"
                : line.self
                  ? "replied to their own comment"
                  : line.targetName
                    ? `replied to ${line.targetName}'s comment`
                    : "replied to a comment"}
              <span aria-hidden className="px-1 text-disabled">
                ·
              </span>
              <span className="text-disabled">{timeAgo(line.at, { suffix: true })}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
});

/** The glyph on the rail. 20px, hairline stroke, generous inset. */
/**
 * The marker on the rail.
 *
 * 32px, which is the size the reference design uses and roughly what an avatar
 * wants to be — the previous 20px read as a bullet point rather than as
 * "someone did this". At this size the agent's own mark is legible, so a
 * response is identifiable by its glyph rather than by reading the label.
 *
 * Opaque, not translucent: the rail hairline runs *behind* every node, and a
 * see-through fill would show the line crossing the glyph.
 */
function Node({
  kind,
  agent,
  status,
}: {
  kind: TimelineEntry["kind"];
  agent: string | null;
  status: TimelineEntry["toolStatus"];
}) {
  const failed = kind === "tool_call" && status === "failed";

  // A tool call is a solid dot — no glyph and no outline. It marks a position on
  // the rail and nothing more; the row beside it carries the meaning. Every
  // other kind keeps its ring, which is what makes turns stand out from the
  // punctuation between them.
  const bare = kind === "tool_call";

  const tone =
    kind === "checkpoint"
      ? "border-success/35 bg-success/10 text-success"
      : failed
        ? // Still legible as a failure without a ring: the fill carries it.
          "bg-error/70"
        : bare
          ? "bg-border-strong"
          : // Prompt + response rings at half strength. At full `--border-strong`
            // the outline competed with the glyph inside it, so the rail read as
            // a column of buttons rather than a quiet index of who did what.
            kind === "prompt"
            ? "border-border-strong/50 bg-[var(--card)] text-[var(--secondary-foreground)]"
            : kind === "response"
              ? "border-border-strong/50 bg-[var(--card)] text-[var(--secondary-foreground)]"
              : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]";

  // Tool calls and thinking stay small. They are punctuation between turns, not
  // turns themselves, and giving them an avatar-sized marker would flatten the
  // distinction the rail exists to draw. A bare dot goes smaller still — at 20px
  // an empty circle reads as a missing icon rather than as a mark.
  const minor = kind === "tool_call" || kind === "thinking";

  return (
    <span
      className={cn(
        "relative z-10 flex shrink-0 items-center justify-center rounded-full",
        !bare && "border",
        bare ? "size-2" : minor ? "size-5" : "size-8",
        tone,
      )}
      style={{
        marginTop: bare ? NODE_CENTRE - 4 : minor ? NODE_CENTRE - 10 : 0,
      }}
    >
      {/* Tool calls render a bare ring. A terminal glyph at 10px added ink
          without adding information — the row beside it already says what ran —
          and the empty ring still marks the position on the rail. */}
      {kind === "prompt" ? (
        <User size={15} strokeWidth={1.6} />
      ) : kind === "checkpoint" ? (
        <Check size={15} strokeWidth={2} />
      ) : kind === "tool_call" ? null : kind === "thinking" ? (
        <Brain size={10} strokeWidth={1.7} />
      ) : agent ? (
        <AgentGlyph agent={agent} size={16} />
      ) : (
        <Sparkles size={14} strokeWidth={1.7} />
      )}
    </span>
  );
}

export function Empty({
  detail,
  pending,
  failedOnly,
  failedCount,
}: {
  detail: Detail;
  /** The timeline has not arrived yet — say so rather than claiming it is empty. */
  pending: boolean;
  failedOnly: boolean;
  failedCount: number;
}) {
  if (pending) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-center text-sm text-[var(--muted-foreground)]">
        <Loader2 size={12} className="animate-spin" />
        Loading the timeline…
      </p>
    );
  }
  return (
    <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">
      {detail.entries.length === 0
        ? "Nothing was recorded in this session."
        : failedOnly && failedCount === 0
          ? "No tool calls failed in this session."
          : "Every entry is hidden by the current filters."}
    </p>
  );
}
