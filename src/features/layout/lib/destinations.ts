import {
  Brain,
  BrainCircuit,
  Frame,
  Gauge,
  Layers,
  Map,
  MessagesSquare,
  Network,
  type LucideIcon,
} from "lucide-react";
import type { DestinationType } from "@/lib/constants";
import { useLayoutStore } from "../stores/layout-store";

/**
 * Destinations (ADR-0024): full-page views that take the area right of the
 * rail, one at a time, while the session keeps running underneath. They are
 * opened through `addTab` like anything else, which routes them here instead
 * of into a column; this module is the shared vocabulary for the entry points.
 */

export interface DestinationMeta {
  title: string;
  icon: LucideIcon;
}

/** Keyed by `DestinationType`, so a new destination without a title and icon
 *  does not compile. */
export const DESTINATIONS: Record<DestinationType, DestinationMeta> = {
  artifacts: { title: "Timeline", icon: Layers },
  usage: { title: "Usage", icon: Gauge },
  knowledge: { title: "Knowledge", icon: Brain },
  "knowledge-graph": { title: "Knowledge graph", icon: Network },
  memory: { title: "Memory", icon: BrainCircuit },
  canvas: { title: "Spaces", icon: Map },
  spaces: { title: "Space", icon: Frame },
  // Also a surface (`surface-or-destination`); `team-chat.ts` picks the form.
  "team-chat": { title: "Team chat", icon: MessagesSquare },
};

type LayoutSnapshot = ReturnType<typeof useLayoutStore.getState>;

/** Whether `type` is the destination on screen. Selector-shaped. */
export function destinationShown(s: LayoutSnapshot, type: DestinationType): boolean {
  return s.destinationShown && s.destination?.type === type;
}

/** Open `type` on the destination screen (its singleton id; a Space opens
 *  through `openSpace`). A type that is also a surface leaves its column. */
export function openDestination(type: Exclude<DestinationType, "spaces">): void {
  useLayoutStore.getState().actions.showDestination({
    id: type,
    type,
    title: DESTINATIONS[type].title,
    closable: true,
    dirty: false,
    data: {},
  });
}

/** A destination's own entry point (its rail item, its shortcut): back to the
 *  session when it is the one on screen, else open it. */
export function toggleDestination(type: Exclude<DestinationType, "spaces">): void {
  const s = useLayoutStore.getState();
  if (destinationShown(s, type)) s.actions.hideDestination();
  else openDestination(type);
}
