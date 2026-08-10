import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@/features/log/stores/log-store";
import type { ProjectMetrics } from "../../types";

const ROW_H = 30;
const PAGE_SIZE = 100;
/** Cap entries loaded into memory across all projects (most-recent-first). */
const LOAD_CAP = 5000;
const SOURCES = [
  "all",
  "atlas",
  "agent",
  "chat",
  "git",
  "knowledge",
  "github",
  "project",
  "system",
  "editor",
  "research",
  "canvas",
] as const;

function parseJsonl(raw: string): LogEntry[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is LogEntry => x !== null);
}

const SOURCE_COLOR: Record<string, string> = {
  atlas: "var(--text-primary)",
  agent: "var(--accent-primary)",
  chat: "#5fb39a",
  git: "#7aa7e8",
  knowledge: "#b8a3df",
  github: "#d68aae",
  review: "#d9b56e",
};

/** Full-width, remaining-height activity log table (Atlas logs across all
 *  projects), filterable by project + source. Mirrors the providers-settings
 *  table layout (toolbar → sticky header → virtualized scroll body). */
export function LogsTable({ projects }: { projects: ProjectMetrics[] }) {
  const [all, setAll] = useState<LogEntry[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const perProject = await Promise.all(
        projects.map((p) =>
          invoke<string>("load_project_log", { project: p.projectPath })
            .then((raw) =>
              parseJsonl(raw).map((e) => ({
                ...e,
                projectPath: e.projectPath ?? p.projectPath,
                projectName: e.projectName ?? p.projectName,
              })),
            )
            .catch(() => [] as LogEntry[]),
        ),
      );
      const pinned = await invoke<string>("load_pinned_log")
        .then(parseJsonl)
        .catch(() => [] as LogEntry[]);
      if (cancelled) return;
      const merged = [...perProject.flat(), ...pinned]
        .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
        .slice(0, LOAD_CAP);
      setAll(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((e) => {
      if (projectFilter !== "all" && e.projectPath !== projectFilter) return false;
      if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
      if (
        q &&
        !`${e.summary} ${e.kind} ${e.source} ${e.projectName ?? ""}`.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [all, projectFilter, sourceFilter, query]);

  // Paginate (and virtualize the page) so the in-memory render set stays small.
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [projectFilter, sourceFilter, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const rows = useMemo(
    () => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE),
    [filtered, clampedPage],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  return (
    <div className="h-full flex flex-col rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2.5 h-[38px] shrink-0 border-b border-[var(--border-default)]">
        <span className="text-[12px] font-medium text-[var(--text-primary)] mr-1">
          Activity log
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)]">{filtered.length}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 h-[26px] rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 w-[180px]">
          <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs…"
            className="flex-1 bg-transparent outline-none text-[11px] text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)]"
          />
        </div>
        <Select
          value={sourceFilter}
          onChange={setSourceFilter}
          options={SOURCES as unknown as string[]}
        />
        <Select
          value={projectFilter}
          onChange={setProjectFilter}
          options={["all", ...projects.map((p) => p.projectPath)]}
          labels={{
            all: "All projects",
            ...Object.fromEntries(projects.map((p) => [p.projectPath, p.projectName])),
          }}
        />
      </div>

      {/* Header */}
      <div className="flex items-center h-[26px] shrink-0 border-b border-[var(--border-default)] px-3 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        <span className="w-[120px] shrink-0">Time</span>
        <span className="w-[80px] shrink-0">Source</span>
        <span className="w-[150px] shrink-0">Project</span>
        <span className="w-[140px] shrink-0">Kind</span>
        <span className="flex-1 min-w-0">Summary</span>
      </div>

      {/* Body */}
      <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-[var(--text-tertiary)]">No log entries.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const e = rows[v.index];
              if (!e) return null;
              return (
                <div
                  key={e.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_H,
                    transform: `translateY(${v.start}px)`,
                  }}
                  className="flex items-center px-3 text-[11px] border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
                >
                  <span className="w-[120px] shrink-0 font-mono text-[10px] text-[var(--text-tertiary)]">
                    {fmtTime(e.timestamp)}
                  </span>
                  <span
                    className="w-[80px] shrink-0 truncate"
                    style={{ color: SOURCE_COLOR[e.source] ?? "var(--text-secondary)" }}
                  >
                    {e.source}
                  </span>
                  <span className="w-[150px] shrink-0 truncate text-[var(--text-tertiary)]">
                    {e.projectName ?? "—"}
                  </span>
                  <span className="w-[140px] shrink-0 truncate font-mono text-[var(--text-tertiary)]">
                    {e.kind}
                  </span>
                  <span
                    className="flex-1 min-w-0 truncate text-[var(--text-secondary)]"
                    title={e.summary}
                  >
                    {e.summary}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination footer */}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between px-3 h-[30px] shrink-0 border-t border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)]">
          <span className="font-mono tabular-nums">
            {clampedPage * PAGE_SIZE + 1}–{Math.min(filtered.length, (clampedPage + 1) * PAGE_SIZE)}{" "}
            of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              className="px-2 h-[22px] rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent"
            >
              Prev
            </button>
            <span className="font-mono tabular-nums px-1">
              {clampedPage + 1}/{pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={clampedPage >= pageCount - 1}
              className="px-2 h-[22px] rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  labels,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-[26px] rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 text-[11px] text-[var(--text-secondary)] outline-none max-w-[150px]",
      )}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(
    undefined,
    { hour: "2-digit", minute: "2-digit" },
  )}`;
}
