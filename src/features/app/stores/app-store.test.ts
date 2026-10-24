import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reaches Tauri IPC, the flush registry and four sibling zustand
// stores at import time. None of that is exercised by the write guard under
// test, so it is all stubbed down to the one call we assert on: `invoke`.
const invoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("@/features/projects/lib/flush-registry", () => ({ registerFlush: () => {} }));
vi.mock("@/features/projects/lib/project-snapshot", () => ({ persistHashOf: () => "" }));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: { getState: () => ({ actions: {} }) },
}));
// The project and org stores are plain objects so `hydrate` can be driven:
// the boot-restore test reads what the org store was handed and watches
// which project the project store is told to switch to.
const switchTo = vi.fn(async (_id: string) => {});
const projectState = { projects: [], groups: [], activeProjectId: null, actions: { switchTo } };
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      ...projectState,
      actions: { ...projectState.actions, hydrate: () => {} },
    }),
  },
}));
const orgState = {
  organisations: [] as unknown[],
  activeOrganisationId: null as string | null,
  actions: {
    hydrate: (p: { organisations: unknown[]; activeOrganisationId: string | null }) => {
      orgState.organisations = p.organisations;
      orgState.activeOrganisationId = p.activeOrganisationId;
    },
  },
};
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: { getState: () => orgState },
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: {}, actions: { hydrate: () => {} } }) },
}));

const { flushAppStateSave, setAppStateWritable, useAppStore } = await import("./app-store");
type AppStateWire = Parameters<ReturnType<typeof useAppStore.getState>["actions"]["hydrate"]>[0];

beforeEach(() => {
  invoke.mockClear();
  switchTo.mockClear();
  setAppStateWritable(true);
});

/** The saved active project is restored only when it belongs to the saved
 *  active org. Closing an org's last project used to fall back to ANOTHER
 *  org's project and persist that pairing, so every launch reopened a
 *  project the current org's switcher did not show. */
describe("restoring the active project at boot", () => {
  const boot = (activeWorkspaceId: string) =>
    useAppStore.getState().actions.hydrate({
      organisations: [],
      activeOrganisationId: "personal",
      workspaces: [
        { id: "mlbb", name: "mlbb", path: "/p/mlbb", groupId: null, orgId: "personal" },
        { id: "atlas", name: "atlas", path: "/p/atlas", groupId: null, orgId: "team" },
      ],
      activeWorkspaceId,
    } as unknown as AppStateWire);

  it("reopens the saved project when it is in the active org", () => {
    boot("mlbb");

    expect(switchTo).toHaveBeenCalledWith("mlbb");
  });

  it("does not reopen another org's project", () => {
    boot("atlas");

    expect(switchTo).not.toHaveBeenCalled();
  });
});

/** The guard exists for one reason: `AppState::apply_patch` REPLACES
 *  `workspaces`/`groups`/`organisations` instead of merging them. So a session
 *  whose `bootstrap_app_state` never delivered holds empty stores, and the
 *  quit flush — which runs unconditionally — would persist that emptiness over
 *  the user's real project and org list. Losing their whole workspace to one
 *  failed IPC is the bug; refusing the write is the fix. */
describe("app-state writes after a failed bootstrap", () => {
  /** Default-deny. Suspending only on the "it failed" branch would still let
   *  the cases that never settle — a hung IPC, a deadlocked lock, a cancelled
   *  boot — write empty state, because that branch never runs to suspend them.
   *  A fresh module must therefore start closed, before any boot path speaks. */
  it("starts suspended, before the boot path has hydrated anything", async () => {
    vi.resetModules();
    const fresh = await import("./app-store");

    await fresh.flushAppStateSave();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("persists normally when the boot snapshot arrived", async () => {
    await flushAppStateSave();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe("save_app_state");
  });

  it("does not write the empty state back when no boot snapshot arrived", async () => {
    setAppStateWritable(false);

    await flushAppStateSave();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("stays suspended across repeated flushes, including the one on quit", async () => {
    setAppStateWritable(false);

    await flushAppStateSave();
    await flushAppStateSave();
    await flushAppStateSave();

    expect(invoke).not.toHaveBeenCalled();
  });
});
