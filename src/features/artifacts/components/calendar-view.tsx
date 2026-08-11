/**
 * The Timeline as a month.
 *
 * The list answers "what happened, most recent first"; this answers the shape
 * questions a list cannot — which weeks were busy, which days were dead, whether
 * the work is spread out or piled into three afternoons. Same rows, same
 * filters, different axis.
 *
 * The month shown is the month of the newest session on the board, not the
 * calendar month: a board filtered to a project last touched in May should open
 * on May rather than on an empty July with no indication of where the work went.
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { bucketByDay, formatDuration, formatTokens, sessionState, startOfDay } from "../lib/board";
import type { BoardSession } from "../types";

/** Five weeks covers every month; a six-week month spills into the last row. */
const CELLS = 42;
/** Chips shown in a cell before the rest collapse into "+N more". */
const CHIPS = 2;
/** Sessions listed in the hover card before it says how many are left. */
const CARD_ROWS = 4;

export function CalendarView({
  sessions,
  onOpen,
}: {
  sessions: BoardSession[];
  onOpen: (id: string, projectPath: string) => void;
}) {
  /** Months away from the anchor month. */
  const [offset, setOffset] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  const byDay = useMemo(() => bucketByDay(sessions), [sessions]);

  // Anchor on the newest row rather than on today — see the module note.
  const anchor = useMemo(() => {
    const newest = sessions[0] ? new Date(sessions[0].lastActivityAt) : new Date();
    return new Date(newest.getFullYear(), newest.getMonth() + offset, 1);
  }, [sessions, offset]);

  const monthStart = anchor;
  const leading = monthStart.getDay();
  const today = startOfDay(new Date());

  const cells = Array.from({ length: CELLS }, (_, i) => {
    const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), i - leading + 1);
    const key = startOfDay(date);
    const rows = byDay.get(key) ?? [];
    return {
      key,
      date,
      inMonth: date.getMonth() === monthStart.getMonth(),
      isToday: key === today,
      rows,
      minutes: Math.round(rows.reduce((a, s) => a + s.activeSeconds, 0) / 60),
    };
  });
  // A month that fits in five weeks should not render a sixth empty row.
  const rowCount = cells.slice(35).some((c) => c.inMonth) ? 6 : 5;
  const visible = cells.slice(0, rowCount * 7);

  const monthRows = visible.filter((c) => c.inMonth).flatMap((c) => c.rows);
  const monthMinutes = Math.round(monthRows.reduce((a, s) => a + s.activeSeconds, 0) / 60);
  const monthTokens = monthRows.reduce((a, s) => a + s.totalTokens, 0);

  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Date(2024, 8, 1 + i).toLocaleDateString(undefined, { weekday: "short" }),
      ),
    [],
  );

  return (
    <section className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-raised)] px-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
          {monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <MonthStep label="Previous month" onClick={() => setOffset((o) => o - 1)}>
          <ChevronLeft size={11} />
        </MonthStep>
        <MonthStep label="Next month" onClick={() => setOffset((o) => o + 1)}>
          <ChevronRight size={11} />
        </MonthStep>
        {offset !== 0 && (
          <button
            type="button"
            onClick={() => setOffset(0)}
            className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            Reset
          </button>
        )}
        <span className="ml-auto font-mono text-[10px] text-[var(--text-tertiary)]">
          {monthRows.length} session{monthRows.length === 1 ? "" : "s"} ·{" "}
          {formatDuration(monthMinutes * 60)}
          {monthTokens > 0 && ` · ${formatTokens(monthTokens)} tok`}
        </span>
      </header>

      <div className="grid shrink-0 grid-cols-7 border-b border-[var(--border-default)]">
        {weekdays.map((w, i) => (
          <div
            key={w}
            className={cn(
              "flex h-6 items-center px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]",
              i > 0 && "border-l border-[var(--border-subtle)]",
            )}
          >
            {w}
          </div>
        ))}
      </div>

      <div
        className="hide-scrollbar grid min-h-0 flex-1 grid-cols-7 overflow-y-auto"
        style={{ gridTemplateRows: `repeat(${rowCount}, minmax(112px, 1fr))` }}
      >
        {visible.map((cell, i) => {
          const column = i % 7;
          const row = Math.floor(i / 7);
          return (
            <div
              key={cell.key}
              onMouseEnter={() => setHover(cell.key)}
              onMouseLeave={() => setHover(null)}
              className={cn(
                "relative flex min-h-0 flex-col gap-1.5 border-b border-l border-[var(--border-subtle)] px-2.5 pb-2 pt-2 transition-colors",
                !cell.inMonth && "bg-[var(--bg-base)]",
                cell.isToday && "bg-[var(--bg-raised)]",
                cell.rows.length > 0 && "hover:bg-[var(--bg-hover)]",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "font-mono text-[11px]",
                    cell.isToday
                      ? "font-semibold text-[var(--capture-live)]"
                      : cell.inMonth
                        ? "text-[var(--text-secondary)]"
                        : "text-[var(--text-ghost)]",
                  )}
                >
                  {cell.inMonth ? cell.date.getDate() : ""}
                </span>
                {cell.minutes > 0 && (
                  <span className="font-mono text-[9.5px] text-[var(--text-tertiary)]">
                    {formatDuration(cell.minutes * 60)}
                  </span>
                )}
              </div>

              {cell.rows.slice(0, CHIPS).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpen(s.id, s.projectPath)}
                  title={s.title ?? "Untitled session"}
                  className={cn(
                    "flex h-[18px] max-w-full cursor-pointer items-center self-start overflow-hidden rounded-[3px] border px-1.5 transition-colors",
                    sessionState(s) === "attention"
                      ? "border-[var(--status-warning)]/30 bg-[var(--status-warning-muted)]"
                      : "border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]",
                  )}
                >
                  <span className="truncate text-[10.5px] text-[var(--text-secondary)]">
                    {s.title ?? "Untitled"}
                  </span>
                </button>
              ))}

              {cell.rows.length > CHIPS && (
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  +{cell.rows.length - CHIPS} more
                </span>
              )}

              {hover === cell.key && cell.rows.length > 0 && (
                <DayCard cell={cell} column={column} row={row} rowCount={rowCount} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MonthStep({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-[18px] cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  );
}

/**
 * The hover card for a day.
 *
 * Flips its corner off the cell's position in the grid, so a card on the right
 * edge opens leftwards and one on the bottom row opens upwards instead of off
 * the panel. `pointer-events-none` because it is a readout, not a menu — the
 * chips underneath stay clickable through it.
 */
function DayCard({
  cell,
  column,
  row,
  rowCount,
}: {
  cell: { date: Date; rows: BoardSession[]; minutes: number; isToday: boolean };
  column: number;
  row: number;
  rowCount: number;
}) {
  const tokens = cell.rows.reduce((a, s) => a + s.totalTokens, 0);
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-50 w-[268px] rounded-md border border-[var(--border-default)] bg-[#000] px-3 pb-3 pt-2.5 shadow-xl",
        column > 3 ? "right-1.5" : "left-1.5",
        row > rowCount - 3 ? "bottom-[34px]" : "top-[34px]",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
          {cell.date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          {cell.isToday && " · Today"}
        </span>
        <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
          {cell.rows.length} · {formatDuration(cell.minutes * 60)}
          {tokens > 0 && ` · ${formatTokens(tokens)}`}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {cell.rows.slice(0, CARD_ROWS).map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-[5px] shrink-0 rounded-full"
              style={{
                backgroundColor:
                  sessionState(s) === "attention"
                    ? "var(--status-warning)"
                    : sessionState(s) === "imported"
                      ? "var(--status-info)"
                      : "var(--border-strong)",
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-[var(--text-secondary)]">
                {s.title ?? "Untitled session"}
              </span>
              <span className="block truncate font-mono text-[10px] text-[var(--text-tertiary)]">
                {s.projectName}
                {s.totalTokens > 0 && ` · ${formatTokens(s.totalTokens)} tok`}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-secondary)]">
              {formatDuration(s.activeSeconds)}
            </span>
          </div>
        ))}
      </div>

      {cell.rows.length > CARD_ROWS && (
        <p className="mt-2 border-t border-[var(--border-default)] pt-2 font-mono text-[10px] text-[var(--text-tertiary)]">
          +{cell.rows.length - CARD_ROWS} more this day
        </p>
      )}
    </div>
  );
}
