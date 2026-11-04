import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ListFilter,
  Pin,
  PinOff,
  ScrollText,
  Search,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  EmptyState,
  Hint,
  HintGroup,
  HintItem,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Toggle,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format-time";
import { timeAgo } from "@/lib/time-ago";
import {
  LOG_SOURCES,
  type LogEntry,
  type LogFilters,
  type LogScope,
  type LogSource,
} from "../../lib/log-view-model";

export type LogCopyFormat = "json" | "line";

export interface LogPanelViewProps {
  /** The rows to show, already filtered. */
  entries: LogEntry[];
  /** Every row before filtering, for the count and the empty-state copy. */
  totalCount: number;
  filters: LogFilters;
  onFiltersChange: (next: LogFilters) => void;
  hasProject: boolean;
  onTogglePin: (entry: LogEntry) => void;
  /** Resolves true when the clipboard took it. */
  onCopy: (entry: LogEntry, format: LogCopyFormat) => Promise<boolean>;
  onClear: () => void;
}

/** Fixed column widths; the summary takes what is left. */
const COLUMNS: { id: string; header: string; width?: number }[] = [
  { id: "expander", header: "", width: 24 },
  { id: "time", header: "Time", width: 86 },
  { id: "source", header: "Source", width: 90 },
  { id: "kind", header: "Kind", width: 120 },
  { id: "project", header: "Project", width: 140 },
  { id: "summary", header: "Summary" },
  { id: "actions", header: "", width: 84 },
];
const WIDTH = Object.fromEntries(COLUMNS.map((c) => [c.id, c.width]));

function cellStyle(width: number | undefined): CSSProperties {
  return width === undefined
    ? { flex: 1, minWidth: 0, paddingRight: 8 }
    : { width, minWidth: width, paddingRight: 8 };
}

const SCOPE_LABEL: Record<LogScope, string> = {
  all: "All projects",
  current: "Current project",
};

/** How long a copy button shows its check. */
const COPIED_MS = 1200;

/**
 * The Log tab: a toolbar of filters over a virtualised list of activity rows,
 * each expandable to its JSON. Renders from props; `log-panel.tsx` owns the
 * stores.
 */
export function LogPanelView({
  entries,
  totalCount,
  filters,
  onFiltersChange,
  hasProject,
  onTogglePin,
  onCopy,
  onClear,
}: LogPanelViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [copied, setCopied] = useState<{ id: string; format: LogCopyFormat } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copy = async (entry: LogEntry, format: LogCopyFormat) => {
    if (!(await onCopy(entry, format))) return;
    setCopied({ id: entry.id, format });
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
  };

  const set = (patch: Partial<LogFilters>) => onFiltersChange({ ...filters, ...patch });

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
    getItemKey: (i) => entries[i]?.id ?? i,
  });

  return (
    <div data-view="log-panel" className="h-full flex flex-col bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[34px] shrink-0 border-b border-border">
        <InputGroup className="w-[240px] shrink-0">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            aria-label="Search activity"
            placeholder="Search activity…"
          />
        </InputGroup>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="xs" title="Filter sources">
                <ListFilter size={11} />
                Sources · {filters.sources.size}
              </Button>
            }
          />
          <DropdownMenuContent>
            {LOG_SOURCES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={filters.sources.has(s)}
                onCheckedChange={(checked) => {
                  const next = new Set<LogSource>(filters.sources);
                  if (checked) next.add(s);
                  else next.delete(s);
                  set({ sources: next });
                }}
                className="capitalize"
              >
                {s}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="xs" title="Project scope">
                {SCOPE_LABEL[filters.scope]}
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={filters.scope}
              onValueChange={(v) => set({ scope: v as LogScope })}
            >
              <DropdownMenuRadioItem value="all" closeOnClick>
                {SCOPE_LABEL.all}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="current" closeOnClick disabled={!hasProject}>
                {SCOPE_LABEL.current}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Toggle
          size="sm"
          pressed={filters.pinnedOnly}
          onPressedChange={(pinnedOnly) => set({ pinnedOnly })}
          title="Pinned only"
        >
          <Pin size={11} />
          Pinned
        </Toggle>

        <div className="flex-1" />

        <span className="text-2xs text-muted-foreground font-mono tabular-nums">
          {entries.length} / {totalCount}
        </span>

        {/* Distinct names, so the difference is announced: with "Pinned"
            on, Clear empties the organisation's pins, otherwise only the
            current project's buffer. */}
        <Button
          variant="ghost-destructive"
          size="xs"
          onClick={onClear}
          title={filters.pinnedOnly ? "Clear pinned" : "Clear buffer"}
          aria-label={filters.pinnedOnly ? "Clear pinned" : "Clear buffer"}
        >
          <Trash2 size={11} />
          Clear
        </Button>
      </div>

      {/* Header row */}
      <div className="flex items-center h-control-sm shrink-0 border-b border-border-subtle bg-background px-3 text-2xs uppercase tracking-wider text-muted-foreground font-medium">
        {COLUMNS.map((c) => (
          <div key={c.id} style={cellStyle(c.width)} className="truncate">
            {c.header}
          </div>
        ))}
      </div>

      {/* Virtualised rows */}
      <div ref={parentRef} className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        {entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={
              totalCount === 0 ? "No events yet — start chatting or making changes." : "No matches."
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const entry = entries[v.index];
              return (
                <div
                  key={entry.id}
                  ref={virtualizer.measureElement}
                  data-index={v.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <LogRow
                    entry={entry}
                    expanded={expanded.has(entry.id)}
                    copied={copied?.id === entry.id ? copied.format : null}
                    onToggle={() => toggleExpanded(entry.id)}
                    onTogglePin={() => onTogglePin(entry)}
                    onCopy={(format) => void copy(entry, format)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function LogRow({
  entry: e,
  expanded,
  copied,
  onToggle,
  onTogglePin,
  onCopy,
}: {
  entry: LogEntry;
  expanded: boolean;
  copied: LogCopyFormat | null;
  onToggle: () => void;
  onTogglePin: () => void;
  onCopy: (format: LogCopyFormat) => void;
}) {
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(
          "group flex items-center px-3 cursor-pointer border-b border-border-subtle hover:bg-element-hover",
          expanded && "bg-card/40",
        )}
        style={{ height: 32 }}
      >
        <div style={cellStyle(WIDTH.expander)} className="flex items-center">
          <Hint label={expanded ? "Collapse" : "Expand"}>
            <IconButton
              size="xs"
              icon={expanded ? ChevronDown : ChevronRight}
              label={expanded ? "Collapse" : "Expand"}
              aria-expanded={expanded}
              onClick={(ev) => {
                ev.stopPropagation();
                onToggle();
              }}
            />
          </Hint>
        </div>
        <div style={cellStyle(WIDTH.time)} className="truncate flex items-center">
          <span
            title={formatDateTime(e.timestamp)}
            className="text-2xs font-mono text-muted-foreground"
          >
            {timeAgo(e.timestamp, { suffix: true, seconds: true })}
          </span>
        </div>
        <div style={cellStyle(WIDTH.source)} className="truncate flex items-center">
          <Badge variant="outline" size="sm" className="font-mono">
            {e.source}
          </Badge>
        </div>
        <div style={cellStyle(WIDTH.kind)} className="truncate flex items-center">
          <span className="text-2xs font-mono text-secondary-foreground truncate">{e.kind}</span>
        </div>
        <div style={cellStyle(WIDTH.project)} className="truncate flex items-center">
          <span className="text-2xs font-mono text-muted-foreground truncate">
            {e.projectName ?? "—"}
          </span>
        </div>
        <div style={cellStyle(WIDTH.summary)} className="truncate flex items-center">
          <span className="text-sm text-foreground truncate">{e.summary}</span>
        </div>
        <div style={cellStyle(WIDTH.actions)} className="flex items-center">
          <HintGroup>
            <div className="flex items-center gap-0.5 justify-end pr-1">
              <HintItem label={e.pinned ? "Unpin" : "Pin (save)"}>
                <IconButton
                  size="xs"
                  icon={e.pinned ? PinOff : Pin}
                  label={e.pinned ? "Unpin" : "Pin (save)"}
                  active={!!e.pinned}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onTogglePin();
                  }}
                />
              </HintItem>
              <HintItem label="Copy JSON">
                <IconButton
                  size="xs"
                  icon={copied === "json" ? Check : Copy}
                  label="Copy JSON"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onCopy("json");
                  }}
                />
              </HintItem>
              {/* Revealed on row hover, or when it has keyboard focus. */}
              <span className="inline-flex opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <HintItem label="Copy line">
                  <IconButton
                    size="xs"
                    icon={copied === "line" ? Check : ClipboardCopy}
                    label="Copy line"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onCopy("line");
                    }}
                  />
                </HintItem>
              </span>
            </div>
          </HintGroup>
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-card/40 border-b border-border-subtle">
          <pre className="text-2xs font-mono text-secondary-foreground whitespace-pre-wrap break-words rounded bg-background border border-border-subtle p-2 max-h-[200px] overflow-auto">
            {JSON.stringify(e, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}
