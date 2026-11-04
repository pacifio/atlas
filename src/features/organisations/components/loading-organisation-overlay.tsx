import { useOrgStore } from "../stores/org-store";
import { LoadingOrganisationOverlayView } from "./views/loading-organisation-overlay-view";

/** The org-switch overlay's container, gated on `useOrgStore.orgSwitching`. */
export function LoadingOrganisationOverlay() {
  const orgSwitching = useOrgStore.use.orgSwitching();
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();

  if (!orgSwitching) return null;

  const name = organisations.find((o) => o.id === activeOrganisationId)?.name ?? "";
  return <LoadingOrganisationOverlayView name={name} />;
}
