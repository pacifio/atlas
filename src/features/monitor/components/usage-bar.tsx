import { useEffect, useMemo, useState } from "react";
import {
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { BarChart3, Zap, Clock } from "lucide-react";
import { useUsageStore } from "../stores/usage-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { getClaudeSessionStats } from "@/features/chat/lib/claude-api";
import { listen } from "@tauri-apps/api/event";

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function UsageBar() {
  const inputTokensFallback = useUsageStore.use.inputTokens();
  const outputTokensFallback = useUsageStore.use.outputTokens();
  const totalCostFallback = useUsageStore.use.totalCost();
  const requestCountFallback = useUsageStore.use.requestCount();
  const sessionStart = useUsageStore.use.sessionStart();
  const [expanded, setExpanded] = useState(false);

  const activeTabId = useLayoutStore.use.activeTabId();
  const tabs = useLayoutStore.use.tabs();
  const project = useProjectStore.use.currentProject();

  // Active chat session (only when the active tab is an agent-mode chat with
  // a bound ACP session). Pulled via a narrow shallow-equal selector so the
  // usage bar doesn't re-render on every streaming chunk — only when one of
  // these three fields actually changes.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const chatSession = useChatStore(
    useShallow((s) => {
      if (!activeTab || activeTab.type !== "chat") return null;
      const sess = s.sessions[activeTab.id];
      if (!sess) return null;
      return {
        acpSessionId: sess.acpSessionId,
        status: sess.status,
      };
    }),
  );
  const acpSessionId = chatSession?.acpSessionId ?? null;
  const isStreaming = chatSession?.status === "running";
  const cwd = project?.path ?? "";

  const queryClient = useQueryClient();
  const queryKey = ["claude-session-stats", cwd, acpSessionId] as const;

  const { data: stats } = useQuery({
    queryKey,
    queryFn: () => getClaudeSessionStats(cwd, acpSessionId as string),
    enabled: !!acpSessionId && cwd.length > 0,
    staleTime: 30_000,
    // Polling killed: the Rust file watcher (started by SessionSidebar) emits
    // `atlas:sessions-changed` whenever any JSONL in the project rewrites,
    // and the effect below invalidates this query in response. That means
    // we re-read the stats file exactly when Claude flushes — not every
    // 1.5s while we're guessing it might have.
    refetchInterval: false,
    // Keep the previously-rendered totals visible while a new query (after
    // a tab switch / session change) is in flight. Without this the bar
    // briefly blanks every time you click a history row.
    placeholderData: keepPreviousData,
  });

  // Push refresh on file-watch + on turn-end status transitions.
  useEffect(() => {
    if (!acpSessionId) return;
    const unlistenPromise = listen<{ cwd: string }>(
      "atlas:sessions-changed",
      (e) => {
        if (e.payload.cwd !== cwd) return;
        queryClient.invalidateQueries({ queryKey });
      },
    );
    return () => {
      unlistenPromise.then((u) => u());
    };
  }, [acpSessionId, cwd, queryClient, queryKey]);
  useEffect(() => {
    if (!acpSessionId) return;
    if (isStreaming) return;
    queryClient.invalidateQueries({ queryKey });
  }, [acpSessionId, isStreaming, queryClient, queryKey]);

  const display = useMemo(() => {
    if (acpSessionId && stats) {
      return {
        inputTokens: stats.input_tokens,
        outputTokens: stats.output_tokens,
        cacheCreation: stats.cache_creation_tokens,
        cacheRead: stats.cache_read_tokens,
        totalCost: stats.total_cost_usd,
        requestCount: stats.request_count,
        model: stats.model,
        source: "claude" as const,
      };
    }
    return {
      inputTokens: inputTokensFallback,
      outputTokens: outputTokensFallback,
      cacheCreation: 0,
      cacheRead: 0,
      totalCost: totalCostFallback,
      requestCount: requestCountFallback,
      model: null as string | null,
      source: "provider" as const,
    };
  }, [
    acpSessionId,
    stats,
    inputTokensFallback,
    outputTokensFallback,
    totalCostFallback,
    requestCountFallback,
  ]);

  const totalTokens =
    display.inputTokens +
    display.outputTokens +
    display.cacheCreation +
    display.cacheRead;
  const elapsed = Math.floor((Date.now() - sessionStart) / 60000);

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors font-mono cursor-pointer"
      >
        <Zap size={10} className="text-accent" />
        <span>{formatCount(totalTokens)} tokens</span>
        <span>·</span>
        <span>{display.requestCount} calls</span>
        <span>·</span>
        <span>${display.totalCost.toFixed(4)}</span>
        {display.model && (
          <>
            <span>·</span>
            <span className="truncate max-w-[120px]" title={display.model}>
              {display.model}
            </span>
          </>
        )}
      </button>

      {expanded && (
        <div
          data-browser-suppress
          className="absolute bottom-full right-0 mb-2 w-[280px] rounded-lg border border-border-default bg-bg-secondary shadow-lg p-3 space-y-2"
          style={{ zIndex: "var(--z-max)" as unknown as number }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
            <BarChart3 size={12} />
            {display.source === "claude"
              ? "Claude Code Session"
              : "Session Usage"}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <UsageStat
              label="Input"
              value={display.inputTokens.toLocaleString()}
            />
            <UsageStat
              label="Output"
              value={display.outputTokens.toLocaleString()}
            />
            {display.source === "claude" && (
              <>
                <UsageStat
                  label="Cache write"
                  value={display.cacheCreation.toLocaleString()}
                />
                <UsageStat
                  label="Cache read"
                  value={display.cacheRead.toLocaleString()}
                />
              </>
            )}
            <UsageStat label="Requests" value={String(display.requestCount)} />
            <UsageStat
              label="Cost"
              value={`$${display.totalCost.toFixed(4)}`}
            />
          </div>

          {display.model && (
            <div
              className="text-[9px] font-mono text-text-tertiary truncate"
              title={display.model}
            >
              model: {display.model}
            </div>
          )}

          <div className="flex items-center gap-1 text-[9px] text-text-tertiary pt-1 border-t border-border-subtle">
            <Clock size={9} />
            {display.source === "claude"
              ? "Live from .jsonl"
              : `Session: ${elapsed}m`}
          </div>
        </div>
      )}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border-default bg-bg-primary px-2 py-1">
      <div className="text-[11px] font-mono text-text-primary">{value}</div>
      <div className="text-[8px] text-text-tertiary uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
}
