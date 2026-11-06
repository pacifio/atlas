import { PanelSkeleton } from "@/components/panel-skeleton";

export function PanelLoading() {
  // Structural skeleton (not centered text) so the first open of a lazy panel
  // while its JS chunk downloads reads as "loading content" rather than blank.
  return <PanelSkeleton rows={7} />;
}
