import { useOrgStore } from "../stores/org-store";
import { AtlasLoader } from "@/components/atlas-loader";

/**
 * Full-app "Loading Organisation…" overlay, shown while an org switch tears down
 * the old org's projects and brings the new org's online. Mirrors the opaque
 * `.atlas-boot` skeleton from `index.html`, which reads the same cached
 * theme background — it covers the sidebar +
 * center below the titlebar, since both the project list and the project are
 * changing. Gated on `useOrgStore.orgSwitching`.
 */
export function LoadingOrganisationOverlay() {
  const orgSwitching = useOrgStore.use.orgSwitching();
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();

  if (!orgSwitching) return null;

  const name = organisations.find((o) => o.id === activeOrganisationId)?.name ?? "";

  return (
    <div
      className="fixed inset-0 z-overlay flex flex-col items-center justify-center gap-4 bg-background"
      // Clear the titlebar drag zone so the overlay reads as app-body only.
      style={{ paddingTop: 30 }}
      aria-live="polite"
    >
      <AtlasLoader size={22} className="text-[var(--secondary-foreground)]" />
      <div className="text-base text-[var(--muted-foreground)]">
        {name ? `Loading ${name}…` : "Loading organization…"}
      </div>
    </div>
  );
}
