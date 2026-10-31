import { lazy, Suspense, useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { PaneHeader } from "@/components/titlebar";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { Hint } from "@/ui/tooltip";
import { Icon } from "@/ui/icon";
import { cn } from "@/lib/utils";
import { isDestination, type DestinationType } from "@/lib/constants";
import { useLayoutStore, type Tab } from "../stores/layout-store";
import { DESTINATIONS } from "../lib/destinations";
import { DestinationActionsSlot } from "./destination-actions";
import { eventOrigin } from "@/lib/deep-active-element";

const KnowledgePanel = lazy(() =>
  import("@/features/knowledge/components/knowledge-panel").then((m) => ({
    default: m.KnowledgePanel,
  })),
);
const KnowledgeGraph = lazy(() =>
  import("@/features/knowledge/components/knowledge-graph").then((m) => ({
    default: m.KnowledgeGraph,
  })),
);
const UsagePanel = lazy(() =>
  import("@/features/usage/components/usage-panel").then((m) => ({ default: m.UsagePanel })),
);
const ArtifactsPanel = lazy(() =>
  import("@/features/artifacts/components/artifacts-panel").then((m) => ({
    default: m.ArtifactsPanel,
  })),
);
const CanvasPanel = lazy(() =>
  import("@/features/canvas/components/canvas-panel").then((m) => ({ default: m.CanvasPanel })),
);
const MemoryPanel = lazy(() =>
  import("@/features/memory/components/memory-panel").then((m) => ({ default: m.MemoryPanel })),
);
// Team chat is also a surface; as a destination it is the same panel, full
// width (ADR-0024's amendment).
const CommsPanel = lazy(() =>
  import("@/features/comms/components/comms-panel").then((m) => ({ default: m.CommsPanel })),
);
const SpacesTab = lazy(() =>
  import("@/features/spaces/components/spaces-tab").then((m) => ({ default: m.SpacesTab })),
);

/**
 * The destination (ADR-0024): a full-page view over the split
 * columns, right of the rail, while the session keeps running underneath.
 *
 * Back hides it rather than unmounting it, so returning is instant and the
 * page keeps its scroll, selection and drafts, the way Settings does. Opening
 * another destination replaces it.
 */
export function DestinationScreen() {
  const destination = useLayoutStore.use.destination();
  const shown = useLayoutStore.use.destinationShown();
  const { hideDestination } = useLayoutStore.use.actions();
  // Where the page's own controls render (`DestinationActions`).
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (escapeBelongsElsewhere(e)) return;
      e.preventDefault();
      hideDestination();
    };
    // Bubble phase, so the page's own Esc handlers (closing a search, leaving
    // a selection) run first and can claim the key.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, hideDestination]);

  if (!destination || !isDestination(destination.type)) return null;
  const meta = DESTINATIONS[destination.type];
  return (
    <div
      className={cn("absolute inset-0 z-panel flex flex-col bg-background", !shown && "hidden")}
      aria-hidden={!shown}
      data-destination={destination.type}
    >
      <PaneHeader leading breadcrumb trailing>
        <Hint label="Back to the session (Esc)">
          <button
            type="button"
            onClick={hideDestination}
            className="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-md pl-1 pr-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-element-hover focus-visible:bg-element-hover"
          >
            <Icon icon={ChevronLeft} size="sm" className="shrink-0 text-muted-foreground" />
            <Icon icon={meta.icon} size="md" className="shrink-0 text-muted-foreground" />
            <span className="truncate">{destination.title || meta.title}</span>
          </button>
        </Hint>
        {/* Fills the bar's free width and right-aligns, so the page's
            controls sit against the window's trailing dock. */}
        <div
          ref={setActionsSlot}
          className="flex min-w-0 flex-1 items-center justify-end gap-2 pr-1"
        />
      </PaneHeader>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <DestinationActionsSlot.Provider value={actionsSlot}>
          <Suspense fallback={<PanelSkeleton rows={7} />}>
            <DestinationBody key={destination.id} tab={destination} type={destination.type} />
          </Suspense>
        </DestinationActionsSlot.Provider>
      </div>
    </div>
  );
}

/** One destination's page. A `switch` with a `never` default, so a new
 *  destination without a page does not compile. */
function DestinationBody({ tab, type }: { tab: Tab; type: DestinationType }) {
  switch (type) {
    case "artifacts":
      return <ArtifactsPanel />;
    case "usage":
      return <UsagePanel />;
    case "knowledge":
      return <KnowledgePanel tabId={tab.id} />;
    case "knowledge-graph":
      return <KnowledgeGraph />;
    case "memory":
      return <MemoryPanel />;
    case "canvas":
      return <CanvasPanel />;
    case "spaces":
      return <SpacesTab convId={tab.data.convId as string} />;
    case "team-chat":
      // The full window: channels and people beside the conversation.
      return <CommsPanel split />;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/** Esc stays with a text field, and with anything layered over the page (a
 *  dialog, menu or popover closes first). */
function escapeBelongsElsewhere(e: KeyboardEvent): boolean {
  const target = eventOrigin(e);
  if (target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")) return true;
  return !!document.querySelector(
    "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
  );
}
