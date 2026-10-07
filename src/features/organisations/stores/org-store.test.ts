import { beforeEach, describe, expect, it, vi } from "vitest";

// The store pulls in Tauri IPC, sibling zustand stores and the app-state saver
// at import time; none of that is exercised by the merge logic under test.
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
const scheduleAppStateSave = vi.fn();
vi.mock("@/features/app/stores/app-store", () => ({
  scheduleAppStateSave: () => scheduleAppStateSave(),
}));
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: { getState: () => ({ projects: [], groups: [], actions: {} }) },
}));
vi.mock("@/features/projects/stores/recent-chats-store", () => ({
  useRecentChatsStore: { getState: () => ({ actions: {} }) },
}));
vi.mock("../lib/org-telemetry", () => ({ syncOrgTelemetry: () => {} }));
vi.mock("@/features/auth/lib/auth-api", () => ({ auth: {} }));
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ snapshot: { status: "signed-out" }, actions: {} }) },
}));

const { useOrgStore } = await import("./org-store");
type Org = import("../types").Organisation;

const linked = (over: Partial<Org> = {}): Org => ({
  id: "local-1",
  name: "Acme",
  slug: "acme",
  syncEnabled: true,
  remoteId: "srv-1",
  ...over,
});

const server = (name: string, id = "srv-1") => ({ id, name, role: "admin" as const });

beforeEach(() => {
  scheduleAppStateSave.mockClear();
  useOrgStore.setState({ organisations: [], activeOrganisationId: null });
});

describe("mergeServerOrgs — reconciling names of already-linked orgs", () => {
  it("takes a renamed server org's name onto the linked local row and persists", () => {
    useOrgStore.setState({ organisations: [linked()] });

    useOrgStore.getState().actions.mergeServerOrgs([server("Acme Corp")]);

    const [org] = useOrgStore.getState().organisations;
    expect(org.name).toBe("Acme Corp");
    // Identity + local-only fields survive: the rename is a patch, not a re-add.
    expect(org.id).toBe("local-1");
    expect(org.remoteId).toBe("srv-1");
    expect(org.slug).toBe("acme");
    expect(useOrgStore.getState().organisations).toHaveLength(1);
    expect(scheduleAppStateSave).toHaveBeenCalledTimes(1);
  });

  it("does not write or save when the server names already match", () => {
    const before = [linked()];
    useOrgStore.setState({ organisations: before });

    useOrgStore.getState().actions.mergeServerOrgs([server("Acme")]);

    expect(useOrgStore.getState().organisations).toBe(before);
    expect(scheduleAppStateSave).not.toHaveBeenCalled();
  });

  it("leaves local-only orgs alone and still adds unseen server orgs", () => {
    const local: Org = { id: "local-2", name: "Scratch", slug: "scratch", syncEnabled: false };
    useOrgStore.setState({ organisations: [linked(), local] });

    useOrgStore
      .getState()
      .actions.mergeServerOrgs([server("Acme Renamed"), server("Beta", "srv-2")]);

    const orgs = useOrgStore.getState().organisations;
    expect(orgs.map((o) => o.name)).toEqual(["Acme Renamed", "Scratch", "Beta"]);
    expect(orgs[2]).toMatchObject({ remoteId: "srv-2", syncEnabled: true, slug: "beta" });
  });

  it("keeps the active org pointer when the active org is renamed", () => {
    useOrgStore.setState({ organisations: [linked()], activeOrganisationId: "local-1" });

    useOrgStore.getState().actions.mergeServerOrgs([server("Acme Corp")]);

    expect(useOrgStore.getState().activeOrganisationId).toBe("local-1");
  });
});

describe("unlinkOrg — after leaving the only org", () => {
  it("drops the server link and sync, keeping the org and its identity", () => {
    useOrgStore.setState({ organisations: [linked()], activeOrganisationId: "local-1" });

    useOrgStore.getState().actions.unlinkOrg("local-1");

    const [org] = useOrgStore.getState().organisations;
    expect(org).toMatchObject({ id: "local-1", name: "Acme", syncEnabled: false });
    expect(org.remoteId).toBeUndefined();
    expect(useOrgStore.getState().activeOrganisationId).toBe("local-1");
    expect(scheduleAppStateSave).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an org that is already local", () => {
    const local: Org = { id: "local-2", name: "Scratch", slug: "scratch", syncEnabled: false };
    const before = [local];
    useOrgStore.setState({ organisations: before });

    useOrgStore.getState().actions.unlinkOrg("local-2");

    expect(useOrgStore.getState().organisations).toBe(before);
    expect(scheduleAppStateSave).not.toHaveBeenCalled();
  });
});
