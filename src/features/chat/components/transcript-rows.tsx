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
//     grey. Per-tool icon colours are the "moving blocks" problem in a new
//     costume — resist them.
//  3. Rows never subscribe to the chat store or the detail-panel store. Data
//     arrives as props; actions are fired imperatively via `getState()`.

import { memo, useCallback, useState } from "react";
import {
  Check,
  X,
  Circle,
  ChevronRight,
  Paperclip,
  Brain,
  Bookmark,
  Workflow,
  Code2,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { StreamingMarkdown } from "./streaming-markdown";
import { openDetail } from "../stores/detail-panel-store";
import { openTurnDiff } from "../lib/open-turn-diff";
import { canDrawDiagram } from "../lib/turn-actions";
import type {
  UserRow,
  ProseRow,
  ThinkingRow,
  MarkerRow,
  MarkerGroupRow,
  SeparatorRow,
  TurnFooterRow,
  MarkerState,
} from "../lib/turn-rows";
import { M } from "../lib/row-metrics";

/** Shared by every row: the centred content column. */
function Column({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[760px] px-6", className)}>{children}</div>;
}

// ── User ───────────────────────────────────────────────────────────────────

export const UserRowView = memo(function UserRowView({
  row,
  priority,
  onToggleExpand,
}: {
  row: UserRow;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  onToggleExpand: (id: string) => void;
}) {
  return (
    // Generous space BELOW the prompt: the gap is what separates one exchange
    // from the next, and a tight one made the agent's reply read as a
    // continuation of the user's own message.
    <Column className="flex justify-end pt-6 pb-5">
      {/* `min-w-0` on both flex levels, `max-w-full` on the bubble: a pasted
          code block is `white-space: pre` (unwrappable), and a flex item's
          automatic minimum size floors at that intrinsic width — the pre's own
          `overflow-x: auto` cannot save an ancestor that refuses to shrink, so
          a long paste dragged the whole bubble past the viewport edge. With
          the chain capped, the fence scrolls horizontally INSIDE the bubble. */}
      <div className="flex min-w-0 max-w-[80%] flex-col items-end">
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
            "atlas-prose atlas-prose--user min-w-0 max-w-full rounded-[20px] bg-[var(--accent-primary-muted)] px-4 py-2.5 select-text",
            // Entrance only for a message sent JUST NOW — history rows mounted
            // by the scroll window must not replay it (see globals.css).
            Date.now() - Date.parse(row.timestamp) < 3000 && "atlas-bubble-in",
          )}
          style={
            row.expanded
              ? undefined
              : {
                  maxHeight: M.userMaxLines * M.userLineHeight,
                  overflow: "hidden",
                }
          }
        >
          <CachedMarkdown source={row.text} unstyled priority={priority} />
        </div>
        {row.contextBlocks > 0 && (
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer transition-colors"
            title="Context attached with @-mentions"
          >
            <Paperclip size={10} />
            {row.contextBlocks} attached
          </button>
        )}
        <ExpandToggle row={row} onToggleExpand={onToggleExpand} />
      </div>
    </Column>
  );
});

/** Rendered only when the bubble is long enough to actually be clamped. */
function ExpandToggle({
  row,
  onToggleExpand,
}: {
  row: UserRow;
  onToggleExpand: (id: string) => void;
}) {
  // Cheap approximation rather than measuring: a short, newline-free prompt is
  // never clamped, so the common case costs a length check. Being slightly
  // conservative here only means the affordance appears on a prompt that did not
  // strictly need it.
  const maybeLong = row.text.length > 220 || row.text.split("\n").length > M.userMaxLines;
  if (!maybeLong) return null;
  return (
    <button
      type="button"
      onClick={() => onToggleExpand(row.id)}
      className="mt-0.5 h-[18px] text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer transition-colors"
    >
      {row.expanded ? "Show less" : "Show more"}
    </button>
  );
}

// ── Prose ──────────────────────────────────────────────────────────────────

export const ProseRowView = memo(function ProseRowView({
  row,
  agentLabel,
  agentIcon,
  priority,
}: {
  row: ProseRow;
  agentLabel: string;
  agentIcon: React.ReactNode;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
}) {
  return (
    <Column className="py-2">
      {/* Identity on the left (glyph + which model wrote this), timestamp
          pushed right. The agent's NAME is dropped: the glyph already says it,
          and it was the least useful token in a line that has to compete with
          the prose underneath it. */}
      {row.showHeader && (
        <div className="flex h-[22px] items-center gap-2">
          <span
            className="grid size-4 shrink-0 place-items-center"
            title={agentLabel}
            aria-label={agentLabel}
          >
            {agentIcon}
          </span>
          {row.model && (
            <span className="min-w-0 truncate font-mono text-[10px] text-[var(--text-tertiary)]">
              {row.model}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--text-tertiary)]">
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
    </Column>
  );
});

// ── Thinking ───────────────────────────────────────────────────────────────

export const ThinkingRowView = memo(function ThinkingRowView({
  row,
  onToggleExpand,
}: {
  row: ThinkingRow;
  onToggleExpand: (id: string) => void;
}) {
  return (
    <Column>
      <button
        type="button"
        onClick={() => onToggleExpand(row.id)}
        className="flex h-[26px] w-full items-center gap-2 text-left text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer transition-colors"
      >
        <Brain size={11} className={cn(row.streaming && "atlas-marker-running")} />
        <span>{row.streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronRight
          size={11}
          className={cn("transition-transform", row.expanded && "rotate-90")}
        />
      </button>
      {row.expanded && (
        <div className="pb-3 pl-[19px]">
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[19px] text-[var(--text-tertiary)] select-text">
            {row.text}
          </pre>
        </div>
      )}
    </Column>
  );
});

// ── Marker ─────────────────────────────────────────────────────────────────

function StateGlyph({ state }: { state: MarkerState }) {
  if (state === "failed") return <X size={11} className="text-[var(--status-error)]" />;
  if (state === "done") return <Check size={11} className="text-[var(--text-tertiary)]" />;
  if (state === "running")
    return (
      <Circle
        size={9}
        className="atlas-marker-running fill-[var(--accent-primary)] text-[var(--accent-primary)]"
      />
    );
  return <Circle size={9} className="text-[var(--text-tertiary)]" />;
}

/**
 * One tool call: a single muted line, and nothing else.
 *
 * Deliberately NOT expandable. An inline disclosure per marker meant a
 * tool-heavy turn carried dozens of collapsed panels, each one more layout the
 * scroller had to reason about — and expanding one changed the height of the
 * document under the reader. Detail belongs in the side panel, which is what
 * the trailing chevron opens. One row, one height, forever.
 */
export const MarkerRowView = memo(function MarkerRowView({
  row,
  tabId,
}: {
  row: MarkerRow;
  tabId: string;
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

  return (
    <Column>
      <div
        onClick={clickable ? onClick : undefined}
        className={cn(
          "atlas-marker text-[11px] text-[var(--text-tertiary)]",
          clickable && "cursor-pointer hover:text-[var(--text-secondary)]",
          row.state === "running" && "atlas-marker-running",
        )}
        title={clickable ? `${row.verb} ${row.detail} — open in side panel` : undefined}
      >
        <span className="flex w-3 shrink-0 justify-center">
          <StateGlyph state={row.state} />
        </span>
        <span className="shrink-0">{row.verb}</span>
        {row.detail && (
          <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-tertiary)]/85">
            {row.detail}
          </span>
        )}
        {(row.added > 0 || row.removed > 0) && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            {row.added > 0 && <span className="text-[var(--diff-added-text)]">+{row.added}</span>}
            {row.removed > 0 && (
              <span className="ml-1 text-[var(--status-error)]">−{row.removed}</span>
            )}
          </span>
        )}
        {clickable && (
          <ChevronRight
            size={11}
            className={cn("shrink-0", !row.added && !row.removed && "ml-auto")}
          />
        )}
      </div>
    </Column>
  );
});

/**
 * The folded tool-call block — the Session timeline's "Show tool calls" applied
 * to a turn. Two lines: a summary of what happened, and the disclosure.
 */
export const MarkerGroupRowView = memo(function MarkerGroupRowView({
  row,
  onExpandTurn,
}: {
  row: MarkerGroupRow;
  onExpandTurn: (turnId: string) => void;
}) {
  return (
    <Column className="py-3">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="font-medium text-[var(--text-secondary)]">Tool calls</span>
        {row.duration && (
          <span className="font-mono text-[10px] text-[var(--text-tertiary)]">{row.duration}</span>
        )}
        <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
          {row.count} {row.count === 1 ? "call" : "calls"}
        </span>
        {row.modified > 0 && (
          <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
            {row.modified} modified
          </span>
        )}
        {row.added > 0 && (
          <span className="font-mono text-[10px] text-[var(--diff-added-text)]">+{row.added}</span>
        )}
      </div>
      {/* While the turn runs the markers below are live progress, so there is
          nothing to disclose — the control only appears once they fold. */}
      {!row.running && (
        <button
          type="button"
          onClick={() => onExpandTurn(row.turnId)}
          className="mt-0.5 flex cursor-pointer items-center gap-1 text-[11px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
        >
          {row.open ? "Hide tool calls" : "Show tool calls"}
          <ChevronRight size={11} className={cn("transition-transform", row.open && "rotate-90")} />
        </button>
      )}
    </Column>
  );
});

// ── Separator ──────────────────────────────────────────────────────────────

export const SeparatorRowView = memo(function SeparatorRowView({ row }: { row: SeparatorRow }) {
  return (
    <Column className="flex h-[34px] items-center">
      <div className="flex w-full select-none items-center gap-2">
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{row.label}</span>
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
    </Column>
  );
});

// ── Turn footer ────────────────────────────────────────────────────────────

export const TurnFooterRowView = memo(function TurnFooterRowView({
  row,
  onSaveKb,
  onDiagram,
}: {
  row: TurnFooterRow;
  onSaveKb: () => void;
  /** Stable across renders; the messageId binding happens in here so the memo
   *  holds (an inline `() => onDiagram(id)` prop defeated it). */
  onDiagram: (messageId: string) => void;
}) {
  const canDiagram = canDrawDiagram(row.files);
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
      <div className="overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.035]">
        <div className="flex h-[34px] items-center gap-2 px-3.5">
          <span className="text-[11px] font-medium text-[var(--text-primary)]">{label}</span>
          {(added > 0 || removed > 0) && (
            <span className="font-mono text-[10px] tabular-nums">
              {added > 0 && <span className="text-[var(--diff-added-text)]">+{added}</span>}
              {removed > 0 && <span className="ml-1 text-[var(--status-error)]">−{removed}</span>}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <FooterPill
              icon={<Bookmark size={11} />}
              label="Save"
              title="Save this thread to the knowledge base"
              onClick={onSaveKb}
            />
            {canDiagram && (
              <FooterPill
                icon={<Workflow size={11} />}
                label="Diagram"
                title="Draw a diagram of these changes"
                onClick={() => onDiagram(row.messageId)}
              />
            )}
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
        <div className="border-t border-white/[0.06] px-3.5 py-2">
          {files.map((f) => (
            <div
              key={f.path}
              className="flex h-[24px] items-center gap-2 text-[11px]"
              title={f.path}
            >
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[10px] font-semibold",
                  f.kind === "edit"
                    ? f.created
                      ? "text-[var(--diff-added-text)]"
                      : "text-[#e0af68]"
                    : "text-[var(--text-tertiary)]",
                )}
              >
                {f.kind === "edit" ? (f.created ? "A" : "M") : "R"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">
                {baseName(f.path)}
              </span>
              {f.kind === "edit" && (f.added > 0 || f.removed > 0) && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  {f.added > 0 && <span className="text-[var(--diff-added-text)]">+{f.added}</span>}
                  {f.removed > 0 && (
                    <span className="ml-1 text-[var(--status-error)]">−{f.removed}</span>
                  )}
                </span>
              )}
            </div>
          ))}
          {row.overflow > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex h-[20px] cursor-pointer items-center gap-1 text-[10px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
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
        "text-[10px] font-medium leading-none transition-colors",
        primary
          ? "border-[var(--accent-primary)]/40 bg-[var(--accent-primary-muted)] text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/20"
          : "border-white/[0.12] bg-white/[0.04] text-[var(--text-secondary)] hover:bg-white/[0.09] hover:text-[var(--text-primary)]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
