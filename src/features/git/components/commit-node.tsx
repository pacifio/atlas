import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  type CommitRow,
  type LaneSegment,
  type RefBadge,
  LANE_WIDTH,
  ROW_HEIGHT,
  GRAPH_LEFT_PAD,
} from "../lib/git-graph";
import { CommitAvatar } from "./commit-avatar";

interface CommitRowViewProps {
  row: CommitRow;
  /** The repository the graph shows — avatars are looked up there. */
  repoPath: string;
  selected: boolean;
  compact: boolean;
  onSelect: (sha: string) => void;
}

function laneX(lane: number): number {
  return GRAPH_LEFT_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function segmentPath(seg: LaneSegment): string {
  const x1 = laneX(seg.fromLane);
  const x2 = laneX(seg.toLane);
  const y1 = seg.fromY * ROW_HEIGHT;
  const y2 = seg.toY * ROW_HEIGHT;
  if (x1 === x2) {
    return `M${x1},${y1} L${x2},${y2}`;
  }
  const cy = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
}

function badgeClass(kind: RefBadge["kind"], isCurrent: boolean) {
  if (kind === "tag") {
    return "bg-[var(--muted-foreground)]/15 text-[var(--muted-foreground)] border-[var(--muted-foreground)]/30";
  }
  if (kind === "remote") {
    return "bg-[var(--card)] text-[var(--muted-foreground)] border-[var(--border)]";
  }
  if (isCurrent) {
    return "bg-[var(--primary)]/20 text-[var(--primary)] border-[var(--primary)]/40";
  }
  return "bg-[var(--card)] text-[var(--secondary-foreground)] border-[var(--border)]";
}

export const CommitRowView = memo(function CommitRowView({
  row,
  repoPath,
  selected,
  compact,
  onSelect,
}: CommitRowViewProps) {
  // Per-row gutter width — just wide enough for THIS row's drawing extents.
  // Labels sit immediately after, so a commit on lane 0 hugs the left edge
  // while a commit deeper in the tree pushes its label further right.
  let rowMaxLane = row.commitLane;
  for (const s of row.segments) {
    if (s.fromLane > rowMaxLane) rowMaxLane = s.fromLane;
    if (s.toLane > rowMaxLane) rowMaxLane = s.toLane;
  }
  const gutterWidth = GRAPH_LEFT_PAD + (rowMaxLane + 2) * LANE_WIDTH;
  // Only branch-class refs in compact mode; fullscreen shows all.
  const visibleRefs = compact ? row.refs.filter((r) => r.kind === "branch") : row.refs;

  return (
    <div
      onClick={() => onSelect(row.sha)}
      className={cn(
        "group flex items-center cursor-pointer select-none",
        selected
          ? "bg-[var(--primary)]/15 text-[var(--foreground)]"
          : "hover:bg-element-hover text-[var(--secondary-foreground)]",
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {/* SVG gutter */}
      <svg width={gutterWidth} height={ROW_HEIGHT} className="shrink-0" aria-hidden>
        {row.segments.map((seg, idx) => (
          <path
            key={idx}
            d={segmentPath(seg)}
            stroke={seg.color}
            strokeWidth={1.5}
            fill="none"
            shapeRendering="geometricPrecision"
          />
        ))}
        <circle
          cx={laneX(row.commitLane)}
          cy={ROW_HEIGHT / 2}
          r={3.5}
          fill={row.commitColor}
          stroke={row.isHead ? "var(--primary)" : "transparent"}
          strokeWidth={row.isHead ? 1.5 : 0}
        />
      </svg>

      {/* Row content — flush against the gutter; per-row gutter sizing handles the offset */}
      <div className={cn("flex-1 min-w-0 flex items-center gap-2 pl-0", compact ? "pr-3" : "pr-4")}>
        {/* Refs + message — flexes to fill remaining space */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {visibleRefs.slice(0, 4).map((r) => (
            <span
              key={`${r.kind}:${r.name}`}
              className={cn(
                "px-1 h-[14px] rounded-sm border text-3xs font-mono leading-none flex items-center shrink-0",
                badgeClass(r.kind, r.isCurrent),
              )}
              title={`${r.kind}: ${r.name}`}
            >
              {r.name}
            </span>
          ))}
          <span
            className={cn(
              "text-sm truncate",
              selected ? "text-[var(--foreground)] font-medium" : "",
            )}
          >
            {row.message}
          </span>
        </div>
        {!compact && (
          <>
            {/* Author column — fixed width, avatar + name, aligned across all rows */}
            <div className="flex items-center gap-1.5 w-[200px] shrink-0">
              <CommitAvatar email={row.email} repoPath={repoPath} size={16} />
              <span className="text-xs text-[var(--secondary-foreground)] truncate">
                {row.author}
              </span>
            </div>
            {/* Short sha column */}
            <span className="text-xs font-mono text-[var(--muted-foreground)] shrink-0 w-[68px]">
              {row.shortSha}
            </span>
            {/* Date column */}
            <span className="text-xs font-mono text-[var(--muted-foreground)] shrink-0 w-[160px] text-right">
              {row.date}
            </span>
          </>
        )}
      </div>
    </div>
  );
});
