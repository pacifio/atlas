import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { AgentIcons } from "@/components/agent-icons";
import type { SessionSummary } from "@/features/artifacts/types";
import { AGENT_LABEL, type SwitchableAgent } from "@/types/agent";

/**
 * Generic Memory sub-view for agents whose sessions live ONLY in Atlas's own
 * capture store (`.atlas/sessions.db`) — OpenCode, Cursor, Kilo, and any
 * future ACP plugin. One component, parameterized by the plugin id; mirrors
 * the CodexView table shape. Rows come from `artifacts_sessions` filtered by
 * the `agent` column (the capture middleware stamps every session with its
 * plugin id).
 */
export function CaptureSessionsView({
  projectPath,
  agent,
}: {
  projectPath: string | null;
  agent: "opencode" | "cursor" | "kilo";
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!projectPath) {
      setSessions([]);
      return;
    }
    let stale = false;
    invoke<SessionSummary[]>("artifacts_sessions", { projectPath })
      .then((rows) => {
        if (stale) return;
        setSessions(
          rows
            .filter((r) => r.agent === agent)
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
        );
      })
      .catch(() => {
        if (!stale) setSessions([]);
      });
    return () => {
      stale = true;
    };
  }, [projectPath, agent]);

  const rows = useMemo(() => {
    const list = sessions ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        (s.model ?? "").toLowerCase().includes(q) ||
        s.branches.some((b) => b.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const Icon =
    agent === "opencode"
      ? AgentIcons.OpenCode
      : agent === "cursor"
        ? AgentIcons.Cursor
        : AgentIcons.Kilo;
  const label = AGENT_LABEL[agent as SwitchableAgent];

  if (sessions === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-1.5 max-w-[320px] px-4">
          <Icon className="size-6 mx-auto opacity-40" />
          <p className="text-[12px] text-[var(--text-secondary)]">No {label} sessions yet</p>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            {label} sessions are recorded by Atlas&apos;s session capture as you work. Run {label}{" "}
            in this project (with capture enabled) to populate this view and the memory graph.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Sessions
          <span className="ml-1.5 text-[9px] text-[var(--text-tertiary)] tabular-nums">
            {sessions.length}
          </span>
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 h-6 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 w-[200px] focus-within:border-[var(--border-strong)]">
          <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        <div style={{ minWidth: 720 }}>
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border-default)] bg-[var(--bg-base)] px-3 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            <span className="flex-1 min-w-[260px]">Session</span>
            <span className="w-[170px] shrink-0">Model</span>
            <span className="w-[120px] shrink-0">Branch</span>
            <span className="w-[70px] shrink-0 text-right">Msgs</span>
            <span className="w-[110px] shrink-0 text-right">Updated</span>
          </div>
          {rows.length === 0 ? (
            <div className="grid place-items-center h-[160px] text-[11px] text-[var(--text-tertiary)]">
              No sessions match.
            </div>
          ) : (
            rows.map((s) => (
              <div
                key={s.id}
                className="flex items-center h-[40px] px-3 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
              >
                <span className="flex-1 min-w-[260px] pr-3 flex items-center gap-2">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate text-[12px] text-[var(--text-primary)]">
                    {s.title?.trim() || "Untitled session"}
                  </span>
                </span>
                <span
                  className={cn(
                    "w-[170px] shrink-0 truncate font-mono text-[10px] text-[var(--text-tertiary)]",
                  )}
                >
                  {s.model || "—"}
                </span>
                <span className="w-[120px] shrink-0 truncate font-mono text-[11px] text-[var(--text-secondary)]">
                  {s.branches[0] || "—"}
                </span>
                <span className="w-[70px] shrink-0 text-right tabular-nums text-[11px] text-[var(--text-tertiary)]">
                  {s.messageCount || "—"}
                </span>
                <span className="w-[110px] shrink-0 text-right text-[10px] text-[var(--text-tertiary)]">
                  {s.lastActivityAt ? timeAgo(s.lastActivityAt, { suffix: true }) : "—"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
