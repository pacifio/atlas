import { useMemo } from "react";
import { useWorkspaceStore, type Workspace, type WorkspaceGroup } from "../stores/workspace-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

/**
 * The ONE org-scoping rule for workspaces/groups. Every surface that renders
 * or aggregates the project registry must go through these helpers — ad-hoc
 * filters are how the "org1's projects show up in org2" leak happened. The
 * filter is STRICT (`orgId === orgId`, no null fallback): untagged rows are
 * healed at creation (`requireActiveOrgId`), at boot (Rust `migrate()`), and
 * on re-open (legacy adopt in `addWorkspace`/`addProjectEntry`), so a row
 * without an org simply does not render anywhere.
 *
 * Lives in `lib/` (not a store) so importing both stores here doesn't create
 * a store↔store import cycle.
 */

export function workspacesForOrg(workspaces: Workspace[], orgId: string | null): Workspace[] {
  if (orgId == null) return [];
  return workspaces.filter((w) => w.orgId === orgId);
}

export function groupsForOrg(groups: WorkspaceGroup[], orgId: string | null): WorkspaceGroup[] {
  if (orgId == null) return [];
  return groups.filter((g) => g.orgId === orgId);
}

/** Hook: the active org's workspaces (registry order preserved). */
export function useActiveOrgWorkspaces(): Workspace[] {
  const all = useWorkspaceStore.use.workspaces();
  const orgId = useOrgStore.use.activeOrganisationId();
  return useMemo(() => workspacesForOrg(all, orgId), [all, orgId]);
}

/** Hook: the active org's groups. */
export function useActiveOrgGroups(): WorkspaceGroup[] {
  const all = useWorkspaceStore.use.groups();
  const orgId = useOrgStore.use.activeOrganisationId();
  return useMemo(() => groupsForOrg(all, orgId), [all, orgId]);
}

/** Imperative snapshot for stores / non-React code (Mission Control, prefetch,
 *  keyboard handlers). Not reactive — call at use time, don't cache. */
export function activeOrgWorkspacesSnapshot(): Workspace[] {
  return workspacesForOrg(
    useWorkspaceStore.getState().workspaces,
    useOrgStore.getState().activeOrganisationId,
  );
}
