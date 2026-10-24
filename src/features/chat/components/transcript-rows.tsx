// Row components for the new transcript.
//
// House rules, all of which exist to keep the thread quiet and cheap to scroll:
//
//  1. No element grows on hover or on load. Anything expandable either toggles
//     via row state (which reflows once, deliberately) or opens the detail
//     panel. Diffs and tool output are the panel's job, never the thread's —
//     that is what keeps a turn's cost bounded no matter what the agent did.
//  2. The only things with colour are diff counts, the running-state glyph, and
//     the turn footer's primary action. Everything else is foreground/muted
//     grey. Per-tool icon SHAPES are fine and are what the marker rows use —
//     per-tool icon COLOURS are the "moving blocks" problem in a new costume,
//     and are the thing to resist.
//  3. Rows never subscribe to the chat store or the detail-panel store. Data
//     arrives as props; actions are fired imperatively via `getState()`.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronRight, Files, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { StreamingMarkdown } from "./streaming-markdown";
import { openDetail } from "../stores/detail-panel-store";
import { openTurnDiff } from "../lib/open-turn-diff";
import { ChangedFilesCard } from "./changed-files-card";
import { UserRowActions } from "./user-row-actions";
import { ImageAttachmentStrip } from "./image-attachments";
import { FILE_DETAIL, ICON_PX, ICON_STROKE, ToolGlyph } from "./tool-glyph";
import {
  GroupCommentPill,
  RowCommentPill,
  useGroupHasComments,
  useRowHasComments,
} from "./chat-comment-pills";
import { ProseRowActions } from "./prose-row-actions";
import type { SubagentStatus } from "@/types/agent";
import type {
  UserRow,
  ProseRow,
  ThinkingRow,
  MarkerRow,
  MarkerGroupRow,
  SeparatorRow,
  SubagentRow,
  TurnFooterRow,
  WorkHeaderRow,
} from "../lib/turn-rows";
import { userRowMessageId } from "../lib/turn-rows";
import { CONTENT_COLUMN, M } from "../lib/row-metrics";
import { formatTime } from "@/lib/format-time";
import { useVisibleAnimation } from "@/lib/visible-animation";

/** Shared by every row: the centred content column. */
function Column({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn(CONTENT_COLUMN, className)}>{children}</div>;
}

// ── User ───────────────────────────────────────────────────────────────────

export const UserRowView = memo(function UserRowView({
  row,
  tabId,
  priority,
  justSent = false,
  canRetry = false,
  pinScopeKey,
  fileRoot,
  onToggleExpand,
}: {
  row: UserRow;
  /** Passed rather than read from a store: house rule 3, and a primitive prop
   *  keeps the shallow-compare `memo` above intact. */
  tabId: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  /** True ONLY for the message the user sent just now (id-scoped in the
   *  store). The previous wall-clock-vs-timestamp gate animated entire
   *  restored threads (resume/replay paths stamp messages "now") and every
   *  row mounted during an early scroll — bulk entrance animations during
   *  fast scroll were a blanking contributor. */
  justSent?: boolean;
  /** True only for the thread's last user message on an agent that can rewind.
   *  Resolved by the transcript so this stays a boolean — a callback minted in
   *  the row map would defeat the memo for every row on every frame. */
  canRetry?: boolean;
  /** Pin scope for this thread — resolved once by the transcript. */
  pinScopeKey: string;
  /** The session's project root: `@file` chips open what they name. */
  fileRoot?: string;
  onToggleExpand: (id: string) => void;
}) {
  const clampRef = useRef<HTMLDivElement>(null);
  const { height: clampHeight, overflows } = useWholeLineClamp(clampRef, !row.expanded);
  return (
    // Generous space BELOW the prompt: the gap is what separates one exchange
    // from the next, and a tight one made the agent's reply read as a
    // continuation of the user's own message.
    // `pb-7` (28px) is not slack, it is the action bar's room: the bar is
    // absolutely positioned at `top-full`, so its 8px top pad and 20px icons
    // have to fit under the bubble or a hovered row overhangs into the agent's
    // reply. Reserved statically for EVERY user row — hovered or not, with an
    // expand toggle or without — so revealing the bar can never move anything
    // (house rule 1).
    <Column className="flex justify-end pt-6 pb-7">
      {/* `min-w-0` on both flex levels, `max-w-full` on the bubble: a pasted
          code block is `white-space: pre` (unwrappable), and a flex item's
          automatic minimum size floors at that intrinsic width — the pre's own
          `overflow-x: auto` cannot save an ancestor that refuses to shrink, so
          a long paste dragged the whole bubble past the viewport edge. With
          the chain capped, the fence scrolls horizontally INSIDE the bubble. */}
      <div className="relative flex min-w-0 max-w-[80%] flex-col items-end">
        {/* Images above the bubble, right-aligned with it — the same tiles
            the composer showed before send. */}
        <ImageAttachmentStrip images={row.attachments} className="mb-2 justify-end" />
        {/* The prompt is markdown too. It is written in the same composer that
            accepts fences and lists, and rendering it as flat text collapsed
            every newline — a pasted snippet came back as one run-on paragraph.
            Same renderer as the agent's prose so a quoted block looks identical
            on both sides of the thread; only the type scale differs.

            Clamped by HEIGHT rather than `-webkit-line-clamp`: line-clamp needs
            inline content, and the moment the bubble holds block elements
            (paragraphs, a list, a fence) it stops clamping at all. */}
        <div
          className={cn(
            // Apple-squircle read: one big continuous radius (no clipped
            // corner), a touch more padding — iMessage-adjacent geometry.
            // A fixed 20px, NOT `rounded-full`: this bubble grows to many
            // lines, and a radius of half its height turns it into an ellipse
            // whose curve cuts off the first and last line at the corners.
            // ratchet-allow: 20px sits above the `rounded-*` scale (xl = 12px), and
            // a full radius clips multi-line bubbles.
            "min-w-0 max-w-full rounded-[20px] bg-[var(--atlas-primary-muted)] px-4 py-2.5 select-text",
            // Entrance only for THE message sent just now (id-scoped).
            justSent && "atlas-bubble-in",
          )}
        >
          {/* The clamp lives INSIDE the padding, not on the bubble: the bubble
              is border-box, so a `max-height` there spent 20px of the budget
              on padding and sliced the last line in half — and `overflow`
              clips at the padding edge, so the cut line bled into the bottom
              padding instead of stopping above it. Here the budget is pure
              line boxes and the bubble's own padding stays clear. */}
          <div
            ref={clampRef}
            style={row.expanded ? undefined : { maxHeight: clampHeight, overflow: "hidden" }}
          >
            {/* `.atlas-prose` goes on the markdown root itself, as it does for
                the agent's prose: the block rules are `> *` selectors, and on
                the bubble they matched this wrapper instead of the paragraphs,
                so a multi-paragraph prompt rendered with no gaps at all. */}
            <CachedMarkdown
              source={row.text}
              unstyled
              priority={priority}
              fileRoot={fileRoot}
              trustedPaths={row.trustedPaths}
              className="atlas-prose atlas-prose--user"
            />
          </div>
        </div>
        {row.contextBlocks > 0 && (
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-2xs text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors"
            title="Context attached with @-mentions"
          >
            <Paperclip size={10} />
            {row.contextBlocks} attached
          </button>
        )}
        {overflows && <ExpandToggle row={row} onToggleExpand={onToggleExpand} />}
        <UserRowActions
          tabId={tabId}
          text={row.text}
          canRetry={canRetry}
          messageId={userRowMessageId(row.id)}
          timestamp={row.timestamp}
          timestampApproximate={row.timestampApproximate === true}
          pinScopeKey={pinScopeKey}
          toggleAbove={overflows}
        />
      </div>
    </Column>
  );
});

/** The clamp budget: `userMaxLines` lines of bubble text. */
const USER_CLAMP_PX = M.userMaxLines * M.userLineHeight;

/**
 * The collapsed bubble's `max-height`, snapped down to the bottom of the last
 * line that fits whole inside `USER_CLAMP_PX`.
 *
 * The budget alone is only exact for one unbroken paragraph. Paragraph gaps,
 * list spacing and a fence's own line height all knock later lines off the
 * 22px grid, so a fixed cut lands mid-glyph on most real prompts. Measured,
 * not predicted: only the block that straddles the cut is read line by line,
 * and a prompt short enough to fit costs one `scrollHeight` read.
 *
 * Also reports whether the prompt overflows the budget at all, which is what
 * decides the "Show more" toggle. That used to be a character-count guess, and
 * a 300-character prompt that wraps to four lines got a toggle that did
 * nothing. The markdown root's `scrollHeight` is its natural height whether or
 * not the wrapper is clamping it, so the answer holds while expanded too.
 *
 * Re-measured on resize of the markdown root, which covers both a width change
 * (the lines rewrap) and the raw-source placeholder swapping to parsed HTML.
 */
function useWholeLineClamp(
  ref: React.RefObject<HTMLDivElement | null>,
  active: boolean,
): { height: number; overflows: boolean } {
  const [height, setHeight] = useState(USER_CLAMP_PX);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current?.firstElementChild;
    if (!(root instanceof HTMLElement)) return;
    const measure = () => {
      const over = root.scrollHeight > USER_CLAMP_PX;
      setOverflows(over);
      if (!active) return;
      if (!over) {
        setHeight(USER_CLAMP_PX);
        return;
      }
      const base = root.getBoundingClientRect().top;
      let fit = 0;
      for (const child of Array.from(root.children)) {
        const box = child.getBoundingClientRect();
        if (box.top - base >= USER_CLAMP_PX) break;
        if (box.bottom - base <= USER_CLAMP_PX) {
          fit = box.bottom - base;
          continue;
        }
        // The block the cut falls inside: keep its last whole line.
        const range = document.createRange();
        range.selectNodeContents(child);
        for (const line of Array.from(range.getClientRects())) {
          const bottom = line.bottom - base;
          if (bottom <= USER_CLAMP_PX && bottom > fit) fit = bottom;
        }
        break;
      }
      setHeight(fit > 0 ? Math.ceil(fit) : USER_CLAMP_PX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [ref, active]);
  return { height, overflows };
}

/**
 * "Show more" / "Show less". The row renders it only when the prompt measurably
 * overflows the clamp (`useWholeLineClamp`).
 *
 * In flow and always visible, unlike the action bar beneath it. That is
 * deliberate: this one is not an action on the message, it is the only way to
 * know the bubble is truncated at all. Hiding it until hover would mean a
 * clamped prompt looks like a complete one.
 */
function ExpandToggle({
  row,
  onToggleExpand,
}: {
  row: UserRow;
  onToggleExpand: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggleExpand(row.id)}
      className="mt-0.5 h-[18px] text-2xs text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors"
    >
      {row.expanded ? "Show less" : "Show more"}
    </button>
  );
}

// ── Prose ──────────────────────────────────────────────────────────────────

export const ProseRowView = memo(function ProseRowView({
  row,
  tabId,
  agentLabel,
  priority,
  pinScopeKey,
  canBranch = false,
  fileRoot,
}: {
  row: ProseRow;
  tabId: string;
  agentLabel: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  pinScopeKey: string;
  /** True only for the session's latest settled response on an agent that can
   *  fork, with no turn running. Resolved by the transcript, like `canRetry`. */
  canBranch?: boolean;
  /** The session's project root: paths in the reply become file chips. */
  fileRoot?: string;
}) {
  return (
    // A settled response reserves the gap its action bar sits in (see
    // `prose-row-actions.tsx`); the streaming tail does not — nothing here
    // works on a response that is still arriving, and the one reflow happens
    // when the turn ends, deliberately.
    // A response whose footer sits below its turn's changed-files card
    // (`footerBelow`) reserves nothing here; the footer row does.
    <Column className={cn("py-2", !row.streaming && !row.footerBelow && "relative pb-7")}>
      {/* One left-aligned group: model, dot, time. The timestamp used to be
          pushed to the far right with `ml-auto`, which left a long empty span
          across a 760px column and read as two unrelated headers rather than
          one line of provenance. It stays against the left edge the prose
          below it also starts from.

          What answers a message is the MODEL, so the model leads; the time is
          the qualifier and follows the separator. The agent glyph is gone —
          it repeated what the model name already says, and an icon is the
          heaviest possible way to say it in a line that competes with the
          prose underneath. `agentLabel` is the fallback for a row whose model
          is unknown (an older thread, a resumed session), so the line never
          degrades to a bare timestamp with no provenance at all. */}
      {row.showHeader && (
        <div className="flex h-[22px] items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-2xs text-[var(--muted-foreground)]">
            {row.model || agentLabel}
          </span>
          {/* A replayed response's time is when Atlas replayed it, not when
              it was said: no clock rather than a wrong one. */}
          {!row.timestampApproximate && (
            <>
              <span aria-hidden className="shrink-0 text-2xs text-[var(--atlas-text-disabled)]">
                ·
              </span>
              <span className="shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
                {formatTime(row.timestamp, { hour: "2-digit", minute: "2-digit" })}
              </span>
            </>
          )}
        </div>
      )}
      {/* Settled prose goes through the plain cached renderer: its root IS
          `.atlas-prose`, so the block metrics apply to real block elements and
          a scrolled-back message is a pure cache hit. The streaming tail uses
          the block-splitting renderer, where only the trailing block re-parses
          per frame. */}
      {row.streaming ? (
        <StreamingMarkdown
          source={row.text}
          streaming
          unstyled
          priority={priority}
          fileRoot={fileRoot}
          className="atlas-prose"
        />
      ) : (
        <div data-agent-response={row.id.slice(2)}>
          <CachedMarkdown
            source={row.text}
            unstyled
            priority={priority}
            fileRoot={fileRoot}
            className="atlas-prose"
          />
        </div>
      )}
      {!row.streaming && !row.footerBelow && (
        <ProseRowActions
          tabId={tabId}
          messageId={row.id.slice(2)}
          timestamp={row.timestamp}
          text={row.text}
          pinScopeKey={pinScopeKey}
          canBranch={canBranch}
          showTimestamp={!row.showHeader && !row.timestampApproximate}
        />
      )}
    </Column>
  );
});

// ── Thinking ───────────────────────────────────────────────────────────────

export const ThinkingRowView = memo(function ThinkingRowView({
  row,
  tabId,
  onToggleExpand,
}: {
  row: ThinkingRow;
  tabId: string;
  onToggleExpand: (id: string) => void;
}) {
  // `th:<messageId>`. A discussed thought wears its pill; the wrapper exists
  // only then, so an undiscussed row's DOM is exactly what it was.
  const messageId = row.id.slice(3);
  const discussed = useRowHasComments(tabId, messageId);
  const shimmer = useVisibleAnimation<HTMLElement>();
  const toggle = (
    <button
      ref={row.streaming ? shimmer : undefined}
      type="button"
      onClick={() => onToggleExpand(row.id)}
      className={cn(
        "flex h-[26px] items-center gap-2 text-left text-base text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors",
        discussed ? "min-w-0 flex-1" : "w-full",
      )}
    >
      {/* Same slot, size and stroke as the tool rows around it. */}
      <span className="flex w-4 shrink-0 justify-center">
        <Brain
          size={ICON_PX}
          strokeWidth={ICON_STROKE}
          className={cn(row.streaming && "atlas-marker-running")}
        />
      </span>
      {/* The thought itself when it has one: "Checking the cache key" says
          more than "Thinking…", and it is the live line while the agent
          reasons. One truncated line, so the row stays 26px as it changes. */}
      <span className={cn("min-w-0 truncate", row.streaming && "atlas-thinking-shimmer")}>
        {row.headline ?? (row.streaming ? "Thinking…" : "Thought process")}
      </span>
      <ChevronRight
        size={ICON_PX}
        strokeWidth={ICON_STROKE}
        className={cn("shrink-0 transition-transform", row.expanded && "rotate-90")}
      />
    </button>
  );
  return (
    // A turn often emits several thinking blocks in a row, and at the bare
    // 26px button height they stacked into one undifferentiated block — three
    // "Thought process" lines read as a list with no items. 3px either side
    // takes the pitch to 32px (the row plus a quarter) which is enough to tell
    // them apart without turning them into paragraphs.
    <Column className="py-[3px]">
      {discussed ? (
        <div className="flex items-center gap-2">
          {toggle}
          <RowCommentPill tabId={tabId} chatKey={messageId} />
        </div>
      ) : (
        toggle
      )}
      {row.expanded && (
        <div className="pb-3 pl-6">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[19px] text-[var(--muted-foreground)] select-text">
            {row.text}
          </pre>
        </div>
      )}
    </Column>
  );
});

// ── Marker ─────────────────────────────────────────────────────────────────

/**
 * One tool call: a single muted line, and nothing else.
 *
 * The group expands, while each action stays one line. Clicking an action with
 * output or a diff opens its detail view. There is no trailing chevron, as in
 * Codex: a file target reads as a link (dotted underline) and every clickable
 * row brightens on hover.
 */
export const MarkerRowView = memo(function MarkerRowView({
  row,
  tabId,
  embedded = false,
}: {
  row: MarkerRow;
  tabId: string;
  embedded?: boolean;
}) {
  const clickable = row.opens !== "none";
  const onClick = useCallback(() => {
    if (row.opens === "diff") {
      // Changes get the real viewer, not the sidebar. The turn id is what the
      // diff is scoped by; the path just says which file to land on.
      openTurnDiff(row.turnId, row.path);
    } else if (row.opens === "output") {
      openDetail(tabId, { kind: "output", toolCallId: row.toolCallId });
    }
  }, [row.opens, row.path, row.toolCallId, tabId]);
  const fileLink = clickable && FILE_DETAIL.has(row.tool);
  const discussed = useRowHasComments(tabId, row.toolCallId);
  const shimmer = useVisibleAnimation<HTMLElement>();

  const line = (
    <button
      ref={row.state === "running" ? shimmer : undefined}
      type="button"
      disabled={!clickable}
      onClick={clickable ? onClick : undefined}
      className={cn(
        "atlas-marker group/marker min-w-0 text-left text-base text-[var(--muted-foreground)]",
        discussed ? "flex-1" : "w-full",
        clickable && "cursor-pointer hover:text-[var(--secondary-foreground)]",
        row.state === "running" && "atlas-marker-running",
      )}
      title={
        clickable ? `${row.cmd ?? `${row.verb} ${row.detail}`} — open in side panel` : undefined
      }
    >
      <span className="flex w-4 shrink-0 justify-center">
        <ToolGlyph tool={row.tool} failed={row.state === "failed"} />
      </span>
      {/* One run of text, so verb and target are a sentence ("Read flow.tsx")
          with a plain space between them, and a long command truncates as a
          line rather than as a separate column. */}
      <span className="min-w-0 truncate">
        {row.verb}
        {row.detail && (
          <>
            {" "}
            <span
              className={cn(
                fileLink &&
                  "text-[var(--atlas-text-disabled)] underline decoration-dotted underline-offset-[3px] group-hover/marker:text-[var(--secondary-foreground)]",
              )}
            >
              {row.detail}
            </span>
          </>
        )}
      </span>
      {(row.added > 0 || row.removed > 0) && (
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums">
          {row.added > 0 && (
            <span className="text-[var(--atlas-diff-added-text)]">+{row.added}</span>
          )}
          {row.removed > 0 && (
            <span className="ml-1 text-[var(--atlas-status-error-foreground)]">−{row.removed}</span>
          )}
        </span>
      )}
      {/* The step's own time, in the same gutter and style as a block's live
          elapsed figure. Only from a second up — see `settledFigure`. */}
      {row.durationMs !== undefined && row.durationMs >= 1000 && (
        <span
          className={cn(
            "shrink-0 font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums",
            row.added === 0 && row.removed === 0 && "ml-auto",
          )}
        >
          {settledFigure(row.durationMs)}
        </span>
      )}
    </button>
  );
  // A discussed call wears its pill beside the line; the wrapper exists only
  // then, so every other marker row's DOM is exactly what it was.
  const body = discussed ? (
    <div className="flex items-center gap-2">
      {line}
      <RowCommentPill tabId={tabId} chatKey={row.toolCallId} />
    </div>
  ) : (
    line
  );
  // `py-1` at top level: the same box as a block's header, so a lone call
  // reads at the rhythm of the blocks around it.
  return embedded ? body : <Column className="py-1">{body}</Column>;
});

/**
 * A folded sequence of consecutive tool calls, kept between the prose around it.
 *
 * One counted sentence you click — "Ran 3 commands and read 2 files" — led
 * by the icon of the group it names first. While a call
 * is running the line names that call instead ("Running bun run typecheck")
 * and wears its icon, then returns to the sentence when it finishes.
 *
 * The block does NOT open itself while live. The one line carries the live
 * state instead, and earns it by saying three things the settled sentence
 * cannot: what is running right now, how many actions are already behind it,
 * and how long the current one has been going. Auto-expanding was the
 * alternative and was rejected — it makes the transcript reflow under the
 * reader mid-turn, for detail that is one click away and that the folded
 * summary reports a second later anyway.
 *
 * The numeric gutter is the same right-hand slot `MarkerRowView` puts `+n −m`
 * in, for the same reason: the left of a marker line is a sentence, the right
 * is a column of figures, and they should not interleave.
 *
 * The chevron appears on hover and stays visible when open.
 */
export const MarkerGroupRowView = memo(function MarkerGroupRowView({
  row,
  tabId,
  onExpandTurn,
}: {
  row: MarkerGroupRow;
  tabId: string;
  onExpandTurn: (turnId: string) => void;
}) {
  // Derived rather than carried on the row: the projection would have to
  // recompute it on every marker state change anyway, and it is a scan of a
  // list the row already holds.
  const failed = row.markers.some((marker) => marker.state === "failed");
  // The ids of the calls behind this line, which is what a comment on any of
  // them is keyed by. Derived here rather than carried on the row: it is a map
  // over a list the row already holds, and the projection would have to redo it
  // on every marker state change.
  const callIds = useMemo(() => row.markers.map((marker) => marker.toolCallId), [row.markers]);
  const discussed = useGroupHasComments(tabId, callIds);
  const shimmer = useVisibleAnimation<HTMLElement>();
  const summary = (
    <button
      ref={row.running ? shimmer : undefined}
      type="button"
      aria-expanded={row.open}
      aria-controls={`${row.id}:actions`}
      onClick={() => onExpandTurn(row.id)}
      className={cn(
        "atlas-marker group/tool-summary cursor-pointer text-left text-base text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
        // Discussed, the line shares its row with the pill and has to fill
        // the space so the pill lands at the end of it.
        discussed ? "min-w-0 flex-1" : "max-w-full",
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">
        <ToolGlyph tool={row.running && row.liveTool ? row.liveTool : row.tool} failed={failed} />
      </span>
      <span className={cn("min-w-0 truncate", row.running && "atlas-thinking-shimmer")}>
        {row.running ? row.liveLabel : row.summary}
      </span>
      {row.running &&
        (row.liveDone > 0 || row.liveStartedAt !== null) && (
          // Gap rather than a "·" between the two figures: the elapsed one is
          // written straight to the DOM and is blank for its first second, so
          // any separator React rendered beside it would dangle on its own
          // until the first tick.
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums">
            {row.liveDone > 0 && <span>{row.liveDone} done</span>}
            {row.liveStartedAt !== null && (
              <LiveElapsed startedAt={row.liveStartedAt} minMs={1000} />
            )}
          </span>
        )}
      <ChevronRight
        size={ICON_PX}
        strokeWidth={ICON_STROKE}
        className={cn(
          "shrink-0",
          row.open
            ? "rotate-90 opacity-100"
            : "opacity-0 group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100",
        )}
      />
    </button>
  );
  return (
    <Column className="py-1">
      {/* A discussed sequence wears the fold's aggregate beside its summary —
          faces and a count over the calls inside, opening the fold so the call
          that was discussed can show its own pill. The wrapper exists only
          then, so every other group's DOM is exactly what it was. */}
      {discussed ? (
        <div className="flex items-center gap-2">
          {summary}
          <GroupCommentPill
            tabId={tabId}
            chatKeys={callIds}
            onOpen={() => {
              if (!row.open) onExpandTurn(row.id);
            }}
          />
        </div>
      ) : (
        summary
      )}
      {row.open && (
        // Laid out in the thread, not in a 240px scroller. A nested scroll area
        // inside a scrolling transcript is two scrollbars fighting over the
        // same wheel gesture, and it hides the end of the list behind an
        // interaction the reader has to discover. Opening a sequence is a
        // deliberate act on one turn at a time, so its rows are just rows.
        <div id={`${row.id}:actions`}>
          {row.markers.map((marker) => (
            <MarkerRowView key={marker.id} row={marker} tabId={tabId} embedded />
          ))}
        </div>
      )}
    </Column>
  );
});

/**
 * A delegated child — one line, the same line a tool call gets.
 *
 * Minimal on purpose: a subagent is not a card, it is one more thing the turn
 * did, and the transcript's whole bargain is that work reads as a quiet column
 * you scan. What sets it apart is the glyph — a filled orb rather than a tool
 * icon, which is how both Codex and Claude Desktop mark an agent among tool
 * calls — and nothing else.
 *
 * Clicking opens the child in the side panel rather than expanding in place:
 * its prompt, its calls and its answer are a body, and a row that grows into
 * one is exactly the unpredictable height the virtualizer cannot absorb.
 */
export const SubagentRowView = memo(function SubagentRowView({
  row,
  tabId,
}: {
  row: SubagentRow;
  tabId: string;
}) {
  const running = row.status === "running";
  const failed = row.status === "failed";
  const shimmer = useVisibleAnimation<HTMLElement>();
  return (
    <Column>
      <button
        ref={running ? shimmer : undefined}
        type="button"
        onClick={() => openDetail(tabId, { kind: "subagent", toolCallId: row.toolCallId })}
        title={`${row.name} — open in side panel`}
        className={cn(
          "atlas-marker w-full min-w-0 cursor-pointer text-left text-base",
          failed ? "text-[var(--atlas-status-error-foreground)]" : "text-[var(--muted-foreground)]",
          "hover:text-[var(--secondary-foreground)]",
        )}
      >
        <span className="flex w-4 shrink-0 justify-center">
          <AgentOrb running={running} failed={failed} />
        </span>
        <span className={cn("min-w-0 truncate", running && "atlas-marker-running")}>
          {row.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums">
          {/* Only when the child reported work: a mail child's count is 0
              however much it did, and "0 calls" would say it did nothing. */}
          {row.workCount > 0 && <span>{formatCalls(row.workCount)}</span>}
          {SUBAGENT_STATE[row.status]}
          {row.endedAt === undefined ? (
            <LiveElapsed startedAt={row.startedAt} minMs={1000} />
          ) : (
            settledFigure(row.endedAt - row.startedAt)
          )}
        </span>
      </button>
    </Column>
  );
});

/**
 * A settled child's duration, or nothing when there is none to state.
 *
 * Under a second is what a child reads when nothing measured it — a reopened
 * session's async child, whose launch returned at once and whose own report
 * never reaches this session — and "0s" would be a claim, not a figure. The
 * live counter blanks below a second for the same reason.
 */
export function settledFigure(ms: number) {
  return ms >= 1000 ? <span>{formatWorked(ms)}</span> : null;
}

/** "1 call", "12 calls" — a child's work as the gutter counts it. */
export function formatCalls(n: number): string {
  return `${n} ${n === 1 ? "call" : "calls"}`;
}

/** What the gutter says after the name. Terminal states are words, not icons:
 *  "stopped" and "failed" are different facts and no glyph tells them apart at
 *  this size. */
export const SUBAGENT_STATE: Record<SubagentStatus, string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  interrupted: "stopped",
};

/**
 * The thinking orb that stands in for a tool glyph on a subagent's row.
 *
 * A filled disc rather than a line icon, so it reads as a presence among the
 * outlined tool glyphs instead of as another tool. Live, it breathes on the
 * shared marker shimmer — OPACITY ONLY, like every other animation in the
 * transcript: no transform and no layout, so a row's predicted height holds
 * and the scroll loop has nothing to re-measure.
 */
function AgentOrb({ running, failed }: { running: boolean; failed: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        failed
          ? "bg-[var(--atlas-status-error-foreground)]"
          : running
            ? "bg-[var(--primary)] atlas-marker-running"
            : "bg-[var(--atlas-text-disabled)]",
      )}
    />
  );
}

// ── Work header ────────────────────────────────────────────────────────────

/** "17s", "1m 29s", "7m 37s", "1h 3m" — compact elapsed-time format. */
export function formatWorked(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The live "Working for 46s" figure, written straight to the DOM once a second
 * — the same bargain as `useElapsed` in `loading-state.tsx`: the one element
 * that changes every second never goes through React, and a hidden window
 * stops painting it (the next visible paint is exact, being derived from
 * `startedAt`).
 */
export function LiveElapsed({ startedAt, minMs = 0 }: { startedAt: number; minMs?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      const ms = Date.now() - startedAt;
      // Below `minMs` the figure stays blank rather than reading "0s". A tool
      // marker uses this: most reads finish inside a frame or two, and a "0s"
      // blinking in and out beside every one of them is noise that says
      // nothing. The turn header leaves it at 0 — there, "Working for" needs
      // a figure after it from the first paint.
      if (ref.current) ref.current.textContent = ms < minMs ? "" : formatWorked(ms);
    };
    const paint = () => {
      if (document.visibilityState === "visible") write();
    };
    // The first write is unconditional: a row that mounts in a hidden window
    // must not sit on an empty "Working for" until it is shown.
    write();
    const id = window.setInterval(paint, 1000);
    document.addEventListener("visibilitychange", paint);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", paint);
    };
  }, [startedAt, minMs]);
  return <span ref={ref} className="tabular-nums" />;
}

/**
 * The head of an assistant turn: "Working for 46s" while it runs, then "Worked
 * for 7m 37s ›" with the work folded behind it. Clicking puts the earlier
 * prose, thinking and tool blocks back in the thread. Opening is instant — it
 * is a frequent, deliberate act, and the rows it reveals are ordinary rows.
 */
export const WorkHeaderRowView = memo(function WorkHeaderRowView({
  row,
  onToggle,
}: {
  row: WorkHeaderRow;
  onToggle: (id: string) => void;
}) {
  const label = row.live ? (
    row.startedAt !== null ? (
      <>
        Working for <LiveElapsed startedAt={row.startedAt} />
      </>
    ) : (
      "Working"
    )
  ) : row.workedMs !== null ? (
    <>
      {row.stopped ? "Stopped after" : "Worked for"}{" "}
      <span className="tabular-nums">{formatWorked(row.workedMs)}</span>
    </>
  ) : row.stopped ? (
    "Stopped"
  ) : (
    "Worked"
  );
  return (
    <Column className="pt-2 pb-2">
      <div className="flex items-center border-b border-[var(--atlas-border-subtle)] pb-2">
        {row.foldable ? (
          <button
            type="button"
            aria-expanded={row.open}
            onClick={() => onToggle(row.id)}
            className="flex h-[22px] cursor-pointer items-center gap-1 text-base text-[var(--muted-foreground)] transition-colors hover:text-[var(--secondary-foreground)]"
          >
            <span>{label}</span>
            <ChevronRight
              size={ICON_PX}
              strokeWidth={ICON_STROKE}
              className={cn("shrink-0 transition-transform", row.open && "rotate-90")}
            />
          </button>
        ) : (
          // The span matters: straight inside a flex box, "Working for " is its
          // own flex item and loses the trailing space before the figure.
          <div className="flex h-[22px] items-center text-base text-[var(--muted-foreground)]">
            <span>{label}</span>
          </div>
        )}
      </div>
    </Column>
  );
});

// ── Separator ──────────────────────────────────────────────────────────────

export const SeparatorRowView = memo(function SeparatorRowView({ row }: { row: SeparatorRow }) {
  return (
    <Column className="flex h-[34px] items-center">
      <div className="flex w-full select-none items-center gap-2">
        <span className="h-px flex-1 bg-[var(--atlas-border-subtle)]" />
        <span className="shrink-0 text-2xs text-[var(--muted-foreground)]">{row.label}</span>
        <span className="h-px flex-1 bg-[var(--atlas-border-subtle)]" />
      </div>
    </Column>
  );
});

// ── Turn footer ────────────────────────────────────────────────────────────

/**
 * The end of a turn: its changed-files card (or the quiet "N files read"
 * line), then the hover footer of the turn's last response. The footer is the
 * response's (`ProseRowActions`: copy, branch, pin, time), drawn here so it
 * comes after the card, at the end of the whole response, rather than between
 * the text and the card. It reveals on hovering this row or the response row
 * just above it (`[data-footer-below]` in `globals.css`).
 */
export const TurnFooterRowView = memo(function TurnFooterRowView({
  row,
  tabId,
  pinScopeKey,
  canBranch = false,
}: {
  row: TurnFooterRow;
  tabId: string;
  pinScopeKey: string;
  /** True when the response this footer belongs to may branch (the
   *  transcript's `canBranchRowId`, matched against `row.responseRowId`). */
  canBranch?: boolean;
}) {
  // A turn that changed files ends on its changed-files card. One that only
  // read keeps a single quiet line: there is no diff to open, and a card for
  // a list of reads would be the loudest thing under the turn.
  const edited = row.files.some((f) => f.kind === "edit");
  const responseRowId = row.responseRowId;
  return (
    // With a footer, `pb-11` is the old 16px gap plus the footer's 28px band
    // (`ProseRowActions`, placed `bottom-4`): reserved whether hovered or not,
    // so revealing it never moves anything.
    <Column className={cn("pt-1", responseRowId ? "relative pb-11" : "pb-4")}>
      {edited ? (
        <ChangedFilesCard turnKey={row.turnKey} tabId={tabId} files={row.files} />
      ) : (
        <div className="atlas-marker w-full text-base text-[var(--muted-foreground)]">
          <span className="flex w-4 shrink-0 justify-center">
            <Files size={ICON_PX} strokeWidth={ICON_STROKE} />
          </span>
          <span className="min-w-0 truncate">
            {row.files.length} file{row.files.length === 1 ? "" : "s"} read
          </span>
        </div>
      )}
      {responseRowId && (
        <ProseRowActions
          tabId={tabId}
          messageId={responseRowId.slice(2)}
          timestamp={row.responseTimestamp ?? ""}
          text={row.responseText ?? ""}
          pinScopeKey={pinScopeKey}
          canBranch={canBranch}
          showTimestamp={row.responseShowTimestamp ?? true}
          className="bottom-4"
        />
      )}
    </Column>
  );
});
