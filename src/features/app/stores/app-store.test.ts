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
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({ projects: [], activeProjectId: null, actions: {} }),
  },
}));
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: { getState: () => ({ organisations: [], activeOrganisationId: null }) },
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ actions: { hydrate: () => {} } }) },
}));

const { flushAppStateSave, setAppStateWritable } = await import("./app-store");

beforeEach(() => {
  invoke.mockClear();
  setAppStateWritable(true);
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
