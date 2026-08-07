import { useOrgStore } from "../stores/org-store";
import { AtlasLoader } from "@/components/atlas-loader";

/**
 * Full-app "Loading Organisation…" overlay, shown while an org switch tears down
 * the old org's workspaces and brings the new org's online. Mirrors the opaque
 * `.atlas-boot` skeleton (`#050505`) from `index.html` — it covers the sidebar +
 * center below the titlebar, since both the project list and the workspace are
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
      className="fixed inset-0 z-[var(--z-max)] flex flex-col items-center justify-center gap-4 bg-[#050505]"
      // Clear the titlebar drag zone so the overlay reads as app-body only.
      style={{ paddingTop: 30 }}
      aria-live="polite"
    >
      <AtlasLoader size={22} className="text-[var(--text-secondary)]" />
      <div className="text-[13px] text-[var(--text-tertiary)]">
        {name ? `Loading ${name}…` : "Loading organisation…"}
      </div>
    </div>
  );
}
