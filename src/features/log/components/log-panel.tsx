import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  Pin,
  PinOff,
  Copy,
  Check,
  Trash2,
  ListFilter,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { useLogStore, type LogEntry, type LogSource } from "../stores/log-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

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
    text: "text-[var(--accent-primary)]",
    bg: "bg-[var(--accent-primary-muted)]",
    border: "border-[var(--accent-primary)]/30",
  },
  canvas: {
    text: "text-[var(--accent-secondary)]",
    bg: "bg-[var(--accent-secondary)]/15",
    border: "border-[var(--accent-secondary)]/30",
  },
  chat: {
    text: "text-[var(--accent-primary)]",
    bg: "bg-[var(--accent-primary-muted)]",
    border: "border-[var(--accent-primary)]/30",
  },
  git: {
    text: "text-[var(--status-warning)]",
    bg: "bg-[var(--status-warning)]/15",
    border: "border-[var(--status-warning)]/30",
  },
  knowledge: {
    text: "text-[var(--status-info)]",
    bg: "bg-[var(--status-info)]/15",
    border: "border-[var(--status-info)]/30",
  },
  github: {
    text: "text-[var(--text-primary)]",
    bg: "bg-[var(--bg-elevated)]",
    border: "border-[var(--border-default)]",
  },
  editor: {
    text: "text-[var(--status-success)]",
    bg: "bg-[var(--status-success)]/15",
    border: "border-[var(--status-success)]/30",
  },
  project: {
    text: "text-[var(--text-secondary)]",
    bg: "bg-[var(--bg-elevated)]",
    border: "border-[var(--border-default)]",
  },
  system: {
    text: "text-[var(--text-tertiary)]",
    bg: "bg-[var(--bg-elevated)]",
    border: "border-[var(--border-default)]",
  },
  atlas: {
    text: "text-[var(--accent-primary)]",
    bg: "bg-[var(--accent-primary-muted)]",
    border: "border-[var(--accent-primary)]/30",
  },
};

export function LogPanel() {
  const buffer = useLogStore.use.buffer();
  const pinned = useLogStore.use.pinned();
  const ready = useLogStore.use.ready();
  const { loadPinned, loadProject, pin, unpin, clearBuffer, clearPinned } =
    useLogStore.use.actions();

  const currentProject = useProjectStore.use.currentProject();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();

  const [search, setSearch] = useState("");
  const [activeSources, setActiveSources] = useState<Set<LogSource>>(() => new Set(SOURCES));
  const [projectScope, setProjectScope] = useState<"all" | "current">("current");
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
    try {
      await navigator.clipboard.writeText(JSON.stringify(e, null, 2));
      setCopiedId(e.id);
      setTimeout(() => setCopiedId(null), 1200);
    } catch {
      // ignore
    }
  };

  const columns = useMemo<ColumnDef<LogEntry>[]>(
    () => [
      {
        id: "expander",
        header: "",
        cell: ({ row }) => {
          const open = expanded.has(row.original.id);
          return (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(row.original.id);
              }}
              className="p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer"
              title={open ? "Collapse" : "Expand"}
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          );
        },
        size: 24,
      },
      {
        id: "time",
        header: "Time",
        cell: ({ row }) => (
          <span
            title={new Date(row.original.timestamp).toLocaleString()}
            className="text-[10px] font-mono text-[var(--text-tertiary)]"
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
                "inline-flex items-center px-1.5 h-[15px] rounded border text-[9px] font-mono leading-none",
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
          <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate inline-block max-w-[120px]">
            {row.original.kind}
          </span>
        ),
        size: 120,
      },
      {
        id: "project",
        header: "Project",
        cell: ({ row }) => (
          <span className="text-[10px] font-mono text-[var(--text-tertiary)] truncate inline-block max-w-[140px]">
            {row.original.projectName ?? "—"}
          </span>
        ),
        size: 140,
      },
      {
        id: "summary",
        header: "Summary",
        cell: ({ row }) => (
          <span className="text-[12px] text-[var(--text-primary)] truncate inline-block max-w-full">
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
            <div className="flex items-center gap-0.5 justify-end pr-1">
              <button
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (e.pinned) unpin(e.id);
                  else pin(e.id);
                }}
                className={cn(
                  "p-1 rounded hover:bg-[var(--bg-hover)] cursor-pointer transition-colors",
                  e.pinned
                    ? "text-[var(--accent-primary)] hover:text-[var(--accent-primary-hover)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
                )}
                title={e.pinned ? "Unpin" : "Pin (save)"}
              >
                {e.pinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
              <button
                onClick={(ev) => {
                  ev.stopPropagation();
                  handleCopy(e);
                }}
                className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
                title="Copy JSON"
              >
                {copiedId === e.id ? <Check size={11} /> : <Copy size={11} />}
              </button>
            </div>
          );
        },
        size: 60,
      },
    ],
    [expanded, copiedId, pin, unpin],
  );

  const table = useReactTable<LogEntry>({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

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
    <div className="h-full flex flex-col bg-bg-base">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[34px] shrink-0 border-b border-border-default">
        <div className="flex items-center gap-1.5 h-6 rounded-md border border-border-default bg-bg-elevated px-2 min-w-[240px] focus-within:border-[var(--border-focus)]">
          <Search size={11} className="text-text-tertiary shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activity…"
            className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
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
            "flex items-center gap-1 px-2 h-6 rounded text-[10px] cursor-pointer outline-none transition-colors",
            showPinnedOnly
              ? "text-[var(--accent-primary)] bg-[var(--accent-primary-muted)]"
              : "text-text-tertiary hover:text-text-primary hover:bg-bg-hover",
          )}
          title="Pinned only"
        >
          <Pin size={11} />
          Pinned
        </button>

        <div className="flex-1" />

        <span className="text-[10px] text-text-tertiary font-mono">
          {filtered.length} / {merged.length}
        </span>

        <button
          onClick={() => {
            if (showPinnedOnly) clearPinned();
            else clearBuffer();
          }}
          className="flex items-center gap-1 px-2 h-6 rounded text-[10px] text-text-tertiary hover:text-[var(--status-error)] hover:bg-bg-hover cursor-pointer transition-colors"
          title={showPinnedOnly ? "Clear pinned" : "Clear buffer"}
        >
          <Trash2 size={11} />
          Clear
        </button>
      </div>

      {/* Header row */}
      <div className="flex items-center h-[24px] shrink-0 border-b border-border-subtle bg-bg-base px-3 text-[10px] uppercase tracking-wider text-text-tertiary font-medium">
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
          <div className="px-3 py-6 text-[11px] text-text-tertiary text-center">
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
              const row = rows[v.index] as Row<LogEntry>;
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
                      "flex items-center px-3 cursor-pointer border-b border-[var(--border-subtle)] hover:bg-bg-hover",
                      isExpanded && "bg-[var(--bg-elevated)]/40",
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
                    <div className="px-3 pb-3 pt-1 bg-[var(--bg-elevated)]/40 border-b border-[var(--border-subtle)]">
                      <pre className="text-[10px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words rounded bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-2 max-h-[200px] overflow-auto">
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
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1 px-2 h-6 rounded text-[10px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer outline-none transition-colors"
          title="Filter sources"
        >
          <ListFilter size={11} />
          Sources · {active.size}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1 min-w-[160px]"
          style={{ zIndex: 9999 }}
        >
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
                className="flex items-center gap-2 px-3 h-[24px] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer outline-none capitalize"
              >
                <span
                  className={cn(
                    "w-3 h-3 rounded-sm border flex items-center justify-center",
                    checked
                      ? "bg-[var(--accent-primary)] border-[var(--accent-primary)]"
                      : "border-[var(--border-default)]",
                  )}
                >
                  {checked && <Check size={9} className="text-white" />}
                </span>
                {s}
              </DropdownMenu.CheckboxItem>
            );
          })}
        </DropdownMenu.Content>
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
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1 px-2 h-6 rounded text-[10px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer outline-none transition-colors"
          title="Project scope"
        >
          {value === "all" ? "All projects" : "Current project"}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1 min-w-[160px]"
          style={{ zIndex: 9999 }}
        >
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
                "flex items-center gap-2 px-3 h-[24px] text-[11px] cursor-pointer outline-none",
                value === v
                  ? "text-[var(--text-primary)] bg-[var(--bg-selected)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                v === "current" && !hasProject && "opacity-50 cursor-not-allowed",
              )}
            >
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
