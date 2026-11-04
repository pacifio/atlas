import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createCoreRowModel,
  createFilteredRowModel,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  Pin,
  PinOff,
  Copy,
  ClipboardCopy,
  Check,
  Trash2,
  ListFilter,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/time-ago";
import { useLogStore, type LogEntry, type LogSource } from "../stores/log-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { formatDateTime } from "@/lib/format-time";

const SOURCES: LogSource[] = [
  "atlas",
  "agent",
  "chat",
  "canvas",
  "git",
  "knowledge",
  "github",
  "editor",
  "project",
  "system",
];

const SOURCE_COLOR: Record<LogSource, { text: string; bg: string; border: string }> = {
  agent: {
    text: "text-[var(--primary)]",
    bg: "bg-primary-muted",
    border: "border-[var(--primary)]/30",
  },
  canvas: {
    text: "text-[var(--muted-foreground)]",
    bg: "bg-[var(--muted-foreground)]/15",
    border: "border-[var(--muted-foreground)]/30",
  },
  chat: {
    text: "text-[var(--primary)]",
    bg: "bg-primary-muted",
    border: "border-[var(--primary)]/30",
  },
  git: {
    text: "text-warning",
    bg: "bg-warning/15",
    border: "border-warning/30",
  },
  knowledge: {
    text: "text-info",
    bg: "bg-info/15",
    border: "border-info/30",
  },
  github: {
    text: "text-[var(--foreground)]",
    bg: "bg-[var(--card)]",
    border: "border-[var(--border)]",
  },
  editor: {
    text: "text-success",
    bg: "bg-success/15",
    border: "border-success/30",
  },
  project: {
    text: "text-[var(--secondary-foreground)]",
    bg: "bg-[var(--card)]",
    border: "border-[var(--border)]",
  },
  system: {
    text: "text-[var(--muted-foreground)]",
    bg: "bg-[var(--card)]",
    border: "border-[var(--border)]",
  },
  atlas: {
    text: "text-[var(--primary)]",
    bg: "bg-primary-muted",
    border: "border-[var(--primary)]/30",
  },
};

// react-table 9 no longer bundles every feature into the hook: what the table
// can do is declared once, statically, and the row-model factories are slots on
// the same object (v8's `getCoreRowModel()` / `get*RowModel()` table options).
// `columnSizingFeature` is what keeps `header.getSize()` / `column.getSize()`
// available — the column widths this table lays itself out with — and
// `columnVisibilityFeature` is what keeps `row.getVisibleCells()`.
const features = tableFeatures({
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  coreRowModel: createCoreRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
});

export function LogPanel() {
  const buffer = useLogStore.use.buffer();
  const pinned = useLogStore.use.pinned();
  const ready = useLogStore.use.ready();
  const { loadPinned, loadProject, pin, unpin, clearBuffer, clearPinned } =
    useLogStore.use.actions();

  const currentProject = useAppStore.use.currentProject();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();

  const [search, setSearch] = useState("");
  const [activeSources, setActiveSources] = useState<Set<LogSource>>(() => new Set(SOURCES));
  const [projectScope, setProjectScope] = useState<"all" | "current">("current");
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLineId, setCopiedLineId] = useState<string | null>(null);

  // Keyed on the Organisation, not just on `ready`: the panel can mount before
  // the org store has hydrated (pins then load as empty), and an org switch has
  // to re-read. `loadPinned` no-ops when the loaded org already matches, so
  // firing it on every org change is free.
  useEffect(() => {
    void loadPinned();
  }, [activeOrganisationId, ready, loadPinned]);

  // Restore (and scope) the activity log for the current project from disk.
  useEffect(() => {
    if (currentProject?.path) void loadProject(currentProject.path);
  }, [currentProject?.path, loadProject]);

  // Merge buffer + pinned (newest first, dedupe by id).
  const merged = useMemo<LogEntry[]>(() => {
    const seen = new Set<string>();
    const out: LogEntry[] = [];
    const pushUnique = (list: LogEntry[]) => {
      for (const e of list) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
      }
    };
    pushUnique(buffer);
    pushUnique(pinned);
    return out;
  }, [buffer, pinned]);

  const filtered = useMemo<LogEntry[]>(() => {
    const q = search.trim().toLowerCase();
    return merged.filter((e) => {
      if (!activeSources.has(e.source)) return false;
      if (showPinnedOnly && !e.pinned) return false;
      if (projectScope === "current") {
        if (!currentProject) return false;
        if (e.projectPath !== currentProject.path) return false;
      }
      if (q) {
        const hay = (e.summary + " " + e.kind + " " + (e.projectName ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [merged, search, activeSources, projectScope, currentProject, showPinnedOnly]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopy = async (e: LogEntry) => {
    const ok = await copyText(JSON.stringify(e, null, 2));
    if (ok) {
      setCopiedId(e.id);
      setTimeout(() => setCopiedId(null), 1200);
    }
  };

  const handleCopyLine = async (e: LogEntry) => {
    const ok = await copyText(`[${e.source}] ${e.kind} — ${e.summary}`);
    if (ok) {
      setCopiedLineId(e.id);
      toast.success("Copied");
      setTimeout(() => setCopiedLineId(null), 1200);
    }
  };

  const columns = useMemo<ColumnDef<typeof features, LogEntry>[]>(
    () => [
      {
        id: "expander",
        header: "",
        cell: ({ row }) => {
          const open = expanded.has(row.original.id);
          return (
            <Hint label={open ? "Collapse" : "Expand"}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpanded(row.original.id);
                }}
                className="p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
              >
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
            </Hint>
          );
        },
        size: 24,
      },
      {
        id: "time",
        header: "Time",
        cell: ({ row }) => (
          <span
            title={formatDateTime(row.original.timestamp)}
            className="text-2xs font-mono text-[var(--muted-foreground)]"
          >
            {timeAgo(row.original.timestamp, { suffix: true, seconds: true })}
          </span>
        ),
        size: 86,
      },
      {
        id: "source",
        header: "Source",
        cell: ({ row }) => {
          const c = SOURCE_COLOR[row.original.source];
          return (
            <span
              className={cn(
                "inline-flex items-center px-1.5 h-[15px] rounded border text-3xs font-mono leading-none",
                c.text,
                c.bg,
                c.border,
              )}
            >
              {row.original.source}
            </span>
          );
        },
        size: 90,
      },
      {
        id: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-2xs font-mono text-[var(--secondary-foreground)] truncate inline-block max-w-[120px]">
            {row.original.kind}
          </span>
        ),
        size: 120,
      },
      {
        id: "project",
        header: "Project",
        cell: ({ row }) => (
          <span className="text-2xs font-mono text-[var(--muted-foreground)] truncate inline-block max-w-[140px]">
            {row.original.projectName ?? "—"}
          </span>
        ),
        size: 140,
      },
      {
        id: "summary",
        header: "Summary",
        cell: ({ row }) => (
          <span className="text-sm text-[var(--foreground)] truncate inline-block max-w-full">
            {row.original.summary}
          </span>
        ),
        size: 999,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const e = row.original;
          return (
            <HintGroup>
              <div className="flex items-center gap-0.5 justify-end pr-1">
                <HintItem label={e.pinned ? "Unpin" : "Pin (save)"}>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (e.pinned) unpin(e.id);
                      else pin(e.id);
                    }}
                    className={cn(
                      "p-1 rounded hover:bg-element-hover cursor-pointer transition-colors",
                      e.pinned
                        ? "text-[var(--primary)] hover:text-primary-hover"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {e.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                  </button>
                </HintItem>
                <HintItem label="Copy JSON">
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleCopy(e);
                    }}
                    className="p-1 rounded hover:bg-element-hover text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors"
                  >
                    {copiedId === e.id ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                </HintItem>
                <HintItem label="Copy line">
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleCopyLine(e);
                    }}
                    className="p-1 rounded hover:bg-element-hover text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    {copiedLineId === e.id ? <Check size={11} /> : <ClipboardCopy size={11} />}
                  </button>
                </HintItem>
              </div>
            </HintGroup>
          );
        },
        size: 84,
      },
    ],
    [expanded, copiedId, copiedLineId, pin, unpin],
  );

  const table = useTable({ features, data: filtered, columns });

  // Virtualization on row model.
  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
    getItemKey: (i) => rows[i]?.original.id ?? i,
  });

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[34px] shrink-0 border-b border-border">
        <div className="flex items-center gap-1.5 h-6 rounded-md border border-border bg-card px-2 min-w-[240px] focus-within:border-border-strong">
          <Search size={11} className="text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activity…"
            className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground min-w-0"
          />
        </div>

        <SourceFilter active={activeSources} onChange={setActiveSources} />

        <ProjectScopeFilter
          value={projectScope}
          onChange={setProjectScope}
          hasProject={!!currentProject}
        />

        <button
          onClick={() => setShowPinnedOnly((v) => !v)}
          className={cn(
            "flex items-center gap-1 px-2 h-6 rounded text-2xs cursor-pointer outline-none transition-colors",
            showPinnedOnly
              ? "text-[var(--primary)] bg-primary-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-element-hover",
          )}
          title="Pinned only"
        >
          <Pin size={11} />
          Pinned
        </button>

        <div className="flex-1" />

        <span className="text-2xs text-muted-foreground font-mono">
          {filtered.length} / {merged.length}
        </span>

        <button
          onClick={() => {
            if (showPinnedOnly) clearPinned();
            else clearBuffer();
          }}
          className="flex items-center gap-1 px-2 h-6 rounded text-2xs text-muted-foreground hover:text-error hover:bg-element-hover cursor-pointer transition-colors"
          title={showPinnedOnly ? "Clear pinned" : "Clear buffer"}
        >
          <Trash2 size={11} />
          Clear
        </button>
      </div>

      {/* Header row */}
      <div className="flex items-center h-control-sm shrink-0 border-b border-border-subtle bg-background px-3 text-2xs uppercase tracking-wider text-muted-foreground font-medium">
        {table.getHeaderGroups().map((hg) => (
          <div key={hg.id} className="flex items-center w-full">
            {hg.headers.map((h) => (
              <div key={h.id} style={cellStyle(h.column.id, h.getSize())} className="truncate">
                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Virtualized rows */}
      <div ref={parentRef} className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground text-center">
            {merged.length === 0
              ? "No events yet — start chatting or making changes."
              : "No matches."}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index] as Row<typeof features, LogEntry>;
              const isExpanded = expanded.has(row.original.id);
              return (
                <div
                  key={row.original.id}
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
                  <div
                    onClick={() => toggleExpanded(row.original.id)}
                    className={cn(
                      "group flex items-center px-3 cursor-pointer border-b border-border-subtle hover:bg-element-hover",
                      isExpanded && "bg-[var(--card)]/40",
                    )}
                    style={{ height: 32 }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        style={cellStyle(cell.column.id, cell.column.getSize())}
                        className="truncate flex items-center"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 bg-[var(--card)]/40 border-b border-border-subtle">
                      <pre className="text-2xs font-mono text-[var(--secondary-foreground)] whitespace-pre-wrap break-words rounded bg-[var(--background)] border border-border-subtle p-2 max-h-[200px] overflow-auto">
                        {JSON.stringify(row.original, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function cellStyle(columnId: string, size: number): CSSProperties {
  if (columnId === "summary") {
    return { flex: 1, minWidth: 0, paddingRight: 8 };
  }
  return { width: size, minWidth: size, paddingRight: 8 };
}

function SourceFilter({
  active,
  onChange,
}: {
  active: Set<LogSource>;
  onChange: (next: Set<LogSource>) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <button
            className="flex items-center gap-1 px-2 h-6 rounded text-2xs text-muted-foreground hover:text-foreground hover:bg-element-hover cursor-pointer outline-none transition-colors"
            title="Filter sources"
          >
            <ListFilter size={11} />
            Sources · {active.size}
          </button>
        }
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
          <DropdownMenu.Popup className="rounded-md border border-[var(--border)] bg-[var(--card)] shadow-md py-1 min-w-[160px]">
            {SOURCES.map((s) => {
              const checked = active.has(s);
              return (
                <DropdownMenu.CheckboxItem
                  key={s}
                  checked={checked}
                  onCheckedChange={(c) => {
                    const next = new Set(active);
                    if (c) next.add(s);
                    else next.delete(s);
                    onChange(next);
                  }}
                  className="flex items-center gap-2 px-3 h-control-sm text-xs text-[var(--secondary-foreground)] hover:bg-element-hover hover:text-[var(--foreground)] cursor-pointer outline-none capitalize"
                >
                  <span
                    className={cn(
                      "w-3 h-3 rounded-sm border flex items-center justify-center",
                      checked
                        ? "bg-[var(--primary)] border-[var(--primary)]"
                        : "border-[var(--border)]",
                    )}
                  >
                    {checked && <Check size={9} className="text-primary-foreground" />}
                  </span>
                  {s}
                </DropdownMenu.CheckboxItem>
              );
            })}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ProjectScopeFilter({
  value,
  onChange,
  hasProject,
}: {
  value: "all" | "current";
  onChange: (v: "all" | "current") => void;
  hasProject: boolean;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <button
            className="flex items-center gap-1 px-2 h-6 rounded text-2xs text-muted-foreground hover:text-foreground hover:bg-element-hover cursor-pointer outline-none transition-colors"
            title="Project scope"
          >
            {value === "all" ? "All projects" : "Current project"}
          </button>
        }
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
          <DropdownMenu.Popup className="rounded-md border border-[var(--border)] bg-[var(--card)] shadow-md py-1 min-w-[160px]">
            {(
              [
                { v: "all", label: "All projects" },
                { v: "current", label: "Current project" },
              ] as const
            ).map(({ v, label }) => (
              <DropdownMenu.Item
                key={v}
                onClick={() => onChange(v)}
                disabled={v === "current" && !hasProject}
                className={cn(
                  "flex items-center gap-2 px-3 h-control-sm text-xs cursor-pointer outline-none",
                  value === v
                    ? "text-[var(--foreground)] bg-element-selected"
                    : "text-[var(--secondary-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]",
                  v === "current" && !hasProject && "opacity-50 cursor-not-allowed",
                )}
              >
                {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
