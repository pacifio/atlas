// Settings → Agents. The ACP Registry marketplace (modeled on Zed's): every
// agent published to the official ACP registry, searchable, with
// All/Installed/Not-Installed pills and per-card Install/Remove. The five
// entries that duplicate first-party Atlas agents render a "Built-in" badge.
//
// Install state machine mirrors skills-marketplace.tsx: in-flight ids live at
// MODULE scope behind useSyncExternalStore so a mid-install unmount (switching
// settings sections) doesn't lose the spinner; binary downloads stream
// progress via `atlas:registry-install:progress`.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Download, Github, Globe, Loader2, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
import {
  acpRegistry,
  type AcpRegistryEntry,
  type AcpRegistryListing,
  type RegistryInstallProgress,
} from "@/features/agents/lib/agent-registry-api";
import { hydrateAgentRegistry } from "@/features/agents/stores/agent-registry-store";
import { downloadTrend, fmtDownloads } from "@/features/agents/lib/download-trends";
import { TrendSparkline } from "@/components/trend-sparkline";

// ── Module-scope install tracking (survives unmount) ─────────────────────────

const installingIds = new Set<string>();
let installVersion = 0;
const installSubs = new Set<() => void>();
function notifyInstalling() {
  installVersion++;
  installSubs.forEach((f) => f());
}
function subscribeInstalling(cb: () => void) {
  installSubs.add(cb);
  return () => installSubs.delete(cb);
}

/** Latest download progress per agent id (binary distributions only). */
const progressById = new Map<string, RegistryInstallProgress>();

type Filter = "all" | "installed" | "not-installed";

export function AgentsMarketplace() {
  const [listing, setListing] = useState<AcpRegistryListing | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  useSyncExternalStore(subscribeInstalling, () => installVersion);

  const reload = useCallback(async () => {
    try {
      setListing(await acpRegistry.list());
    } catch (e) {
      toast.error(`Couldn't load the ACP registry: ${String(e)}`);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setListing(await acpRegistry.refresh());
    } catch (e) {
      toast.error(`Registry refresh failed: ${String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Cached list instantly, then a network refresh (throttled server-side).
  useEffect(() => {
    void reload().then(() => void refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Binary-download progress → re-render the affected card.
  useEffect(() => {
    const unlisten = listen<RegistryInstallProgress>("atlas:registry-install:progress", (event) => {
      progressById.set(event.payload.agentId, event.payload);
      notifyInstalling();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const install = useCallback(
    async (entry: AcpRegistryEntry) => {
      if (installingIds.has(entry.id)) return;
      installingIds.add(entry.id);
      notifyInstalling();
      try {
        await acpRegistry.install(entry.id);
        toast.success(`${entry.name} installed`);
      } catch (e) {
        toast.error(`Couldn't install ${entry.name}: ${String(e)}`);
      } finally {
        installingIds.delete(entry.id);
        progressById.delete(entry.id);
        notifyInstalling();
      }
      await reload();
      void hydrateAgentRegistry();
    },
    [reload],
  );

  const uninstall = useCallback(
    async (entry: AcpRegistryEntry) => {
      try {
        await acpRegistry.uninstall(entry.id);
        toast.success(`${entry.name} removed`);
      } catch (e) {
        toast.error(`Couldn't remove ${entry.name}: ${String(e)}`);
      }
      await reload();
      void hydrateAgentRegistry();
    },
    [reload],
  );

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((e) => {
      if (filter === "installed" && !(e.installed || e.builtin)) return false;
      if (filter === "not-installed" && (e.installed || e.builtin)) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [listing, query, filter]);

  return (
    <div className="h-full flex flex-col">
      {/* Header — a single row: search + filter pills left, refresh right. */}
      <div className="shrink-0 px-4 py-2 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-[320px]">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search registry"
              className="w-full h-7 pl-7 pr-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--border-focus,var(--border-default))]"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X size={11} />
              </button>
            )}
          </div>
          <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-secondary))] p-0.5">
            {(
              [
                ["all", "All"],
                ["installed", "Installed"],
                ["not-installed", "Not Installed"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={cn(
                  "h-[22px] px-2.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer",
                  filter === id
                    ? "bg-[var(--bg-selected,var(--bg-hover))] text-[var(--text-primary)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 h-6 px-2 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            title="Refresh the registry"
          >
            <RefreshCw size={11} className={cn(refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
        {listing?.lastError && (
          <p className="text-[10px] text-[var(--text-tertiary)]">
            Last refresh failed ({listing.lastError}) — showing cached data.
          </p>
        )}
      </div>

      {/* Card list. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {listing === null ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : entries.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[12px] text-[var(--text-tertiary)]">
              {listing.entries.length === 0
                ? "Registry unavailable — check your connection and refresh."
                : "No agents match."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2.5">
            {entries.map((entry) => (
              <AgentCard
                key={entry.id}
                entry={entry}
                installing={installingIds.has(entry.id)}
                progress={progressById.get(entry.id) ?? null}
                onInstall={() => void install(entry)}
                onUninstall={() => void uninstall(entry)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  entry,
  installing,
  progress,
  onInstall,
  onUninstall,
}: {
  entry: AcpRegistryEntry;
  installing: boolean;
  progress: RegistryInstallProgress | null;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const pct =
    installing && progress?.total
      ? Math.min(100, (progress.received / progress.total) * 100)
      : null;
  const trend = useMemo(
    () => downloadTrend(entry.id, entry.installed),
    [entry.id, entry.installed],
  );
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3.5 py-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <span className="flex items-center justify-center size-7 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-primary))] shrink-0">
          {entry.iconDataUrl ? (
            <ExternalAgentIcon dataUrl={entry.iconDataUrl} size={16} />
          ) : (
            <AgentMonogram label={entry.name} size={16} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[12.5px] font-semibold text-[var(--text-primary)] truncate">
              {entry.name}
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
              v{entry.version}
            </span>
            {entry.unverified && entry.distributionKind === "binary" && (
              <span
                className="text-[9px] px-1 rounded bg-[var(--bg-hover)] text-[var(--text-tertiary)]"
                title="This agent's binary download publishes no checksum."
              >
                unverified
              </span>
            )}
          </div>
          {!entry.platformSupported && (
            <p className="text-[10px] text-[var(--warning,#c90)]">
              Not supported on this platform
              {entry.unsupportedReason ? ` — ${entry.unsupportedReason}` : ""}
            </p>
          )}
        </div>
        <CardAction
          entry={entry}
          installing={installing}
          pct={pct}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />
      </div>
      {entry.description && (
        <p className="text-[11px] leading-snug text-[var(--text-secondary)] line-clamp-2">
          {entry.description}
        </p>
      )}
      <div className="flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
        <span className="font-mono">ID: {entry.id}</span>
        {entry.distributionKind && <span className="font-mono">[{entry.distributionKind}]</span>}
        <span className="flex-1" />
        {/* 6-month download trend — seeded mock series today, PostHog-backed
            once the `acp_agent_installed` events accrue. Count wears a text
            token; only the sparkline mark carries the trend color. */}
        <span className="tabular-nums">{fmtDownloads(trend.total)}</span>
        <TrendSparkline
          points={trend.points}
          width={64}
          height={20}
          label={`≈${trend.total.toLocaleString()} downloads in the last 6 months`}
        />
        {entry.repository && (
          <button
            onClick={() => void openUrl(entry.repository!)}
            className="hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            title={entry.repository}
          >
            <Github size={11} />
          </button>
        )}
        {entry.website && (
          <button
            onClick={() => void openUrl(entry.website!)}
            className="hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            title={entry.website}
          >
            <Globe size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function CardAction({
  entry,
  installing,
  pct,
  onInstall,
  onUninstall,
}: {
  entry: AcpRegistryEntry;
  installing: boolean;
  pct: number | null;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  if (entry.builtin) {
    return (
      <span
        className="flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-medium text-[var(--text-tertiary)] border border-[var(--border-default)]"
        title="This agent ships with Atlas."
      >
        <Check size={10} />
        Built-in
      </span>
    );
  }
  if (installing) {
    return (
      <span className="flex items-center gap-1.5 h-6 px-2 rounded-md text-[10.5px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)] tabular-nums">
        <Loader2 size={10} className="animate-spin" />
        {pct !== null ? `${Math.round(pct)}%` : "Installing…"}
      </span>
    );
  }
  if (entry.installed) {
    return (
      <button
        onClick={() => {
          if (confirm(`Remove ${entry.name}? Chat history from this agent is kept.`)) onUninstall();
        }}
        className="h-6 px-2.5 rounded-md text-[10.5px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
      >
        Remove
      </button>
    );
  }
  return (
    <button
      onClick={onInstall}
      disabled={!entry.platformSupported}
      className={cn(
        "flex items-center gap-1 h-6 px-2.5 rounded-md text-[10.5px] font-medium border transition-colors",
        entry.platformSupported
          ? "text-[var(--text-primary)] border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-primary))] hover:bg-[var(--bg-hover)] cursor-pointer"
          : "text-[var(--text-tertiary)] border-[var(--border-default)] opacity-50 cursor-not-allowed",
      )}
    >
      <Download size={10} />
      Install
    </button>
  );
}
