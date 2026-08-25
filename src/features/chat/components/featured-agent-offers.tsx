import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
import { acpRegistry } from "@/features/agents/lib/agent-registry-api";
import { hydrateAgentRegistry } from "@/features/agents/stores/agent-registry-store";
import {
  agentTypeForRegistryId,
  useFeaturedAgentOffers,
} from "@/features/agents/lib/featured-agents";

/**
 * The "you could also have these" half of the composer's agent picker: a short,
 * marketed list of popular agents the user has not installed, each a one-click
 * install that switches the chat to it when it lands.
 *
 * Renders NOTHING once the user has them all — the divider goes with it, so a
 * fully-stocked picker is exactly the list of agents you can switch to.
 *
 * Installing writes the same installed-map entry the Marketplace writes (there
 * is no second install path); the binary, if any, is fetched by the first
 * connect. So "installed" here means "switchable now", which is why switching
 * to it immediately afterwards is safe.
 */
export function FeaturedAgentOffers({
  onInstalled,
}: {
  /** Called with the new agent's agentType once it is installed and switchable. */
  onInstalled: (agentType: string) => void;
}) {
  const offers = useFeaturedAgentOffers();
  // Component-local is enough: the composer's group panel stays MOUNTED while
  // closed (height 0), so closing the panel mid-install does not lose the row's
  // spinner the way unmounting would.
  const [installing, setInstalling] = useState<string | null>(null);

  if (offers.length === 0) return null;

  const install = async (id: string, label: string) => {
    if (installing) return;
    setInstalling(id);
    try {
      await acpRegistry.install(id);
      // The catalog is what knows the installed agent's display alias, so the
      // agentType can only be resolved after this lands.
      await hydrateAgentRegistry();
      toast.success(`${label} installed`);
      onInstalled(agentTypeForRegistryId(id));
    } catch (e) {
      toast.error(`Couldn't install ${label}: ${String(e)}`);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <>
      <div className="h-px bg-[var(--border-default)]" />
      <div className="px-3 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
        Available to install
      </div>
      <div className="p-1 pt-0.5">
        {offers.map((offer) => {
          const busy = installing === offer.id;
          const disabled = !offer.platformSupported || (!!installing && !busy);
          return (
            <button
              key={offer.id}
              onClick={() => void install(offer.id, offer.label)}
              disabled={disabled}
              title={
                offer.platformSupported
                  ? `Install ${offer.label} and switch this chat to it`
                  : `${offer.label} has no published build for this platform`
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                disabled
                  ? "cursor-default opacity-40"
                  : "cursor-pointer hover:bg-[var(--bg-hover)]",
              )}
            >
              {/* Same tile as the marketplace's, and the same reason for the
                  explicit text color: registry icons are monochrome
                  `currentColor` art, so the container decides legibility. */}
              <span className="flex size-4 shrink-0 items-center justify-center rounded border border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-primary))] text-[var(--text-secondary)]">
                {offer.iconDataUrl ? (
                  <ExternalAgentIcon dataUrl={offer.iconDataUrl} size={10} />
                ) : (
                  <AgentMonogram label={offer.label} size={10} />
                )}
              </span>
              <span className="flex-1 truncate text-[11px] font-medium text-[var(--text-secondary)]">
                {offer.label}
              </span>
              {busy ? (
                <Loader2 size={11} className="shrink-0 animate-spin text-[var(--text-tertiary)]" />
              ) : (
                <Download size={11} className="shrink-0 text-[var(--text-tertiary)]" />
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
