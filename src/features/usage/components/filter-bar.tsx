import { useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Segmented,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/features/monitor/lib/usage-format";
import type { Facets, GroupBy, Metric } from "../types";
import type { FacetOption } from "../lib/derive";

type Axis = keyof Facets;

const AXES: ReadonlyArray<{ axis: Axis; all: string; one: string }> = [
  { axis: "projects", all: "All projects", one: "project" },
  { axis: "agents", all: "All agents", one: "agent" },
  { axis: "models", all: "All models", one: "model" },
];

const GROUPS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "model", label: "Model" },
];
const METRICS: ReadonlyArray<{ value: Metric; label: string }> = [
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
  { value: "messages", label: "Messages" },
];

/** Options beyond this count get a search field in the menu. */
const SEARCH_ABOVE = 8;

/**
 * The filter row: one multi-select pill per axis (project · agent · model), each a checklist
 * with the tokens behind every option so the heavy hitters are visible before they're picked,
 * plus the group-by and metric controls that shape the chart and the ranked lists.
 *
 * Options are computed over the RANGE-filtered rows, not the facet-filtered ones, so picking
 * one project never makes the other projects vanish from the menu.
 */
export function FilterBar({
  facets,
  options,
  onToggle,
  onClear,
  groupBy,
  onGroupBy,
  metric,
  onMetric,
  className,
  style,
}: {
  facets: Facets;
  options: Record<Axis, FacetOption[]>;
  onToggle: (axis: Axis, value: string) => void;
  onClear: () => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  metric: Metric;
  onMetric: (m: Metric) => void;
  /** Positioning, supplied by the panel — this row floats over its scroller. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const active = AXES.reduce((n, a) => n + facets[a.axis].length, 0);
  return (
    // No background and no rule of its own. It sits over the body's scroller
    // with a progressive blur behind it, so what backs it is whatever is
    // scrolling underneath, softened — see `usage-panel.tsx`.
    <div className={cn("flex shrink-0 items-center gap-1.5 px-4", className)} style={style}>
      {AXES.map((a) => (
        <FacetPill
          key={a.axis}
          axis={a.axis}
          allLabel={a.all}
          oneLabel={a.one}
          selected={facets[a.axis]}
          options={options[a.axis]}
          onToggle={onToggle}
        />
      ))}
      {active > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="flex h-6 items-center gap-1 rounded-full px-2 text-2xs text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground"
        >
          <X size={10} /> Clear
        </button>
      )}
      <div className="flex-1" />
      {/* No "GROUP" / "METRIC" labels: each track carries its name as its
          accessible name, and the chart caption below spells out both
          choices ("Tokens · by day · per project"), so shouting them here
          said nothing the page did not already say. `size="sm"` puts the
          track at the facet pills' 26px; the quieter fill (no card, no
          border weight) still says a segment flips a state while a pill
          opens a menu. */}
      <Segmented
        size="sm"
        aria-label="Group by"
        value={groupBy}
        options={GROUPS}
        onValueChange={onGroupBy}
      />
      <Segmented
        size="sm"
        aria-label="Metric"
        value={metric}
        options={METRICS}
        onValueChange={onMetric}
      />
    </div>
  );
}

function FacetPill({
  axis,
  allLabel,
  oneLabel,
  selected,
  options,
  onToggle,
}: {
  axis: Axis;
  allLabel: string;
  oneLabel: string;
  selected: string[];
  options: FacetOption[];
  onToggle: (axis: Axis, value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const sel = new Set(selected);
  const label =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} ${oneLabel}s`;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const on = selected.length > 0;

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger
        render={
          <FacetButton on={on} disabled={options.length === 0}>
            <span className="max-w-[160px] truncate">{label}</span>
            {selected.length > 1 && (
              <span className="ml-1 rounded-full bg-element-active px-1 text-3xs tabular-nums">
                {selected.length}
              </span>
            )}
            <ChevronDown size={10} className="ml-1 shrink-0 text-muted-foreground" />
          </FacetButton>
        }
      />
      {/* `finalFocus={false}` is Radix's `onCloseAutoFocus` preventDefault:
          closing the checklist must not yank focus back to the pill. */}
      <DropdownMenuContent align="start" sideOffset={4} finalFocus={false} className="w-[260px]">
        {options.length > SEARCH_ABOVE && (
          <div className="m-1 flex h-control-md items-center gap-1.5 rounded-md border border-border bg-background px-2">
            <Search size={11} className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Keep keys from the popup's typeahead and arrow nav, but let Escape
                // bubble to the dismiss handler so it still closes the popup.
                if (e.key !== "Escape") e.stopPropagation();
              }}
              placeholder={`Filter ${oneLabel}s`}
              className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
        <div className="hide-scrollbar max-h-[280px] overflow-y-auto">
          {shown.length === 0 && (
            <div className="px-3 py-2 text-2xs text-muted-foreground">No matches</div>
          )}
          {/* No `closeOnClick`: Base UI's checkbox items keep the menu open
              by default, which is what Radix's `onSelect` preventDefault was
              doing here. The item draws its own check. */}
          {shown.map((o) => (
            <DropdownMenuCheckboxItem
              key={o.value}
              checked={sel.has(o.value)}
              onCheckedChange={() => onToggle(axis, o.value)}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {fmtTokens(o.tokens)}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A facet pill: raised on the card fill at rest, the selected fill once a
 * facet is set. A component of its own so the menu trigger renders it whole
 * rather than restyling the trigger at the call site.
 */
function FacetButton({
  on,
  className,
  ...props
}: React.ComponentProps<"button"> & { on: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-control-md items-center rounded-full border px-2 text-2xs font-medium leading-none transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? "border-border-strong bg-element-selected text-foreground"
          : "border-border bg-card text-secondary-foreground hover:bg-element-hover hover:text-foreground",
        className,
      )}
    />
  );
}
