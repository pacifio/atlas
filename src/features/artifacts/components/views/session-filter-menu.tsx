import { useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ChevronUp, Search, SlidersHorizontal } from "lucide-react";

import { GlassIconButton } from "@/features/sidebar/components/glass-icon-button";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
import { ScrollFade, useScrollEdges } from "@/ui/scroll-fade";

import {
  DEFAULT_FILTERS,
  type SessionDetail as Detail,
  type TimelineEntry,
  type TimelineFilters,
} from "../../types";
import { PILL_BUTTON, PILL_BUTTON_ACTIVE, PILL_ICON } from "../footer-pill";

/**
 * The filter menu: what the timeline shows, and a way through its Checkpoints.
 *
 * A popover off the footer's filter button (`footer-pill.tsx`), opening up
 * out of the bottom-left. It was a 340px drawer over the right of the reader,
 * which nothing opened once the footer became two morphs; a menu keeps the
 * reader in view while you narrow it, so a toggle's effect shows as you make
 * it.
 *
 * Checkpoints come first, because "take me to the commit" is the question
 * the menu is most often opened with: previous / next step from wherever the
 * reader is, and the list jumps to any one of them.
 */
export function FilterMenu({
  detail,
  filters,
  setFilters,
  failedOnly,
  setFailedOnly,
  failedCount,
  tools,
  setTools,
  expandTools,
  setExpandTools,
  foldResponses,
  setFoldResponses,
  search,
  setSearch,
  activeFilters,
  checkpoints,
  currentCheckpoint,
  onJump,
}: {
  detail: Detail;
  filters: TimelineFilters;
  setFilters: (fn: (current: TimelineFilters) => TimelineFilters) => void;
  failedOnly: boolean;
  setFailedOnly: (v: boolean) => void;
  failedCount: number;
  tools: Set<string>;
  setTools: (fn: (current: Set<string>) => Set<string>) => void;
  expandTools: boolean;
  setExpandTools: (v: boolean) => void;
  foldResponses: boolean;
  setFoldResponses: (v: boolean) => void;
  search: string;
  setSearch: (v: string) => void;
  activeFilters: number;
  /** Every Checkpoint in the Session, in timeline order. */
  checkpoints: TimelineEntry[];
  /** Where the reader is among them — see `currentCheckpoint` in the pane. */
  currentCheckpoint: () => number;
  onJump: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Re-measured on open: the popup mounts with it, and a closed one has no
  // geometry to read.
  const bodyEdges = useScrollEdges(bodyRef, [open, checkpoints.length, detail.tools.length]);
  const s = detail.summary;
  const kinds: Array<[keyof TimelineFilters, string, number]> = [
    ["prompts", "Prompts", detail.counts.prompts],
    ["responses", "Responses", detail.counts.responses],
    ["thinking", "Thinking", detail.counts.thinking],
    ["toolCalls", "Tool calls", detail.counts.toolCalls],
    ["checkpoints", "Checkpoints", detail.counts.checkpoints],
  ];

  const step = (direction: -1 | 1) => {
    const at = currentCheckpoint();
    // On a Checkpoint (a whole index), step off it; between two (a half), the
    // nearer one in that direction is the next whole index that way.
    const target = Number.isInteger(at)
      ? at + direction
      : direction === 1
        ? Math.ceil(at)
        : Math.floor(at);
    const checkpoint = checkpoints[target];
    if (checkpoint) onJump(checkpoint.id);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label={activeFilters > 0 ? `Filters · ${activeFilters} active` : "Filter and jump"}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className={cn(PILL_BUTTON, activeFilters > 0 && PILL_BUTTON_ACTIVE)}
            >
              <SlidersHorizontal size={PILL_ICON} strokeWidth={1.7} />
              {activeFilters > 0 && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-foreground"
                />
              )}
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="top" align="start" sideOffset={8}>
          {/* Opaque, in the page's own appearance — black on a dark theme,
              light on a light one. The ground is the theme's background and
              what sits on it — the Checkpoint cards — the raised popover grey,
              so the cards pop rather than the menu. It was the card colour at
              90% under a blur, which let the timeline's text show through. */}
          <Popover.Popup
            aria-label="Filter the timeline"
            className="flex max-h-[min(36rem,calc(100svh-8rem))] w-[340px] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in"
          >
            <label className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
              <Search size={13} className="shrink-0 text-[var(--muted-foreground)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find in this session…"
                aria-label="Find in this session"
                spellCheck={false}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
              />
              {activeFilters > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setFilters(() => DEFAULT_FILTERS);
                    setFailedOnly(false);
                    setTools(() => new Set());
                    setSearch("");
                  }}
                  className="h-[22px] shrink-0 cursor-pointer rounded-full border border-[var(--border)] px-2.5 text-2xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  Reset {activeFilters}
                </button>
              )}
            </label>

            <div className="relative flex min-h-0 flex-1 flex-col">
              <ScrollFade at="top" visible={bodyEdges.top} className={POPOVER_FADE} />
              <ScrollFade at="bottom" visible={bodyEdges.bottom} className={POPOVER_FADE} />
              <div
                ref={bodyRef}
                className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3.5 pb-4 pt-3.5"
              >
                {checkpoints.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
                        Checkpoints
                      </span>
                      <span className="font-mono text-2xs text-muted-foreground">
                        {checkpoints.length}
                      </span>
                      <span className="flex-1" />
                      {/* The sidebar's outlined round buttons (its +): stepping
                        is the menu's one verb, so it reads as a control
                        rather than a glyph in a label row. */}
                      <span className="flex items-center gap-1.5">
                        <GlassIconButton
                          icon={ChevronUp}
                          label="Previous checkpoint"
                          onClick={() => step(-1)}
                        />
                        <GlassIconButton
                          icon={ChevronDown}
                          label="Next checkpoint"
                          onClick={() => step(1)}
                        />
                      </span>
                    </div>
                    <CheckpointList
                      checkpoints={checkpoints}
                      onJump={(id) => {
                        // The menu covers the reader's lower left, and a jump
                        // centres its target; close it so the landing is seen.
                        setOpen(false);
                        onJump(id);
                      }}
                    />
                  </div>
                )}

                <Section label="Show" hint={`${detail.entries.length} events`}>
                  {kinds.map(([key, label, count]) => (
                    <FilterChip
                      key={key}
                      label={label}
                      count={count}
                      on={filters[key]}
                      enabled={count > 0}
                      onClick={() => setFilters((c) => ({ ...c, [key]: !c[key] }))}
                    />
                  ))}
                </Section>

                {detail.tools.length > 0 && (
                  <Section label="Tool" hint={`${s.toolCallCount} calls`}>
                    {detail.tools.map((tally) => (
                      <FilterChip
                        key={tally.toolName}
                        label={tally.toolName}
                        count={tally.count}
                        on={tools.has(tally.toolName)}
                        enabled
                        onClick={() =>
                          setTools((current) => {
                            const next = new Set(current);
                            if (next.has(tally.toolName)) next.delete(tally.toolName);
                            else next.add(tally.toolName);
                            return next;
                          })
                        }
                      />
                    ))}
                  </Section>
                )}

                {/* A display preference, not a filter — it hides nothing, so it is
                 *  not counted in the active badge and Reset leaves it alone. */}
                <Section label="View">
                  <FilterChip
                    label="Expand tool calls"
                    count={detail.counts.toolCalls}
                    on={expandTools}
                    enabled={detail.counts.toolCalls > 0}
                    onClick={() => setExpandTools(!expandTools)}
                  />
                  <FilterChip
                    label="Final response only"
                    count={detail.counts.responses}
                    on={foldResponses}
                    enabled={detail.counts.responses > 1}
                    onClick={() => setFoldResponses(!foldResponses)}
                  />
                </Section>

                <Section label="Outcome">
                  <FilterChip
                    label="Failed only"
                    count={failedCount}
                    on={failedOnly}
                    enabled={failedCount > 0}
                    dot="var(--status-error-foreground)"
                    onClick={() => setFailedOnly(!failedOnly)}
                  />
                </Section>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Every commit this Session produced, as a list to jump into.
 *
 * Inline in the menu rather than the searchable dropdown it was in the
 * drawer: a popover inside a popover fights over focus and dismissal. Past
 * a handful, a filter field narrows it — by the time you look for a commit
 * in a long Session you usually know a word of its subject.
 */
function CheckpointList({
  checkpoints,
  onJump,
}: {
  checkpoints: TimelineEntry[];
  onJump: (entryId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return checkpoints;
    return checkpoints.filter(
      (c) =>
        c.commitSubject?.toLowerCase().includes(needle) ||
        c.commitSha?.toLowerCase().includes(needle) ||
        c.branch?.toLowerCase().includes(needle),
    );
  }, [checkpoints, query]);

  /** Position in the FULL list — `#3` must mean the third Checkpoint of the
   *  Session even when the search has narrowed what's shown. */
  const ordinal = useMemo(() => new Map(checkpoints.map((c, i) => [c.id, i + 1])), [checkpoints]);

  const listRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(listRef, [matches.length]);

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {checkpoints.length > 4 && (
        <label className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border bg-popover px-2.5 transition-colors focus-within:border-foreground/25">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a commit…"
            aria-label="Find a commit"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}
      {/* Each Checkpoint a filled card a step off the menu, so a list of
          them reads as things to pick rather than lines of text. Past the
          list's height it scrolls under a fade in the menu's own colour. */}
      <div className="relative">
        <ScrollFade at="top" visible={edges.top} className={cn(POPOVER_FADE, "h-8")} />
        <ScrollFade at="bottom" visible={edges.bottom} className={cn(POPOVER_FADE, "h-8")} />
        <div ref={listRef} className="hide-scrollbar flex max-h-56 flex-col gap-1 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">No match.</p>
          ) : (
            matches.map((checkpoint, i) => {
              const sha = checkpoint.commitSha ?? "";
              const changed = checkpoint.insertions + checkpoint.deletions;
              return (
                <button
                  key={checkpoint.id}
                  type="button"
                  onClick={() => onJump(checkpoint.id)}
                  className="flex w-full shrink-0 cursor-pointer flex-col gap-1 rounded-lg bg-popover px-3 py-2 text-left transition-colors duration-fast hover:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_7%)] focus-visible:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_7%)] focus-visible:outline-none"
                >
                  <span className="truncate text-sm text-foreground">
                    {checkpoint.commitSubject ?? (
                      <span className="text-secondary-foreground">Subject unavailable</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
                    <span>
                      #{ordinal.get(checkpoint.id) ?? i + 1} · {sha.slice(0, 7)}
                    </span>
                    {changed > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-[var(--diff-added-text)]">
                          +{checkpoint.insertions}
                        </span>
                        <span className="text-[var(--diff-removed-text)]">
                          −{checkpoint.deletions}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** The scroll fades inside the filter menu: a ramp from the menu's own
 *  ground, so the content blends into it rather than being cut. */
const POPOVER_FADE = "from-background via-background/80";

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
          {label}
        </span>
        {hint && <span className="font-mono text-2xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  on,
  enabled,
  dot,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  enabled: boolean;
  dot?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      className={cn(
        "flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-sm transition-colors",
        !enabled
          ? "cursor-default border-border-subtle text-disabled"
          : on
            ? "cursor-pointer border-border bg-element-active text-[var(--foreground)]"
            : "cursor-pointer border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground",
      )}
    >
      {dot && enabled && (
        <span className="size-[5px] rounded-full" style={{ backgroundColor: dot }} />
      )}
      {label}
      <span className="font-mono text-2xs text-muted-foreground">{count}</span>
    </button>
  );
}
