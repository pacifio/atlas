// The fake project every scenario opens: one org, a few projects, and the
// helpers that turn a relative path into the absolute one Rust would see.
//
// The tree itself lives in `fixtures/files.ts` (with the files' real content),
// so `read_directories` and `read_file_content` can never disagree about which
// files exist.

import type { AppStateWire } from "@/features/app/stores/app-store";
import type { Project } from "@/features/projects/stores/project-store";

export const MOCK_ORG_ID = "org-mock";

export const MOCK_PROJECT = {
  id: "ws-mock",
  name: "acme-app",
  path: "/Users/dev/acme-app",
  orgId: MOCK_ORG_ID,
} satisfies Project;

/**
 * Two more projects, for the surfaces that list or aggregate every project:
 * the switcher, the sidebar's per-project git summaries, and Mission
 * Control's project table. One carries a deliberately over-long name so
 * truncation is visible without hunting for a repro.
 */
export const OTHER_PROJECTS = [
  {
    id: "ws-mock-2",
    name: "acme-platform-migration-experiments",
    path: "/Users/dev/acme-platform-migration-experiments",
    orgId: MOCK_ORG_ID,
  },
  {
    id: "ws-mock-3",
    name: "docs",
    path: "/Users/dev/docs",
    orgId: MOCK_ORG_ID,
  },
] satisfies Project[];

export const ALL_PROJECTS: Project[] = [MOCK_PROJECT, ...OTHER_PROJECTS];

/** `path` relative to the project root. */
export const abs = (path: string) => `${MOCK_PROJECT.path}/${path}`;

export function appState(overrides: Partial<AppStateWire> = {}): AppStateWire {
  return {
    currentProject: null,
    recentProjects: [],
    workspaces: ALL_PROJECTS,
    activeWorkspaceId: MOCK_PROJECT.id,
    // Sync is ON, and the org carries a `remoteId`: `CommsPanel` renders
    // "not connected" for a local-only org, so a local org would hide the
    // whole team-chat surface behind a placeholder no fixture can fill.
    organisations: [
      {
        id: MOCK_ORG_ID,
        name: "Acme",
        slug: "acme",
        syncEnabled: true,
        remoteId: MOCK_ORG_ID,
      },
    ],
    activeOrganisationId: MOCK_ORG_ID,
    configStatus: { status: "ok" },
    configGeneration: 1,
    version: 3,
    ...overrides,
  };
}
