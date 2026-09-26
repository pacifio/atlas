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

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  BookOpen,
  Building2,
  ChevronRight,
  Paperclip,
  Brain,
  Bookmark,
  Code2,
  ChevronDown,
  File,
  FolderClosed,
  Globe,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { StreamingMarkdown } from "./streaming-markdown";
import { openDetail } from "../stores/detail-panel-store";
import { openTurnDiff } from "../lib/open-turn-diff";
import { UserRowActions } from "./user-row-actions";
import { ImageAttachmentStrip } from "./image-attachments";
import { RowCommentPill, TurnCommentPill, useRowHasComments } from "./chat-comment-pills";
import { ProseRowActions } from "./prose-row-actions";
import type {
  UserRow,
  ProseRow,
  ThinkingRow,
  MarkerRow,
  MarkerGroupRow,
  SeparatorRow,
  TurnFooterRow,
  WorkHeaderRow,
  MarkerTool,
} from "../lib/turn-rows";
import { userRowMessageId } from "../lib/turn-rows";
import { M } from "../lib/row-metrics";

/** Shared by every row: the centred content column. */
function Column({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[760px] px-6", className)}>{children}</div>;
}

// ── User ───────────────────────────────────────────────────────────────────

export const UserRowView = memo(function UserRowView({
  row,
  tabId,
  priority,
  justSent = false,
  canRetry = false,
  pinScopeKey,
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
  onToggleExpand: (id: string) => void;
}) {
  const clampRef = useRef<HTMLDivElement>(null);
  const clampHeight = useWholeLineClamp(clampRef, !row.expanded);
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
        <ExpandToggle row={row} onToggleExpand={onToggleExpand} />
        <UserRowActions
          tabId={tabId}
          text={row.text}
          canRetry={canRetry}
          messageId={userRowMessageId(row.id)}
          timestamp={row.timestamp}
          pinScopeKey={pinScopeKey}
          toggleAbove={clampable(row)}
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
 * Re-measured on resize of the markdown root, which covers both a width change
 * (the lines rewrap) and the raw-source placeholder swapping to parsed HTML.
 */
function useWholeLineClamp(ref: React.RefObject<HTMLDivElement | null>, active: boolean): number {
  const [height, setHeight] = useState(USER_CLAMP_PX);
  useLayoutEffect(() => {
    const root = ref.current?.firstElementChild;
    if (!active || !(root instanceof HTMLElement)) return;
    const measure = () => {
      if (root.scrollHeight <= USER_CLAMP_PX) {
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
  return height;
}

/**
 * "Show more" / "Show less", rendered only when the bubble is long enough that
 * the height clamp actually bites.
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
  if (!clampable(row)) return null;
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

/**
 * Is this bubble long enough that the height clamp bites — i.e. does it get a
 * "Show more" toggle?
 *
 * A cheap approximation rather than a measurement: a short, newline-free
 * prompt is never clamped, so the common case costs a length check and no
 * layout read. Being slightly conservative only means the affordance appears
 * on a prompt that did not strictly need it.
 *
 * Shared, not duplicated: `UserRowActions` needs the same answer to decide its
 * own top padding (the toggle sits between the bubble and the action bar, so
 * the bar must not add a second gap on top of it). The two drifting apart
 * would show up as uneven spacing on exactly the rows that have a toggle.
 */
function clampable(row: UserRow): boolean {
  return row.text.length > 220 || row.text.split("\n").length > M.userMaxLines;
}

// ── Prose ──────────────────────────────────────────────────────────────────

export const ProseRowView = memo(function ProseRowView({
  row,
  tabId,
  agentLabel,
  priority,
  pinScopeKey,
}: {
  row: ProseRow;
  tabId: string;
  agentLabel: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  pinScopeKey: string;
}) {
  return (
    // A settled response reserves the gap its action bar sits in (see
    // `prose-row-actions.tsx`); the streaming tail does not — nothing here
    // works on a response that is still arriving, and the one reflow happens
    // when the turn ends, deliberately.
    <Column className={cn("py-2", !row.streaming && "relative pb-7")}>
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
          <span aria-hidden className="shrink-0 text-2xs text-[var(--atlas-text-disabled)]">
            ·
          </span>
          <span className="shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
            {new Date(row.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
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
          className="atlas-prose"
        />
      ) : (
        <CachedMarkdown source={row.text} unstyled priority={priority} className="atlas-prose" />
      )}
      {!row.streaming && (
        <ProseRowActions
          tabId={tabId}
          messageId={row.id.slice(2)}
          timestamp={row.timestamp}
          text={row.text}
          pinScopeKey={pinScopeKey}
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
  const toggle = (
    <button
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
      <span>{row.streaming ? "Thinking…" : "Thought process"}</span>
      <ChevronRight
        size={ICON_PX}
        strokeWidth={ICON_STROKE}
        className={cn("transition-transform", row.expanded && "rotate-90")}
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
 * One icon per `MarkerTool` key, in the Codex desktop app's vocabulary: the
 * wrench for a loaded tool, the book for a read, the boxed prompt for a
 * command, the folder for a listing, the magnifier for a search.
 *
 * Shapes only, never colours (house rule 2) — the one tint is red on failure.
 * Keyed by the projection's classification so rows stay plain data; see
 * `MarkerTool` in `turn-rows.ts` for how each call is classified.
 */
const TOOL_ICON: Record<MarkerTool, LucideIcon> = {
  run: SquareTerminal,
  read: BookOpen,
  edit: Pencil,
  search: Search,
  list: FolderClosed,
  fetch: Globe,
  // A delegated sub-agent is a different KIND of work from a file read.
  think: Brain,
  delete: Trash2,
  move: ArrowRightLeft,
  file: File,
  // An organisation call (ADR-0014): the building the organisation screens
  // already use.
  org: Building2,
  tool: Wrench,
};

/** Near the height of the 13px row text, drawn at the thin stroke Codex uses. */
const ICON_PX = 14;
const ICON_STROKE = 1.5;

/** A tool call's (or a block's) leading icon, red when it failed. */
function ToolGlyph({ tool, failed }: { tool: MarkerTool; failed: boolean }) {
  const Icon = TOOL_ICON[tool];
  return (
    <Icon
      size={ICON_PX}
      strokeWidth={ICON_STROKE}
      className={failed ? "text-[var(--atlas-status-error-foreground)]" : undefined}
    />
  );
}

/** Rows whose detail is a file the reader can open — only these get the dimmer,
 *  dotted-underline link treatment. A command or a search pattern is not a
 *  link, so it stays in the verb's tone. */
const FILE_DETAIL = new Set<MarkerTool>(["read", "edit", "file"]);

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

  const line = (
    <button
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
  return embedded ? body : <Column>{body}</Column>;
});

/**
 * A folded sequence of consecutive tool calls, kept between the prose around it.
 *
 * One sentence you click — "Read files, ran commands" — matching the Codex
 * desktop app, led by the icon of the sentence's first fragment. While a call
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
  return (
    <Column className="py-1">
      <button
        type="button"
        aria-expanded={row.open}
        aria-controls={`${row.id}:actions`}
        onClick={() => onExpandTurn(row.id)}
        className="atlas-marker group/tool-summary max-w-full cursor-pointer text-left text-base text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]"
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

// ── Work header ────────────────────────────────────────────────────────────

/** "17s", "1m 29s", "7m 37s", "1h 3m" — the Codex desktop app's format. */
function formatWorked(ms: number): string {
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
function LiveElapsed({ startedAt, minMs = 0 }: { startedAt: number; minMs?: number }) {
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
  tabId,
  onToggle,
}: {
  row: WorkHeaderRow;
  tabId: string;
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
      Worked for <span className="tabular-nums">{formatWorked(row.workedMs)}</span>
    </>
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
        {/* Every thread inside the fold, summed. Opens the fold, where the
            rows carry their own pills. Nothing at zero. */}
        <TurnCommentPill
          tabId={tabId}
          turnId={row.turnId}
          onOpen={() => {
            if (row.foldable && !row.open) onToggle(row.id);
          }}
        />
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

export const TurnFooterRowView = memo(function TurnFooterRowView({
  row,
  onSaveKb,
}: {
  row: TurnFooterRow;
  onSaveKb: () => void;
}) {
  // `row.files` is the first three; `row.allFiles` is everything. The overflow
  // line is a disclosure, not a dead count.
  const [showAll, setShowAll] = useState(false);
  const files = showAll ? row.allFiles : row.files;
  const edits = row.allFiles.filter((f) => f.kind === "edit");
  const added = edits.reduce((s, f) => s + f.added, 0);
  const removed = edits.reduce((s, f) => s + f.removed, 0);
  const label =
    edits.length > 0
      ? `${edits.length} file${edits.length === 1 ? "" : "s"} changed`
      : `${row.allFiles.length} file${row.allFiles.length === 1 ? "" : "s"} read`;

  return (
    <Column className="pb-5 pt-2">
      {/* Full measure width, lifted off the background so it reads as the
          turn's result rather than another paragraph. Paths show basename only:
          the leading directories are identical on every row and were eating the
          width. */}
      <div className="overflow-hidden rounded-xl border border-[var(--atlas-element-active)] bg-[var(--atlas-element-hover)]">
        <div className="flex h-[34px] items-center gap-2 px-3.5">
          <span className="label">{label}</span>
          {(added > 0 || removed > 0) && (
            <span className="font-mono text-2xs tabular-nums">
              {added > 0 && <span className="text-[var(--atlas-diff-added-text)]">+{added}</span>}
              {removed > 0 && (
                <span className="ml-1 text-[var(--atlas-status-error-foreground)]">−{removed}</span>
              )}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <FooterPill
              icon={<Bookmark size={11} />}
              label="Save"
              title="Save this thread to the knowledge base"
              onClick={onSaveKb}
            />
            {edits.length > 0 && (
              <FooterPill
                icon={<Code2 size={11} />}
                label="Show changes"
                // The whole turn: its files fill the tree and the first opens.
                onClick={() => openTurnDiff(row.turnId)}
              />
            )}
          </div>
        </div>
        <div className="border-t border-[var(--atlas-element-selected)] px-3.5 py-2">
          {files.map((f) => (
            <div key={f.path} className="flex h-[24px] items-center gap-2 text-xs" title={f.path}>
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-2xs font-semibold",
                  f.kind === "edit"
                    ? f.created
                      ? "text-[var(--atlas-diff-added-text)]"
                      : "text-[var(--atlas-status-warning-foreground)]"
                    : "text-[var(--muted-foreground)]",
                )}
              >
                {f.kind === "edit" ? (f.created ? "A" : "M") : "R"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--secondary-foreground)]">
                {baseName(f.path)}
              </span>
              {f.kind === "edit" && (f.added > 0 || f.removed > 0) && (
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  {f.added > 0 && (
                    <span className="text-[var(--atlas-diff-added-text)]">+{f.added}</span>
                  )}
                  {f.removed > 0 && (
                    <span className="ml-1 text-[var(--atlas-status-error-foreground)]">
                      −{f.removed}
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
          {row.overflow > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex h-[20px] cursor-pointer items-center gap-1 text-2xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--secondary-foreground)]"
            >
              <ChevronDown
                size={10}
                className={cn("transition-transform", showAll && "rotate-180")}
              />
              {showAll ? "Show fewer" : `+${row.overflow} more`}
            </button>
          )}
        </div>
      </div>
    </Column>
  );
});

/** Last path segment — the directories repeat on every row and cost width. */
function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function FooterPill({
  icon,
  label,
  onClick,
  primary,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "inline-flex h-[20px] cursor-pointer items-center gap-1 rounded-full border px-2",
        "text-2xs font-medium leading-none transition-colors",
        primary
          ? "border-[var(--primary)]/40 bg-[var(--atlas-primary-muted)] text-[var(--primary)] hover:bg-[var(--primary)]/20"
          : "border-border bg-[var(--atlas-element-hover)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
