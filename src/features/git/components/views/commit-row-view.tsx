import { memo } from "react";
import { Tag as TagGlyph } from "lucide-react";
import { Badge, Icon } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import {
  type CommitRow,
  type LaneSegment,
  type RefBadge,
  LANE_WIDTH,
  ROW_HEIGHT,
  GRAPH_LEFT_PAD,
} from "../../lib/git-graph";
import { CommitAvatar } from "../commit-avatar";

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

/** A ref chip. Branches are outlined (the checked-out one carries a primary
 *  dot); remotes and tags sit back on the card fill, a tag with its glyph. */
function RefChip({ refBadge }: { refBadge: RefBadge }) {
  const { kind, name, isCurrent } = refBadge;
  const branch = kind !== "tag" && kind !== "remote";
  return (
    <Badge
      variant={branch ? "outline" : "secondary"}
      size="sm"
      className="font-mono"
      title={`${kind}: ${name}`}
    >
      {branch && isCurrent ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      ) : null}
      {kind === "tag" ? <Icon icon={TagGlyph} size="xs" /> : null}
      {name}
    </Badge>
  );
}

/**
 * One commit in the graph: the lane gutter (an SVG per row, so the lines are
 * drawn by the browser and need no measuring), the ref chips and message, and
 * in fullscreen the author, short sha and date columns.
 *
 * Lane colours arrive from Rust (`git_graph.rs`) as finished values, so they
 * are passed to the SVG as presentation attributes rather than classes.
 */
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
        "group flex items-center cursor-pointer select-none transition-colors duration-fast",
        selected
          ? "bg-element-selected text-foreground"
          : "text-secondary-foreground hover:bg-element-hover",
      )}
      style={{ height: ROW_HEIGHT }}
    >
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
          className={row.isHead ? "stroke-primary" : undefined}
          strokeWidth={row.isHead ? 1.5 : 0}
        />
      </svg>

      {/* Row content — flush against the gutter; per-row gutter sizing handles the offset */}
      <div className={cn("flex min-w-0 flex-1 items-center gap-2", compact ? "pr-3" : "pr-4")}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {visibleRefs.slice(0, 4).map((r) => (
            <RefChip key={`${r.kind}:${r.name}`} refBadge={r} />
          ))}
          <span className={cn("truncate text-xs", selected && "font-medium")}>{row.message}</span>
        </div>
        {/* Compact (the History section) keeps one column: the author's face,
            with the name, date and sha on hover — what the old flat log showed. */}
        {compact && (
          <span title={`${row.author} · ${row.date} · ${row.shortSha}`} className="shrink-0">
            <CommitAvatar email={row.email} repoPath={repoPath} size={14} />
          </span>
        )}
        {!compact && (
          <>
            <div className="flex w-[200px] shrink-0 items-center gap-1.5">
              <CommitAvatar email={row.email} repoPath={repoPath} size={16} />
              <span className="truncate text-xs text-secondary-foreground">{row.author}</span>
            </div>
            <span className="w-[68px] shrink-0 font-mono text-xs text-muted-foreground">
              {row.shortSha}
            </span>
            <span className="w-[160px] shrink-0 text-right font-mono text-xs text-muted-foreground">
              {row.date}
            </span>
          </>
        )}
      </div>
    </div>
  );
});
