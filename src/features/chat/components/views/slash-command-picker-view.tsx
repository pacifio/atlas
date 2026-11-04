// The slash-command picker's panel, from props alone. The container
// (`../slash-command-picker.tsx`) owns the highlight, the keyboard handle,
// click-outside and the portal; this draws the rows under the caret.
//
// Same surface as the mention picker (`.atlas-mention-picker`): opaque
// `bg-popover`, never frosted, so it does not re-blend against the caret.

import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import {
  argsHint,
  commandRequiresArgs,
  matchSegments,
  SLASH_PICKER_MAX_HEIGHT,
  SLASH_PICKER_WIDTH,
  type SlashCommand,
} from "../../lib/slash-command-model";

const ROW_HEIGHT = 26;

export function SlashCommandPickerView({
  rows,
  activeIndex,
  query,
  loading,
  footerLabel,
  position,
  onHover,
  onSelect,
}: {
  rows: SlashCommand[];
  activeIndex: number;
  query: string;
  loading: boolean;
  footerLabel: string;
  position: { left: number; bottom: number };
  onHover: (index: number) => void;
  onSelect: (cmd: SlashCommand) => void;
}) {
  // Only the rows in view are rendered. An agent with a few hundred skills
  // advertises a few hundred commands, and a one-letter query matches nearly
  // all of them by description: rendering every row re-built the whole list
  // on each keystroke and each hover. The list shows ~13 rows at a time.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    paddingStart: 4,
    paddingEnd: 4,
    // Before the first measure (and in tests, which never lay out).
    initialRect: { width: SLASH_PICKER_WIDTH, height: SLASH_PICKER_MAX_HEIGHT },
    getItemKey: (i) => rows[i]?.name ?? i,
  });
  // Keyboard navigation keeps the highlighted row in view; a no-op when
  // it already is (a hover).
  useEffect(() => {
    if (activeIndex < rows.length) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, rows.length, virtualizer]);

  return (
    <div
      className={cn(
        "atlas-slash-picker",
        "flex flex-col overflow-hidden rounded-lg",
        "border border-border bg-popover",
        "inset-highlight shadow-md",
        "z-popover",
      )}
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left: position.left,
        bottom: position.bottom,
        width: SLASH_PICKER_WIDTH,
        maxHeight: SLASH_PICKER_MAX_HEIGHT,
      }}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs leading-snug text-muted-foreground">
            {loading ? "Loading commands…" : `No commands match "/${query}".`}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const i = item.index;
              const cmd = rows[i];
              if (!cmd) return null;
              const isActive = i === activeIndex;
              return (
                <button
                  key={item.key}
                  type="button"
                  style={{ transform: `translateY(${item.start}px)` }}
                  onMouseEnter={() => onHover(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(cmd);
                  }}
                  className={cn(
                    "absolute top-0 left-0 flex h-[26px] w-full items-center gap-2 px-3 text-left text-sm",
                    isActive
                      ? "bg-element-selected text-foreground"
                      : "text-secondary-foreground hover:bg-element-hover",
                  )}
                  title={cmd.description}
                >
                  <span className="min-w-[80px] shrink-0 font-mono text-foreground">
                    /<Highlighted text={cmd.name} query={query} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    <Highlighted text={cmd.description} query={query} max={1} />
                  </span>
                  {commandRequiresArgs(cmd) && (
                    <span
                      className="shrink-0 rounded-full border border-border px-1.5 py-px text-3xs uppercase tracking-wider text-muted-foreground"
                      title="This command takes arguments — type them after the command, then press Enter."
                    >
                      {argsHint(cmd)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {/* `/login` is usually present (S1 left it as the only synthetic
            row), so the empty-state "Loading commands…" branch above rarely
            fires — this row makes the startup gap, when the agent has not
            advertised its commands yet, read as loading rather than as a
            list with just one entry. */}
        {loading && rows.length > 0 && (
          <div className="flex h-[24px] items-center gap-1.5 px-3 text-2xs text-muted-foreground">
            <Spinner size="xs" label="" />
            Loading agent commands…
          </div>
        )}
      </div>
      <div className="flex h-[24px] shrink-0 items-center justify-between border-t border-border px-3 text-3xs uppercase tracking-wider text-muted-foreground">
        <span>{footerLabel}</span>
        <span>↑↓ · ↵ run · ⎋ close</span>
      </div>
    </div>
  );
}

/** `text` with its query matches marked. */
function Highlighted({ text, query, max }: { text: string; query: string; max?: number }) {
  return (
    <>
      {matchSegments(text, query, max).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="rounded-sm bg-element-selected text-foreground">
            {seg.text}
          </mark>
        ) : (
          seg.text
        ),
      )}
    </>
  );
}
