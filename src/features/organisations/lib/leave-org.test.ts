import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Organisation } from "../types";

// `org-switch` reaches most of the app's stores at import time. Only what
// `leaveOrgAndData` touches when the left org is not the active one (so no
// `switchOrg` teardown runs) is given behaviour; the rest is inert.
const invoke = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {} }) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("@/features/log/stores/log-store", () => ({ useLogStore: { getState: () => ({}) } }));
vi.mock("@/features/projects/lib/flush-registry", () => ({ flushAll: async () => {} }));
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: { getState: () => ({ projects: [], actions: {} }) },
}));
vi.mock("@/features/projects/stores/project-git-store", () => ({
  resetGitSummariesForOrgSwitch: () => {},
}));
const beginSwitch = vi.fn();
const endSwitch = vi.fn();
vi.mock("@/features/comms/stores/comms-store", () => ({
  commsActions: () => ({ beginSwitch, endSwitch }),
}));
vi.mock("@/features/comms/lib/comms-api", () => ({ comms: { ready: async () => {} } }));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: { getState: () => ({}) },
}));
vi.mock("@/features/spaces/stores/spaces-store", () => ({
  useSpacesStore: { getState: () => ({}) },
}));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { getState: () => ({}) },
  flushAppStateSave: async () => {},
  scheduleAppStateSave: () => {},
}));
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ snapshot: { status: "signed-in" } }) },
}));
// A running agent, and the user's answer to "stop agents & switch?".
const agents = { busy: 0, stop: false };
vi.mock("@/features/projects/lib/stop-agents-confirm", () => ({
  busySessions: () => Array.from({ length: agents.busy }),
  cancelBusySessions: async () => {},
  useStopAgentsConfirmStore: {
    getState: () => ({ actions: { ask: async () => agents.stop } }),
  },
}));
const leaveOrg = vi.fn(async (_remoteId: string) => {});
vi.mock("@/features/auth/lib/auth-api", () => ({
  auth: { leaveOrg: (id: string) => leaveOrg(id) },
}));

// A plain stand-in for the org store: the leave path only reads the list and
// the active id and calls two actions.
const state = {
  organisations: [] as Organisation[],
  activeOrganisationId: "",
  actions: {
    deleteOrg: vi.fn((id: string) => {
      state.organisations = state.organisations.filter((o) => o.id !== id);
      return true;
    }),
    unlinkOrg: vi.fn((id: string) => {
      state.organisations = state.organisations.map((o) =>
        o.id === id ? { ...o, remoteId: undefined, syncEnabled: false } : o,
      );
    }),
  },
};
vi.mock("../stores/org-store", () => ({ useOrgStore: { getState: () => state } }));

const { leaveOrgAndData } = await import("./org-switch");

const org = (id: string, remoteId?: string): Organisation => ({
  id,
  name: id,
  slug: id,
  syncEnabled: !!remoteId,
  remoteId,
});

beforeEach(() => {
  vi.clearAllMocks();
  leaveOrg.mockImplementation(async () => {});
  agents.busy = 0;
  agents.stop = false;
});

describe("leaveOrgAndData", () => {
  it("leaves on the server by the REMOTE id, then drops a background org's tracking", async () => {
    state.organisations = [org("local-a", "org_a"), org("local-b", "org_b")];
    state.activeOrganisationId = "local-a";

    await expect(leaveOrgAndData("local-b")).resolves.toBe(true);

    expect(leaveOrg).toHaveBeenCalledWith("org_b");
    expect(state.actions.deleteOrg).toHaveBeenCalledWith("local-b");
    expect(state.organisations.map((o) => o.id)).toEqual(["local-a"]);
    // Nothing about the org on screen changed.
    expect(beginSwitch).not.toHaveBeenCalled();
  });

  it("keeps the only org as a local-only one and points chat and billing at nothing", async () => {
    state.organisations = [org("local-a", "org_a")];
    state.activeOrganisationId = "local-a";

    await leaveOrgAndData("local-a");

    expect(state.actions.deleteOrg).not.toHaveBeenCalled();
    expect(state.actions.unlinkOrg).toHaveBeenCalledWith("local-a");
    expect(state.organisations[0]).toMatchObject({ syncEnabled: false, remoteId: undefined });
    expect(beginSwitch).toHaveBeenCalledWith(null);
    expect(invoke).toHaveBeenCalledWith("comms_disconnect");
    expect(invoke).toHaveBeenCalledWith("auth_set_active_org", { orgId: null });
    expect(endSwitch).toHaveBeenCalled();
  });

  it("touches nothing locally when the server refuses", async () => {
    state.organisations = [org("local-a", "org_a"), org("local-b", "org_b")];
    state.activeOrganisationId = "local-a";
    leaveOrg.mockImplementation(async () => {
      throw "The organization's owner cannot leave it.";
    });

    await expect(leaveOrgAndData("local-b")).rejects.toBe(
      "The organization's owner cannot leave it.",
    );
    expect(state.actions.deleteOrg).not.toHaveBeenCalled();
    expect(state.actions.unlinkOrg).not.toHaveBeenCalled();
    expect(state.organisations).toHaveLength(2);
  });

  it("asks nothing of the server when the switch away from it is declined", async () => {
    // Leaving the org on screen switches first. "Go back" on the running-
    // agents prompt must leave the user a member, not stranded in an org
    // they have already left.
    state.organisations = [org("local-a", "org_a"), org("local-b", "org_b")];
    state.activeOrganisationId = "local-a";
    agents.busy = 1;

    await expect(leaveOrgAndData("local-a")).resolves.toBe(false);

    expect(leaveOrg).not.toHaveBeenCalled();
    expect(state.actions.deleteOrg).not.toHaveBeenCalled();
    expect(state.actions.unlinkOrg).not.toHaveBeenCalled();
  });

  it("refuses an org that was never synced without calling the server", async () => {
    state.organisations = [org("local-a"), org("local-b", "org_b")];
    await expect(leaveOrgAndData("local-a")).rejects.toMatch(/isn't synced/);
    expect(leaveOrg).not.toHaveBeenCalled();
  });
});
