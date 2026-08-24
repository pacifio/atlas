import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { AgentMark } from "@/components/agent-mark";
import { pluginIdForSource } from "../lib/memory-agent";

export interface PanelItem {
  id: string; // memory doc id ("claude:…" / "codex:…" / "cersei:…")
  title: string;
  source: string; // "claude" | "codex" | "cersei"
  note: string; // e.g. "affected a1b2c3 on main" / "matched · impacts 3 commits"
  ts_ms: number;
  score?: number; // search relevance, 0..1
}

/**
 * Slide-in impact panel (mirrors the notification panel's motion) scoped to the
 * timeline pane. Lists the memory affecting the selected item, newest→oldest,
 * or the memory matching a search and the git it impacted.
 */
export function MemoryTimelinePanel({
  open,
  title,
  subtitle,
  items,
  onClose,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  items: PanelItem[];
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <>
      <div
        className="absolute inset-0 z-20 bg-black/10 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={cn(
          "absolute right-0 top-0 bottom-0 z-30 w-[330px] flex flex-col",
          "border-l border-[var(--border-default)] bg-[var(--bg-elevated)]/75 backdrop-blur-2xl",
          "shadow-[var(--shadow-overlay)] animate-slide-in-right",
        )}
      >
        <div className="flex items-start gap-2 px-3 h-[40px] shrink-0 border-b border-[var(--border-default)]">
          <div className="flex-1 min-w-0 pt-1">
            <div className="text-[11px] font-medium text-[var(--text-primary)] truncate">
              {title}
            </div>
            <div className="text-[9px] text-[var(--text-tertiary)] truncate">{subtitle}</div>
          </div>
          <button
            onClick={onClose}
            className="mt-1 flex items-center justify-center w-5 h-5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            title="Close"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
              No memory linked to this yet.
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id + it.note}
                className="w-full text-left px-3 py-2.5 border-b border-[var(--border-subtle)] flex flex-col gap-0.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <AgentMark
                    agentType={pluginIdForSource(it.source)}
                    className="shrink-0 opacity-70"
                  />
                  <span className="text-[11px] text-[var(--text-primary)] truncate flex-1">
                    {it.title}
                  </span>
                  {it.score !== undefined && (
                    <span className="text-[9px] text-[var(--text-tertiary)] tabular-nums">
                      {Math.round(it.score * 100)}%
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[9px] text-[var(--text-tertiary)]">
                  <span className="truncate flex-1">{it.note}</span>
                  {it.ts_ms > 0 && (
                    <span className="shrink-0">
                      {timeAgo(new Date(it.ts_ms).toISOString(), { suffix: true })}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
