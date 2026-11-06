import { beforeEach, describe, expect, it, vi } from "vitest";

// `closeProject` reaches most of the app's stores through `teardownHot` and
// the fallback switch. Only the org store, the app store's `setActiveProject`
// and `clearPanelStores` are observed; the rest is inert.
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {} }) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("../lib/flush-registry", () => ({ flushAll: async () => {} }));
const clearPanelStores = vi.fn();
vi.mock("../lib/project-snapshot", () => ({
  captureSnapshot: () => {},
  restoreSnapshot: () => {},
  evictSnapshot: () => {},
  clearPanelStores: () => clearPanelStores(),
}));
vi.mock("../lib/project-revalidate", () => ({ revalidateProject: () => {} }));
const setActiveProject = vi.fn();
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { getState: () => ({ actions: { setActiveProject } }) },
  scheduleAppStateSave: () => {},
  loadProjectStores: async () => {},
}));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: {
    getState: () => ({
      viewsByWs: {},
      actions: { commitProjectView: () => {}, removeProjectView: () => {} },
    }),
  },
}));
vi.mock("@/features/chat/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ actions: { removeSessions: () => {} } }) },
}));
vi.mock("@/features/terminal/stores/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ owners: {}, actions: { removeTabs: () => {} } }) },
}));
const org = { activeOrganisationId: "personal", organisations: [{ id: "personal" }] };
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: { getState: () => org },
}));
vi.mock("../lib/agent-activity", () => ({ isProjectRunning: () => false }));
vi.mock("../lib/stop-agents-confirm", () => ({
  busySessions: () => [],
  cancelBusySessions: async () => {},
  useStopAgentsConfirmStore: { getState: () => ({ actions: { ask: async () => true } }) },
}));
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({
  markFileIndexClosedFor: () => {},
}));
vi.mock("../lib/instruction-sync-api", () => ({
  instructionSync: { stop: async () => {} },
}));

const { useProjectStore } = await import("./project-store");
type Project = ReturnType<typeof useProjectStore.getState>["projects"][number];

const project = (id: string, orgId: string, lastActiveAt: string): Project => ({
  id,
  name: id,
  path: `/p/${id}`,
  orgId,
  lastActiveAt,
});

const switchTo = vi.fn(async (_id: string) => {});

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState((s) => ({
    activeProjectId: null,
    mountedProjectIds: [],
    projects: [],
    actions: { ...s.actions, switchTo },
  }));
});

describe("closeProject", () => {
  it("falls back to the most recent project in the same org", async () => {
    useProjectStore.setState({
      activeProjectId: "mlbb",
      projects: [
        project("mlbb", "personal", "2026-10-21T10:00:00Z"),
        project("old", "personal", "2026-10-01T10:00:00Z"),
        project("atlas", "team", "2026-10-20T10:00:00Z"),
      ],
    });

    await useProjectStore.getState().actions.closeProject("mlbb");

    expect(switchTo).toHaveBeenCalledWith("old");
  });

  // The bug: the fallback sorted every org's projects, so closing the last
  // project in Personal opened another org's project, invisible in
  // Personal's switcher and impossible to close from there.
  it("never opens another org's project when the org has none left", async () => {
    useProjectStore.setState({
      activeProjectId: "mlbb",
      projects: [
        project("mlbb", "personal", "2026-10-21T10:00:00Z"),
        project("atlas", "team", "2026-10-20T10:00:00Z"),
      ],
    });

    await useProjectStore.getState().actions.closeProject("mlbb");

    expect(switchTo).not.toHaveBeenCalled();
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(setActiveProject).toHaveBeenCalledWith(null);
    expect(clearPanelStores).toHaveBeenCalled();
    // The other org's project stays registered — it is only not opened.
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["atlas"]);
  });
});
