import { useMemo } from "react";
import { useProjectStore, type Project } from "../stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

/**
 * The ONE org-scoping rule for projects. Every surface that renders
 * or aggregates the project registry must go through these helpers — ad-hoc
 * filters are how the "org1's projects show up in org2" leak happened. The
 * filter is STRICT (`orgId === orgId`, no null fallback): untagged rows are
 * healed at creation (`requireActiveOrgId`), at boot (Rust `migrate()`), and
 * on re-open (legacy adopt in `addProject`/`addProjectEntry`), so a row
 * without an org simply does not render anywhere.
 *
 * Lives in `lib/` (not a store) so importing both stores here doesn't create
 * a store↔store import cycle.
 */

function projectsForOrg(projects: Project[], orgId: string | null): Project[] {
  if (orgId == null) return [];
  return projects.filter((w) => w.orgId === orgId);
}

/** Hook: the active org's projects (registry order preserved). */
export function useActiveOrgProjects(): Project[] {
  const all = useProjectStore.use.projects();
  const orgId = useOrgStore.use.activeOrganisationId();
  return useMemo(() => projectsForOrg(all, orgId), [all, orgId]);
}

/** Imperative snapshot for stores / non-React code (Mission Control, prefetch,
 *  keyboard handlers). Not reactive — call at use time, don't cache. */
export function activeOrgProjectsSnapshot(): Project[] {
  return projectsForOrg(
    useProjectStore.getState().projects,
    useOrgStore.getState().activeOrganisationId,
  );
}
