import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";

import { ToolGlyph } from "@/features/chat/components/tool-glyph";
import { cn } from "@/lib/utils";

import type { TimelineEntry } from "../../types";
import { useOpenSignal, visibleCount, type RowComments } from "../../lib/session-detail-context";
import { spilledRef, summarise, time } from "../../lib/session-timeline";
import { toolLine } from "../../lib/tool-line";
import { ActionCluster } from "../action-cluster";
import { CommentButton } from "../comment-thread";
import { Pre } from "./session-entry-body";

// ── Tool calls ──────────────────────────────────────────────────────────────

/**
 * A turn's tool calls, folded.
 *
 * Closed by default, and that is the point: a turn routinely fires twenty calls
 * and the reader is following the *conversation*. Twenty rows of `Bash Bash
 * Bash` between two paragraphs is the thing that made a Session unreadable, and
 * the summary beside the label already answers the question most of those rows
 * were being scanned for — what did it touch, and by how much.
 *
 * The drawer's switch forces every group open; this local state is the
 * per-group override, seeded from it so flipping the switch opens what is
 * already on screen.
 */
export function Calls({
  calls,
  projectPath,
  expandAll,
  comments,
  revealId,
}: {
  calls: TimelineEntry[];
  projectPath: string;
  expandAll: boolean;
  comments: RowComments | null;
  /** A jump landed on one of these calls — unfold so it can be seen. */
  revealId?: string | null;
}) {
  const [open, setOpen] = useState(expandAll);
  useEffect(() => setOpen(expandAll), [expandAll]);
  // A jump to a call inside a folded run has to open the run. Not merged with
  // the line above: `expandAll` is a switch the reader set and must stay
  // authoritative when they turn it off again.
  useEffect(() => {
    if (revealId) setOpen(true);
  }, [revealId]);

  // Threads inside the fold, summed. A run of calls is folded by default, so
  // without this the only sign of a discussion on its third call would be the
  // count in the panel — the fold would look untouched.
  const inside = comments
    ? calls.reduce((n, call) => n + visibleCount(comments.byAnchor[call.id]), 0)
    : 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-sm text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        Show tool calls
        <ChevronRight size={12} />
        {inside > 0 && (
          <span
            className="flex h-5 items-center gap-1 rounded-full border border-border bg-card pl-1.5 pr-1.5 text-[var(--secondary-foreground)]"
            aria-label={`${inside} ${inside === 1 ? "comment" : "comments"} on these tool calls`}
          >
            <MessageSquare size={11} />
            <span className="text-2xs tabular-nums">{inside > 9 ? "9+" : inside}</span>
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      <CallTable
        calls={calls}
        projectPath={projectPath}
        compact
        comments={comments}
        revealId={revealId}
      />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-1.5 flex cursor-pointer items-center gap-1 text-sm text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        Hide tool calls
        <ChevronDown size={12} className="rotate-180" />
      </button>
    </>
  );
}

/**
 * What a folded run of calls did, in one line.
 *
 * The counts come from the tool names; the line delta is read out of the
 * recorded **arguments** of each `Edit` / `Write`, which is the only place it
 * exists — a tool call carries no diffstat of its own, and the Session's
 * insertions belong to its Checkpoints, not to any one turn. Derived, therefore
 * exact for what was recorded and silent when nothing was.
 */
export function CallStat({ calls }: { calls: TimelineEntry[] }) {
  const stat = useMemo(() => summarise(calls), [calls]);
  if (!stat.parts.length && !stat.added && !stat.removed) return null;
  return (
    <>
      {stat.parts.length > 0 && (
        <span className="truncate font-mono text-xs text-[var(--atlas-text-disabled)]">
          {stat.parts.join(" · ")}
        </span>
      )}
      {stat.added > 0 && (
        <span className="font-mono text-xs text-[var(--atlas-diff-added-text)]">+{stat.added}</span>
      )}
      {stat.removed > 0 && (
        <span className="font-mono text-xs text-[var(--atlas-diff-removed-text)]">
          −{stat.removed}
        </span>
      )}
    </>
  );
}

/** Calls mounted before the table asks to grow. Generous for the inline group
 *  (a turn rarely fires this many) so the control only ever appears on the Tool
 *  calls tab — which was the one unwindowed list in the feature: a tool-heavy
 *  Session mounted every call as a row in a single commit. */
const CALL_WINDOW = 120;
/** How many more each click reveals. */
const CALL_WINDOW_GROW = 400;

/** The compact call table behind a group's "Show tool calls". */
function CallTable({
  calls,
  projectPath,
  compact: dense,
  comments,
  revealId,
}: {
  calls: TimelineEntry[];
  projectPath: string;
  compact?: boolean;
  comments: RowComments | null;
  /** A jump landed on this call: expand it, and grow the window until it is
   *  mounted. Without this a comment on the fourth call of a run scrolled the
   *  group into view and stopped there. */
  revealId?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(CALL_WINDOW);
  // One stable handler for every row — the per-row closure was what forced the
  // whole table to re-render on a single expand.
  const toggle = useCallback((id: string) => setOpen((cur) => (cur === id ? null : id)), []);

  // A different call list is a different table — restart the window.
  useEffect(() => setShown(CALL_WINDOW), [calls]);

  useEffect(() => {
    if (!revealId) return;
    const at = calls.findIndex((c) => c.id === revealId);
    if (at === -1) return;
    setShown((cur) => (at < cur ? cur : at + 1));
    setOpen(revealId);
  }, [revealId, calls]);

  if (calls.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-[var(--muted-foreground)]">
        No tool calls match the current filters.
      </p>
    );
  }

  const visibleCalls = calls.length > shown ? calls.slice(0, shown) : calls;
  const hidden = calls.length - visibleCalls.length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-[var(--border)]",
        dense ? "mt-2.5" : "mt-5",
      )}
    >
      {visibleCalls.map((call, i) => (
        <CallRow
          key={call.id}
          call={call}
          dense={dense}
          expanded={open === call.id}
          divider={i < visibleCalls.length - 1 || hidden > 0}
          onToggle={toggle}
          projectPath={projectPath}
          comments={comments}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown((cur) => cur + CALL_WINDOW_GROW)}
          className="flex h-9 w-full cursor-pointer items-center justify-center bg-[var(--card)] font-mono text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
        >
          Show {Math.min(CALL_WINDOW_GROW, hidden)} more of {hidden}…
        </button>
      )}
    </div>
  );
}

/**
 * One call: the summary row, and the recorded payloads when expanded.
 *
 * The line is the transcript's — glyph, verb, target (`toolLine`) — rather than
 * the `toolName` / `paths[0]` columns it used to be. The two surfaces show the
 * same events to the same reader, and a comment made here is read back beside
 * that call in the live chat; recognising the call in both is the point.
 *
 * The comment button is on the CALL, not on the group above it. A group is a run
 * of consecutive calls and its header could only ever anchor the first one, so a
 * thread on the fourth call of a run had nowhere to render — it counted in the
 * panel and the badge and appeared nowhere in the timeline, which is the bug this
 * replaces.
 *
 * Memoised so the table's own state changes touch only the rows they concern:
 * expanding a call re-renders that row and the one it closed, not every row in
 * a table that can hold a Session's entire call history.
 */
const CallRow = memo(function CallRow({
  call,
  dense,
  expanded,
  divider,
  onToggle,
  projectPath,
  comments,
}: {
  call: TimelineEntry;
  dense?: boolean;
  expanded: boolean;
  divider: boolean;
  onToggle: (id: string) => void;
  projectPath: string;
  /** `null` on a Session that is not shared — there is nothing to anchor to. */
  comments: RowComments | null;
}) {
  const openSignal = useOpenSignal(call.id);
  const failed = call.toolStatus === "failed";
  // One parse of the recorded arguments per call, not per render: the table can
  // hold a Session's whole call history.
  const line = useMemo(() => toolLine(call), [call]);
  const thread = comments?.byAnchor[call.id];
  return (
    <div>
      <div
        className={cn(
          "group/row flex items-center gap-2 bg-[var(--card)] px-3 transition-colors hover:bg-[var(--atlas-element-hover)]",
          dense ? "h-8" : "h-9",
          divider && "border-b border-[var(--atlas-border-subtle)]",
        )}
      >
        {!dense && (
          <span className="shrink-0 font-mono text-xs text-[var(--atlas-text-disabled)]">
            {time(call.at)}
          </span>
        )}
        <button
          type="button"
          onClick={() => onToggle(call.id)}
          title={line.detail ? `${line.verb} ${line.detail}` : line.verb}
          className="group/marker flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className="flex w-4 shrink-0 justify-center text-[var(--muted-foreground)]">
            <ToolGlyph tool={line.tool} failed={failed} />
          </span>
          {/* One run of text, so verb and target read as a sentence and a long
              command truncates as a line rather than as a separate column. */}
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              failed
                ? "text-[var(--atlas-status-error-foreground)]"
                : "text-[var(--secondary-foreground)]",
            )}
          >
            {line.verb}
            {line.detail && (
              <>
                {" "}
                <span
                  className={cn(
                    line.fileDetail &&
                      "text-[var(--atlas-text-disabled)] underline decoration-dotted underline-offset-[3px] group-hover/marker:text-[var(--secondary-foreground)]",
                  )}
                >
                  {line.detail}
                </span>
              </>
            )}
          </span>
          <ChevronRight
            size={12}
            className={cn(
              "shrink-0 text-[var(--atlas-border-strong)] transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
        {/* A discussed call keeps its button on screen — that is how the
            discussion announces itself; an undiscussed one reveals on hover
            like every other Timeline control. */}
        {comments && (
          <ActionCluster pinned={visibleCount(thread) > 0}>
            <CommentButton
              bare
              anchorKind="tool_call"
              anchorId={call.id}
              comments={thread}
              actions={comments.actions}
              directory={comments.directory}
              openSignal={openSignal}
            />
          </ActionCluster>
        )}
      </div>

      {expanded && (
        <div className="space-y-2.5 border-b border-[var(--atlas-border-subtle)] bg-[var(--background)] px-3 py-3">
          {call.paths.length > 0 && (
            <p className="font-mono text-xs text-[var(--muted-foreground)]">
              {call.paths.join("  ·  ")}
            </p>
          )}
          {call.arguments && (
            <Pre
              label="Arguments"
              text={call.arguments}
              json
              projectPath={projectPath}
              blobRef={spilledRef(call.argumentsRef, call.arguments)}
              rowId={call.id}
              part="arguments"
            />
          )}
          {call.resultBinary ? (
            <p className="font-mono text-xs text-[var(--muted-foreground)]">
              The result is binary and is not shown.
            </p>
          ) : (
            call.result && (
              <Pre
                label="Result"
                text={call.result}
                path={call.paths[0]}
                projectPath={projectPath}
                blobRef={spilledRef(call.resultRef, call.result)}
                rowId={call.id}
                part="result"
              />
            )
          )}
          {!call.arguments && !call.result && !call.resultBinary && (
            <p className="font-mono text-xs text-[var(--atlas-text-disabled)]">
              Nothing else was recorded for this call.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
