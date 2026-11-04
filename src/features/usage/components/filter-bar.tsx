import { useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/features/monitor/lib/usage-format";
import type { Facets, GroupBy, Metric } from "../types";
import type { FacetOption } from "../lib/derive";
import { Segmented } from "./segmented";

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
          className="flex h-6 items-center gap-1 rounded-full px-2 text-2xs text-[var(--muted-foreground)] transition-colors hover:bg-element-hover hover:text-[var(--foreground)]"
        >
          <X size={10} /> Clear
        </button>
      )}
      <div className="flex-1" />
      {/* No "GROUP" / "METRIC" labels: each track carries its name as its
          accessible name and its tooltip, and the chart caption below spells
          out both choices ("Tokens · by day · per project"), so shouting them
          here said nothing the page did not already say. */}
      <Segmented label="Group by" value={groupBy} options={GROUPS} onChange={onGroupBy} />
      <Segmented label="Metric" value={metric} options={METRICS} onChange={onMetric} />
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
    <DropdownMenu.Root onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            disabled={options.length === 0}
            className={cn(
              "flex h-control-md items-center rounded-full border px-2 text-2xs font-medium leading-none transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
              on
                ? "border-border-strong bg-element-selected text-[var(--foreground)]"
                : "border-[var(--border)] bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]",
            )}
          >
            <span className="max-w-[160px] truncate">{label}</span>
            {selected.length > 1 && (
              <span className="ml-1 rounded-full bg-element-active px-1 text-3xs tabular-nums">
                {selected.length}
              </span>
            )}
            <ChevronDown size={10} className="ml-1 shrink-0 text-[var(--muted-foreground)]" />
          </button>
        }
      />
      <DropdownMenu.Portal>
        {/* z-index belongs to the Positioner — the Popup is statically
            positioned inside it. `finalFocus={false}` is Radix's
            `onCloseAutoFocus` preventDefault: closing the checklist must not
            yank focus back to the pill. */}
        <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
          <DropdownMenu.Popup
            finalFocus={false}
            className="w-[260px] rounded-lg border border-[var(--border)] bg-popover py-1 text-xs text-[var(--secondary-foreground)] shadow-md"
          >
            {options.length > SEARCH_ABOVE && (
              <div className="mx-1.5 mb-1 flex h-control-md items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--background)] px-2">
                <Search size={11} className="shrink-0 text-[var(--muted-foreground)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Keep keys from the popup's typeahead and arrow nav, but let Escape
                    // bubble to the dismiss handler so it still closes the popup.
                    if (e.key !== "Escape") e.stopPropagation();
                  }}
                  placeholder={`Filter ${oneLabel}s`}
                  className="w-full bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
                />
              </div>
            )}
            <div className="max-h-[280px] overflow-y-auto hide-scrollbar">
              {shown.length === 0 && (
                <div className="px-3 py-2 text-2xs text-[var(--muted-foreground)]">No matches</div>
              )}
              {/* No `closeOnClick`: Base UI's checkbox items keep the menu open
                  by default, which is what Radix's `onSelect` preventDefault
                  was doing here. `data-checked` is Base UI's spelling of
                  `data-[state=checked]`. */}
              {shown.map((o) => (
                <DropdownMenu.CheckboxItem
                  key={o.value}
                  checked={sel.has(o.value)}
                  onCheckedChange={() => onToggle(axis, o.value)}
                  className="flex h-control-md cursor-default items-center gap-2 px-3 outline-none hover:bg-element-hover hover:text-[var(--foreground)] data-checked:text-[var(--foreground)]"
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center rounded border border-border-strong">
                    <DropdownMenu.CheckboxItemIndicator>
                      <Check size={10} />
                    </DropdownMenu.CheckboxItemIndicator>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-[var(--muted-foreground)]">
                    {fmtTokens(o.tokens)}
                  </span>
                </DropdownMenu.CheckboxItem>
              ))}
            </div>
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
