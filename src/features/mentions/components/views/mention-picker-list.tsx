// The mention picker's virtualized row list. Props-only: the container owns
// the search, the keyboard cursor and the scope; this renders rows and
// reports hover / activation back.

import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BookOpen,
  Bot,
  FileText,
  Boxes,
  Folder,
  FolderGit2,
  GitBranch,
  Hash,
  Layers,
  MessageSquare,
  MessageSquareQuote,
  MessagesSquare,
  Scale,
  SquareSlash,
  User,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MentionData, MentionKind, PastSessionRef } from "@/features/chat/lib/mentions";
import {
  mentionTitle,
  primaryLabel,
  secondaryLabel,
  type Row,
} from "../../lib/mention-picker-rows";

// ── Virtualized row list ────────────────────────────────────────────────────
//
// All row types render in a uniform 26 px slot so the virtualizer's
// estimateSize is exact and there's no jump on first measurement.
// Header rows visually have slightly different padding but still fit
// inside the slot, so we don't pay measureElement cost.

const ROW_HEIGHT = 26;
const PICKER_INNER_MAX_HEIGHT = 326; // 360 (picker max) − 34 (footer)

export function VirtualizedRows({
  rows,
  activeRowIdx,
  navIndices,
  setActive,
  setScope,
  setPastSession,
  onSelect,
}: {
  rows: Row[];
  activeRowIdx: number | undefined;
  navIndices: number[];
  setActive: (n: number) => void;
  setScope: (k: MentionKind) => void;
  setPastSession: (s: PastSessionRef) => void;
  onSelect: React.MutableRefObject<(m: MentionData) => void>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Auto-scroll so the active row stays visible as the user navigates
  // with the keyboard. Without this the active highlight can scroll
  // off-screen below the viewport on a long results list.
  useLayoutEffect(() => {
    if (activeRowIdx === undefined) return;
    virtualizer.scrollToIndex(activeRowIdx, { align: "auto" });
  }, [activeRowIdx, virtualizer]);

  // O(1) rowIdx → navIdx lookup for hover. The inline handlers used to run
  // `navIndices.indexOf(i)` — a linear scan per mouseenter event.
  const navIdxByRow = useMemo(() => {
    const map = new Map<number, number>();
    navIndices.forEach((rowIdx, navIdx) => map.set(rowIdx, navIdx));
    return map;
  }, [navIndices]);

  // Hover re-targets the active row ONLY while not scrolling. During a wheel
  // flick, rows slide under a stationary cursor and fire mouseenter per
  // frame; each setActive re-rendered the whole visible window mid-scroll —
  // the same class of jank the chat virtualizer fixed by gating work on
  // "is the user scrolling".
  const handleHover = useCallback(
    (rowIdx: number) => {
      if (virtualizer.isScrolling) return;
      const navIdx = navIdxByRow.get(rowIdx);
      if (navIdx !== undefined) setActive(navIdx);
    },
    [virtualizer, navIdxByRow, setActive],
  );

  const handleActivate = useCallback(
    (row: Row) => {
      if (row.type === "category") {
        setScope(row.cat.kind);
        setActive(0);
      } else if (row.type === "session") {
        setPastSession(row.session);
        setActive(0);
      } else if (row.type === "mention") {
        onSelect.current(row.mention);
      }
    },
    [setScope, setPastSession, setActive, onSelect],
  );

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto overflow-x-hidden py-1"
      style={{ maxHeight: PICKER_INNER_MAX_HEIGHT }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {/* Key by the virtualizer's slot, not row content. Content-derived
            keys collided while async results streamed in (the same mention
            surfacing in two list revisions at different indices), which left
            stale absolutely-positioned nodes double-painted in one slot. */}
        {virtualizer.getVirtualItems().map((vRow) => (
          <PickerRow
            key={vRow.key}
            row={rows[vRow.index]}
            rowIdx={vRow.index}
            start={vRow.start}
            isActive={vRow.index === activeRowIdx}
            onHover={handleHover}
            onActivate={handleActivate}
          />
        ))}
      </div>
    </div>
  );
}

/** One row, memoized: a hover/keyboard move flips `isActive` on exactly two
 *  rows, so every other visible row skips re-rendering — that full-window
 *  re-render per mouse movement was the bulk of the picker's scroll cost. */
const PickerRow = memo(function PickerRow({
  row,
  rowIdx,
  start,
  isActive,
  onHover,
  onActivate,
}: {
  row: Row;
  rowIdx: number;
  start: number;
  isActive: boolean;
  onHover: (rowIdx: number) => void;
  onActivate: (row: Row) => void;
}) {
  const style: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: ROW_HEIGHT,
    transform: `translateY(${start}px)`,
  };
  if (row.type === "header") {
    return (
      <div style={style} className="eyebrow px-3 pt-2 pb-1 truncate">
        {row.label}
      </div>
    );
  }
  const common = {
    style,
    onMouseEnter: () => onHover(rowIdx),
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      onActivate(row);
    },
    className: cn(
      "text-left px-3 flex items-center gap-2 text-sm",
      isActive
        ? "bg-element-selected text-foreground"
        : "text-secondary-foreground hover:bg-element-hover",
    ),
  };
  if (row.type === "category") {
    return (
      <button {...common}>
        <span className="opacity-75 w-4 flex items-center justify-center">
          <CategoryIcon kind={row.cat.kind} />
        </span>
        <span>{row.cat.label}</span>
      </button>
    );
  }
  if (row.type === "session") {
    return (
      <button {...common} title={row.session.title}>
        <span className="opacity-75 w-4 flex items-center justify-center">
          <MessageSquare size={11} />
        </span>
        <span className="truncate flex-1 min-w-0">{row.session.title}</span>
        <span className="text-2xs text-muted-foreground shrink-0">
          {row.session.messageCount} msgs
        </span>
      </button>
    );
  }
  const m = row.mention;
  return (
    <button {...common} title={mentionTitle(m)}>
      <span className="opacity-75 w-4 flex items-center justify-center">
        {m.kind === "knowledge" && m.icon ? (
          <span style={{ fontSize: "var(--text-sm)", lineHeight: 1 }}>{m.icon}</span>
        ) : (
          mentionGlyph(m)
        )}
      </span>
      <span className="truncate min-w-0">{primaryLabel(m)}</span>
      <span className="flex-1 min-w-0 text-2xs text-muted-foreground truncate">
        {row.recentLabel ?? secondaryLabel(m)}
      </span>
    </button>
  );
});

/** Per-row icon. Pack components get a glyph per their componentKind so
 *  commands/agents/rules are distinguishable at a glance; everything else
 *  falls back to its category icon. */
function mentionGlyph(m: MentionData) {
  const size = 11;
  if (m.kind === "component") {
    switch (m.componentKind) {
      case "command":
        return <SquareSlash size={size} />;
      case "agent":
        return <Bot size={size} />;
      case "rule":
        return <Scale size={size} />;
    }
  }
  return <CategoryIcon kind={m.kind} />;
}

function CategoryIcon({ kind }: { kind: MentionKind }) {
  const size = 11;
  switch (kind) {
    case "file":
      return <FileText size={size} />;
    case "folder":
      return <Folder size={size} />;
    case "symbol":
      return <Hash size={size} />;
    case "knowledge":
      return <BookOpen size={size} />;
    case "component":
      return <Zap size={size} />;
    case "repo":
      return <FolderGit2 size={size} />;
    case "workspace":
      return <Boxes size={size} />;
    case "branch":
      return <GitBranch size={size} />;
    case "past_message":
      return <MessageSquare size={size} />;
    case "past_session":
      return <MessageSquare size={size} />;
    // Organisation kinds reuse the icons their surfaces already use: the
    // commit avatar's person, the comms panel's conversations, the Timeline
    // tab's layers — so a recorded session never looks like a past session.
    case "member":
      return <User size={size} />;
    case "conversation":
      return <MessagesSquare size={size} />;
    case "recorded_session":
      return <Layers size={size} />;
    case "comment":
      return <MessageSquareQuote size={size} />;
  }
}
