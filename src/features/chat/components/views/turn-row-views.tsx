import { memo } from "react";
import { ChevronRight, Files } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SeparatorRow, TurnFooterRow, WorkHeaderRow } from "../../lib/turn-rows";
import { ICON_PX, ICON_STROKE } from "../tool-glyph";
import { ChangedFilesCard } from "../changed-files-card";
import { ProseRowActions } from "../prose-row-actions";
import { Column, formatWorked, LiveElapsed } from "./transcript-row-parts";

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
      <div className="flex items-center border-b border-border-subtle pb-2">
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
        <span className="h-px flex-1 bg-border-subtle" />
        <span className="shrink-0 text-2xs text-[var(--muted-foreground)]">{row.label}</span>
        <span className="h-px flex-1 bg-border-subtle" />
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
    // With a footer, `pb-16` is the old 16px gap, the footer's 28px band
    // (`ProseRowActions`, placed `bottom-4`) and a gap between the band and the
    // card above it — at `pb-11` the copy / pin / comment row sat against the
    // changed-files card. Reserved whether hovered or not, so revealing it
    // never moves anything.
    <Column className={cn("pt-1", responseRowId ? "relative pb-16" : "pb-4")}>
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
