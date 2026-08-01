import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemoryTimeline } from "../lib/memory-timeline-api";

/**
 * Apple-Calendar-style week view. The left panel (#141414) lists branches as a
 * plain text list with dividers; the right grid lays out 7 day columns and
 * **stacks items as cards** by time. Hovering/selecting a branch draws smooth
 * bezier connectors from its row to each of its cards. Navigation skips empty
 * weeks so there's no dead scrolling.
 *
 * Props mirror the old Gantt canvas so the host view is unchanged:
 *   id forms — "branch:<name>", "commit:<sha>", "session:<id>".
 */

const PANEL = "#0E0F0E";
const GUTTER = 184;
// Monochromatic — branches are disambiguated by the connector lines, not hue.
const MONO = "#6b6b6b";
const DOT_MEMORY = "#3fb950"; // has memory feeding into it
const DOT_PLAIN = "rgba(255,255,255,0.7)"; // no linked memory
const CONNECTOR = "rgba(255,255,255,0.55)";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface CalItem {
  id: string;
  kind: "commit" | "session";
  ts: number;
  branch: string;
  title: string;
  agent?: "codex" | "claude";
}

// ── local date helpers (DST-safe via Date arithmetic) ──
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfWeek(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  return d.getTime();
}
function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MemoryTimelineCalendar({
  data,
  selectedId,
  highlightIds,
  memoryIds,
  dayCount = 7,
  onSelect,
  onActivate,
}: {
  data: MemoryTimeline;
  selectedId: string | null;
  highlightIds: Set<string> | null;
  /** Card ids that have memory feeding into them (green dot vs white). */
  memoryIds: Set<string> | null;
  /** Visible columns; 7 aligns to the calendar week, 3/4 are rolling ranges. */
  dayCount?: number;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
}) {
  const model = useMemo(() => {
    const branchSet = new Set(data.branches.map((b) => b.name));

    const items: CalItem[] = [];
    for (const c of data.commits) {
      if (!branchSet.has(c.branch)) continue;
      items.push({
        id: `commit:${c.sha}`,
        kind: "commit",
        ts: c.ts_ms,
        branch: c.branch,
        title: c.message || c.short,
      });
    }
    for (const s of data.sessions) {
      if (s.agent !== "codex" || !s.branch || !branchSet.has(s.branch))
        continue;
      items.push({
        id: `session:${s.id}`,
        kind: "session",
        ts: s.ts_ms,
        branch: s.branch,
        title: s.title || "(codex run)",
        agent: "codex",
      });
    }
    items.sort((a, b) => a.ts - b.ts);

    const commitCount = new Map<string, number>();
    for (const c of data.commits)
      commitCount.set(c.branch, (commitCount.get(c.branch) ?? 0) + 1);

    // Days that actually contain something (for empty-range skipping).
    const activityDays = [
      ...new Set(items.filter((i) => i.ts > 0).map((i) => startOfDay(i.ts))),
    ].sort((a, b) => a - b);
    return { items, commitCount, activityDays };
  }, [data]);

  // The anchor day we're focused on (default: most recent activity, else today).
  const [anchorDay, setAnchorDay] = useState<number>(() =>
    model.activityDays.length
      ? model.activityDays[model.activityDays.length - 1]
      : startOfDay(Date.now()),
  );
  useEffect(() => {
    // When the project/data changes, snap to its latest activity day.
    setAnchorDay(
      model.activityDays.length
        ? model.activityDays[model.activityDays.length - 1]
        : startOfDay(Date.now()),
    );
  }, [model.activityDays]);

  // 7-day view aligns to the calendar week; 3/4-day views roll from the anchor.
  const rangeStart = useMemo(
    () => (dayCount >= 7 ? startOfWeek(anchorDay) : anchorDay),
    [anchorDay, dayCount],
  );
  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, i) => addDays(rangeStart, i)),
    [rangeStart, dayCount],
  );
  const rangeEnd = addDays(rangeStart, dayCount);

  const hasPrev = model.activityDays.some((d) => d < rangeStart);
  const hasNext = model.activityDays.some((d) => d >= rangeEnd);
  const goPrev = useCallback(() => {
    const earlier = model.activityDays.filter((d) => d < rangeStart);
    if (earlier.length) setAnchorDay(Math.max(...earlier));
  }, [model.activityDays, rangeStart]);
  const goNext = useCallback(() => {
    const later = model.activityDays.filter((d) => d >= rangeEnd);
    if (later.length) setAnchorDay(Math.min(...later));
  }, [model.activityDays, rangeEnd]);
  const goToday = useCallback(() => setAnchorDay(startOfDay(Date.now())), []);

  // Jump to the range of a search/selection highlight, when one lands off-screen.
  useEffect(() => {
    if (!highlightIds || highlightIds.size === 0) return;
    const hit = model.items.find((i) => highlightIds.has(i.id) && i.ts > 0);
    if (hit) setAnchorDay(startOfDay(hit.ts));
  }, [highlightIds, model.items]);

  // Per-day cards for the visible range.
  const dayCards = useMemo(() => {
    const buckets = new Map<number, CalItem[]>();
    for (const d of days) buckets.set(d, []);
    for (const it of model.items) {
      if (it.ts < rangeStart || it.ts >= rangeEnd) continue;
      const d = startOfDay(it.ts);
      buckets.get(d)?.push(it);
    }
    for (const arr of buckets.values()) arr.sort((a, b) => a.ts - b.ts);
    return buckets;
  }, [model.items, days, rangeStart, rangeEnd]);

  // Active branch = hovered, else the selected branch row.
  const [hoverBranch, setHoverBranch] = useState<string | null>(null);
  const selectedBranch = selectedId?.startsWith("branch:")
    ? selectedId.slice(7)
    : null;
  const activeBranch = hoverBranch ?? selectedBranch;

  const hasHi = !!highlightIds && highlightIds.size > 0;
  const todayStart = startOfDay(Date.now());

  // ── bezier connectors (branch row → its visible cards) ──
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const branchRowRefs = useRef(new Map<string, HTMLElement>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    if (!activeBranch || !containerRef.current) {
      setPaths([]);
      return;
    }
    const base = containerRef.current.getBoundingClientRect();
    const rowEl = branchRowRefs.current.get(activeBranch);
    if (!rowEl) {
      setPaths([]);
      return;
    }
    const r = rowEl.getBoundingClientRect();
    const x1 = r.right - base.left;
    const y1 = r.top + r.height / 2 - base.top;

    const next: string[] = [];
    for (const it of model.items) {
      if (it.branch !== activeBranch) continue;
      const el = cardRefs.current.get(it.id);
      if (!el) continue;
      const cr = el.getBoundingClientRect();
      // Skip cards scrolled out of the body viewport.
      if (cr.bottom < base.top || cr.top > base.bottom) continue;
      const x2 = cr.left - base.left;
      const y2 = cr.top + cr.height / 2 - base.top;
      const dx = Math.max(40, (x2 - x1) * 0.5);
      next.push(
        `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      );
    }
    setPaths(next);
  }, [activeBranch, rangeStart, dayCards, tick, model.items]);

  // Recompute connectors on scroll / resize.
  useEffect(() => {
    const body = bodyRef.current;
    const bump = () => setTick((t) => t + 1);
    body?.addEventListener("scroll", bump, { passive: true });
    const ro = new ResizeObserver(bump);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      body?.removeEventListener("scroll", bump);
      ro.disconnect();
    };
  }, []);

  const rangeLabel = `${new Date(rangeStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(addDays(rangeStart, dayCount - 1)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div ref={containerRef} className="relative flex h-full w-full">
      {/* ── Left branch list (#141414) ── */}
      <div
        className="shrink-0 flex flex-col border-r border-[var(--border-default)]"
        style={{ width: GUTTER, background: PANEL }}
      >
        <div className="flex items-center px-3 h-[32px] shrink-0 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-b border-[var(--border-default)]">
          Branches
        </div>
        <div className="flex-1 overflow-y-auto hide-scrollbar">
          {data.branches.map((b) => {
            const sel = selectedId === `branch:${b.name}`;
            return (
              <button
                key={b.name}
                ref={(el) => {
                  if (el) branchRowRefs.current.set(b.name, el);
                  else branchRowRefs.current.delete(b.name);
                }}
                onMouseEnter={() => setHoverBranch(b.name)}
                onMouseLeave={() =>
                  setHoverBranch((h) => (h === b.name ? null : h))
                }
                onClick={() => onSelect(sel ? null : `branch:${b.name}`)}
                className={cn(
                  "w-full flex flex-col justify-center gap-0.5 px-3 py-2 border-b border-[var(--border-subtle)] text-left transition-colors",
                  sel
                    ? "bg-[var(--bg-selected)]"
                    : "hover:bg-[var(--bg-hover)]",
                )}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-sm shrink-0"
                    style={{ background: MONO }}
                  />
                  <span
                    className={cn(
                      "text-[11px] truncate",
                      b.is_current
                        ? "text-[var(--text-primary)] font-medium"
                        : "text-[var(--text-secondary)]",
                    )}
                  >
                    {b.name}
                  </span>
                </div>
                <span className="text-[9px] text-[var(--text-tertiary)] pl-3.5">
                  {model.commitCount.get(b.name) ?? 0} commits
                  {b.is_current ? " · current" : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Week calendar ── */}
      <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-base)]">
        {/* Week nav */}
        <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
          <button
            onClick={goPrev}
            disabled={!hasPrev}
            title="Previous week with activity"
            className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] enabled:hover:text-[var(--text-primary)] enabled:hover:bg-[var(--bg-hover)] disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            onClick={goNext}
            disabled={!hasNext}
            title="Next week with activity"
            className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] enabled:hover:text-[var(--text-primary)] enabled:hover:bg-[var(--bg-hover)] disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
          >
            <ChevronRight size={15} />
          </button>
          <button
            onClick={goToday}
            className="h-6 px-2.5 rounded-md border border-[var(--border-default)] text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            Today
          </button>
          <span className="text-[12px] font-medium text-[var(--text-primary)] tabular-nums ml-1">
            {rangeLabel}
          </span>
        </div>

        {/* Day-column headers */}
        <div className="flex shrink-0 border-b border-[var(--border-default)]">
          {days.map((d) => {
            const isToday = d === todayStart;
            return (
              <div
                key={d}
                className="flex-1 min-w-0 flex flex-col items-center justify-center py-1.5 border-l border-[var(--border-subtle)] first:border-l-0"
              >
                <span className="text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  {WEEKDAYS[new Date(d).getDay()]}
                </span>
                <span
                  className={cn(
                    "text-[13px] tabular-nums leading-none",
                    isToday
                      ? // `w-6 h-6` (was w-5) so two-digit dates (10–31) aren't
                        // cramped/clipped inside the today circle.
                        "text-[var(--bg-base)] bg-[var(--accent-primary)] rounded-full w-6 h-6 flex items-center justify-center font-semibold mt-0.5"
                      : "text-[var(--text-secondary)]",
                  )}
                >
                  {new Date(d).getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {/* Day columns body */}
        <div ref={bodyRef} className="flex-1 min-h-0 flex overflow-y-auto">
          {days.map((d) => {
            const cards = dayCards.get(d) ?? [];
            return (
              <div
                key={d}
                className="flex-1 min-w-0 flex flex-col gap-1 p-1.5 border-l border-[var(--border-subtle)] first:border-l-0"
              >
                {cards.map((c) => {
                  const sel = selectedId === c.id;
                  const dimmed =
                    (hasHi && !highlightIds!.has(c.id)) ||
                    (!!activeBranch && c.branch !== activeBranch);
                  return (
                    <button
                      key={c.id}
                      ref={(el) => {
                        if (el) cardRefs.current.set(c.id, el);
                        else cardRefs.current.delete(c.id);
                      }}
                      onClick={(e) => {
                        if ((e.metaKey || e.ctrlKey) && c.kind === "session")
                          onActivate(c.id);
                        else onSelect(sel ? null : c.id);
                      }}
                      onMouseEnter={() => setHoverBranch(c.branch)}
                      onMouseLeave={() =>
                        setHoverBranch((h) => (h === c.branch ? null : h))
                      }
                      title={c.title}
                      className={cn(
                        "group w-full max-w-full min-w-0 flex items-start gap-1.5 pl-1.5 pr-1 py-1 rounded-md border text-left cursor-pointer transition-all",
                        sel
                          ? "border-[var(--text-secondary)] bg-[var(--bg-elevated-2)]"
                          : "border-[var(--border-default)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]",
                      )}
                      style={{ opacity: dimmed ? 0.28 : 1 }}
                    >
                      <span
                        className="shrink-0 w-1.5 h-1.5 rounded-full mt-[4px]"
                        style={{
                          background: memoryIds?.has(c.id)
                            ? DOT_MEMORY
                            : DOT_PLAIN,
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[10px] leading-snug text-[var(--text-secondary)] line-clamp-2 break-words">
                          {c.title}
                        </span>
                        <span className="block text-[9px] tabular-nums text-[var(--text-tertiary)] mt-0.5">
                          {fmtTime(c.ts)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Curved connectors (branch → cards) ── */}
      {paths.length > 0 && (
        <svg
          className="absolute inset-0 pointer-events-none z-20"
          width="100%"
          height="100%"
        >
          {paths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={CONNECTOR}
              strokeWidth={1.5}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
