import { AtlasLoader } from "@/components/atlas-loader";

/**
 * Full-app "Loading organization…" overlay, shown while an org switch tears
 * down the old org's projects and brings the new org's online. Mirrors the
 * opaque `.atlas-boot` skeleton from `index.html`, which reads the same cached
 * theme background — it covers the sidebar + center below the titlebar, since
 * both the project list and the project are changing.
 */
export function LoadingOrganisationOverlayView({ name }: { name: string }) {
  return (
    <div
      className="fixed inset-0 z-overlay flex flex-col items-center justify-center gap-4 bg-background"
      // Clear the titlebar drag zone so the overlay reads as app-body only.
      style={{ paddingTop: 30 }}
      aria-live="polite"
    >
      <AtlasLoader size={22} className="text-secondary-foreground" />
      <div className="text-base text-muted-foreground">
        {name ? `Loading ${name}…` : "Loading organization…"}
      </div>
    </div>
  );
}
