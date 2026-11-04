import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import { GradualBlur } from "@tryatlas/design";
import type { TurnRailItem, TurnRailPreview } from "../../lib/turn-rail";
import { BOTTOM_GAP, TOP_BLUR_RAMP, TOP_EDGE_RAMP } from "../../lib/transcript-insets";
import { ResponseSelectionActions } from "../response-selection-actions";
import { TurnRail } from "../turn-rail";
import { WorkingIndicator } from "./working-indicator";

export interface TranscriptViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  tabId: string;
  /** Showing and caught up; gates the selection actions. */
  live: boolean;
  topInset: number;
  /** No rows and no turn running: the "No messages yet." line. */
  empty: boolean;
  /** The mounted rows, as one memoised element list. */
  rowViews: ReactNode;
  turnInProgress: boolean;
  footer?: ReactNode;
  /** The live turn has produced nothing yet: show the working indicator. */
  working: boolean;
  workingEpoch?: number;
  workingLabel?: string;
  onStallRestart?: () => void;
  onStallSwitch?: () => void;
  onStallCopyDiagnostics?: () => void;
  /** Content below the viewport: the bottom fade shows. */
  more: boolean;
  turnRailItems: readonly TurnRailItem[];
  windowStart: number;
  getTurnRailPreview: (item: TurnRailItem) => TurnRailPreview | null;
  onSelectTurnRailItem: (item: TurnRailItem) => void;
}

/** The transcript's frame: the scroller, its padded content, the selection
 *  actions, the turn rail and the two edge treatments. Props only — the
 *  container is `Transcript` in `transcript.tsx`. */
export function TranscriptView({
  scrollRef,
  contentRef,
  onScroll,
  tabId,
  live,
  topInset,
  empty,
  rowViews,
  turnInProgress,
  footer,
  working,
  workingEpoch,
  workingLabel,
  onStallRestart,
  onStallSwitch,
  onStallCopyDiagnostics,
  more,
  turnRailItems,
  windowStart,
  getTurnRailPreview,
  onSelectTurnRailItem,
}: TranscriptViewProps) {
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto hide-scrollbar [overflow-anchor:none]"
      >
        {/* Pad past the ENTIRE blur band, not just the bar. Padding by the
              header height alone left the first message sitting inside the
              band's ramp, permanently half-blurred. */}
        <div
          ref={contentRef}
          style={{
            paddingTop: topInset ? topInset + TOP_BLUR_RAMP + 12 : TOP_EDGE_RAMP + 4,
            paddingBottom: BOTTOM_GAP,
          }}
        >
          {empty && (
            <div className="flex h-full items-center justify-center text-xs text-[var(--muted-foreground)]">
              No messages yet.
            </div>
          )}
          {rowViews}
          {!turnInProgress && footer}
          {working && (
            <WorkingIndicator
              key={workingEpoch}
              label={workingLabel}
              onStallRestart={workingLabel ? onStallRestart : undefined}
              onStallSwitch={workingLabel ? onStallSwitch : undefined}
              onStallCopyDiagnostics={workingLabel ? onStallCopyDiagnostics : undefined}
            />
          )}
        </div>
      </div>

      <ResponseSelectionActions viewportRef={scrollRef} tabId={tabId} enabled={live} />

      {/* Hangs left into the gutter outside this box; takes no space. */}
      <TurnRail
        items={turnRailItems}
        scrollRef={scrollRef}
        contentRef={contentRef}
        topInset={topInset}
        windowStart={windowStart}
        getPreview={getTurnRailPreview}
        onSelect={onSelectTurnRailItem}
      />

      {/* Progressive blur behind the floating header. It starts at y=0 and
            runs past the bar, so text scrolling underneath is blurred rather
            than clipped by an opaque strip — which is only possible because the
            header does not occupy a row of its own. Sized to the header inset
            plus a short ramp below it. */}
      <GradualBlur
        position="top"
        height={`${topInset ? topInset + TOP_BLUR_RAMP : TOP_EDGE_RAMP}px`}
        strength={2.1}
        layers={5}
        // Mostly-opaque behind the bar itself, ramping to clear below it.
        // Without a tint the header read as a transparent pane over live text;
        // `color-mix` keeps it theme-correct rather than hardcoding black.
        tint="color-mix(in srgb, var(--background) 90%, transparent)"
        className="z-panel"
      />

      {/* Bottom stays a plain colour fade. The blur was tried here and the
            edge above the composer reads better as a clean dissolve — and it
            avoids a second stack of live backdrop filters over the scroller. */}
      <div
        aria-hidden
        className={cn(
          // `-bottom-[2px]` + 2px extra height: the fade OVERSHOOTS the
          // container edge. At fractional UI scales the fade's bottom and the
          // scroller's bottom can round to different device pixels, and during
          // scroll repaints a 1-2px hairline of text flashed through the seam
          // above the composer. The overshoot is solid bg-surface over the
          // inter-panel gap — invisible, and it absorbs the rounding both ways.
          "pointer-events-none absolute -bottom-[2px] left-0 right-0 z-panel h-[44px] transition-opacity duration-200",
          more ? "opacity-100" : "opacity-0",
        )}
        style={{
          // The last ~quarter is FULLY solid: a plain two-stop gradient only
          // reaches 100% opacity at the very last pixel, and the ~97%-opaque
          // band just above the composer let white text ghost through the
          // seam (subtle but visible on AMOLED black).
          background:
            "linear-gradient(to bottom, transparent, var(--background) 72%, var(--background))",
        }}
      />
    </div>
  );
}
