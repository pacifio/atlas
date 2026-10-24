// The Add agent dialog: the ACP registry's agents that aren't added yet,
// searchable, one row each with Install. What the old full-page marketplace
// grid was, now behind the Agents page's + button.

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { Hint } from "@/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";
import { AtlasLoader } from "@/components/atlas-loader";
import { AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
import { TrendSparkline } from "@/components/trend-sparkline";
import { downloadTrend, fmtDownloads } from "@/features/agents/lib/download-trends";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import type { AcpRegistryEntry } from "@/features/agents/lib/agent-registry-api";
import { SettingsGroup, SettingsNote } from "../layout/settings-layout";
import { SettingsSearch } from "../layout/settings-search";
import {
  cardState,
  installAgent,
  marketplaceCards,
  refreshListing,
  useAgentListing,
  useInstalls,
} from "./agent-install";

const PAGE_SIZE = 20;

export function AddAgentDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the agent's id once an install from here lands. */
  onAdded: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => setLimit(PAGE_SIZE), [query]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { registryEntries, catalogById, signature } = useAgentListing();
  const loaded = useAgentRegistryStore((s) => s.registryLoaded);
  const refreshing = useAgentRegistryStore((s) => s.registryRefreshing);
  const error = useAgentRegistryStore((s) => s.registryError);
  const installs = useInstalls();

  const offers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return marketplaceCards(registryEntries, catalogById).filter(
      (e) =>
        // An agent installing from here stays listed until it lands, so its
        // row can show the progress.
        (cardState(e, catalogById[e.id]) === "install" || installs.installing(e.id)) &&
        (!q ||
          e.name.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q) ||
          (e.description ?? "").toLowerCase().includes(q)),
    );
    // `signature` moves whenever the arrays do; they are not stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, query, installs]);

  const install = async (entry: AcpRegistryEntry) => {
    await installAgent(entry, "registry");
    if (useAgentRegistryStore.getState().catalogById[entry.id]?.installed) onAdded(entry.id);
  };

  const more = Math.min(PAGE_SIZE, offers.length - limit);
  const empty =
    registryEntries.length === 0
      ? !loaded || refreshing
        ? "Loading the ACP registry…"
        : error
          ? `Couldn't reach the ACP registry: ${error}`
          : "The ACP registry is empty."
      : query.trim()
        ? `No agent matches “${query.trim()}”.`
        : "You've added every agent the registry lists.";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[min(44rem,calc(100vh-4rem))] max-w-[min(44rem,calc(100vw-2rem))] gap-4">
        <DialogHeader className="mr-8">
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription>
            Agents published to the ACP registry. Atlas installs one into its own folder, and it
            shows up in the agent picker.
          </DialogDescription>
        </DialogHeader>
        <div className="flex">
          <SettingsSearch
            value={query}
            onValueChange={setQuery}
            label="Search the ACP registry"
            placeholder="Search the ACP registry"
            trailing={refreshing && <AtlasLoader size={11} />}
          />
        </div>
        <div className="-mx-4 min-h-0 overflow-y-auto px-4">
          <SettingsGroup>
            {offers.length === 0 ? (
              <div className="flex items-center justify-between gap-3 pr-3">
                <SettingsNote>{empty}</SettingsNote>
                {registryEntries.length === 0 && error && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshing}
                    onClick={() => void refreshListing()}
                  >
                    Try again
                  </Button>
                )}
              </div>
            ) : (
              offers
                .slice(0, limit)
                .map((entry) => (
                  <OfferRow
                    key={entry.id}
                    entry={entry}
                    installing={installs.installing(entry.id)}
                    percent={installs.percent(entry.id)}
                    onInstall={() => void install(entry)}
                  />
                ))
            )}
            {more > 0 && (
              <div className="p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                >
                  Show {more} more
                </Button>
              </div>
            )}
          </SettingsGroup>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OfferRow({
  entry,
  installing,
  percent,
  onInstall,
}: {
  entry: AcpRegistryEntry;
  installing: boolean;
  percent: number | null;
  onInstall: () => void;
}) {
  const trend = useMemo(
    () => downloadTrend(entry.id, entry.installed),
    [entry.id, entry.installed],
  );
  const button = (
    <Button
      variant="outline"
      size="sm"
      className="w-20 tabular-nums"
      disabled={installing || !entry.platformSupported}
      aria-label={`Install ${entry.name}`}
      onClick={onInstall}
    >
      {installing ? <AtlasLoader size={11} /> : <Icon icon={Download} size="xs" />}
      {installing && percent !== null ? `${percent}%` : "Install"}
    </Button>
  );
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {/* Explicit colour, not inherited: registry icons are monochrome
          `currentColor` art, so the tile decides whether they are legible. */}
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
        {entry.iconDataUrl ? (
          <ExternalAgentIcon dataUrl={entry.iconDataUrl} size={16} />
        ) : (
          <AgentMonogram label={entry.name} size={16} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
          {entry.version && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              v{entry.version}
            </span>
          )}
        </div>
        {entry.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        )}
        <p className={cn("caption", !entry.platformSupported && "text-warning")}>
          {entry.platformSupported
            ? [entry.distributionKind, entry.id].filter(Boolean).join(" · ")
            : `Not available on this platform${entry.unsupportedReason ? `: ${entry.unsupportedReason}` : ""}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-center">
        <span className="flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
          <TrendSparkline
            points={trend.points}
            width={48}
            height={16}
            label={`About ${trend.total.toLocaleString()} downloads in the last 6 months`}
          />
          <span className="w-10 text-right">{fmtDownloads(trend.total)}</span>
        </span>
        {entry.platformSupported ? (
          button
        ) : (
          <Hint label="Not available on this platform">
            <span tabIndex={0}>{button}</span>
          </Hint>
        )}
      </div>
    </div>
  );
}
