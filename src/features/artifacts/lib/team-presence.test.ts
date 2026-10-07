import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrgMember } from "@/features/auth/lib/auth-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

// Captures the one handler the listener registers, so a test can hand it the
// frames Rust would emit.
let handler: ((event: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_channel: string, fn: (event: { payload: unknown }) => void) => {
    handler = fn;
    return () => {};
  }),
}));

const { onlineIds, onlineTeammates, startTeamPresenceListener } = await import("./team-presence");
const { useTeamPresenceStore } = await import("../stores/team-presence-store");
const { onlineLabel } = await import("../components/online-teammates");

function member(userId: string, name: string): OrgMember {
  return {
    id: `mem_${userId}`,
    userId,
    name,
    email: `${userId}@acme.dev`,
    role: "developer",
    createdAt: null,
    avatarPath: null,
    isOwner: false,
  };
}

function directory(me: string | null, members: OrgMember[]): OrgDirectory {
  return { byId: new Map(members.map((m) => [m.userId, m])), currentUserId: me };
}

const frame = (payload: unknown) => handler?.({ payload });

beforeEach(() => {
  useTeamPresenceStore.getState().actions.reset();
});

describe("team presence store", () => {
  it("replaces a Project's roster whole, and keeps identity when nothing changed", () => {
    const { setProject } = useTeamPresenceStore.getState().actions;
    setProject("ws_1", ["u_ada", "u_grace"]);
    const first = useTeamPresenceStore.getState().byProject;
    setProject("ws_1", ["u_ada", "u_grace"]);
    expect(useTeamPresenceStore.getState().byProject).toBe(first);
    setProject("ws_1", ["u_ada"]);
    expect(useTeamPresenceStore.getState().byProject).toEqual({ ws_1: ["u_ada"] });
  });

  it("drops a Project whose roster went empty", () => {
    const { setProject } = useTeamPresenceStore.getState().actions;
    setProject("ws_1", ["u_ada"]);
    setProject("ws_1", []);
    expect(useTeamPresenceStore.getState().byProject).toEqual({});
  });
});

describe("startTeamPresenceListener", () => {
  it("folds presence frames in and forgets a revoked Project", async () => {
    const stop = startTeamPresenceListener();
    await Promise.resolve();
    frame({ kind: "presence", projectId: "ws_1", online: ["u_ada"] });
    frame({ kind: "presence", projectId: "ws_2", online: ["u_grace"] });
    // Frames the listener does not own pass straight through.
    frame({ kind: "commentUpsert", sessionId: "s", comment: {} });
    expect(useTeamPresenceStore.getState().byProject).toEqual({
      ws_1: ["u_ada"],
      ws_2: ["u_grace"],
    });
    frame({ kind: "revoked", projectId: "ws_1" });
    expect(useTeamPresenceStore.getState().byProject).toEqual({ ws_2: ["u_grace"] });
    stop();
  });
});

describe("onlineIds", () => {
  it("unions every Project's roster with team chat's online set", () => {
    const ids = onlineIds({ ws_1: ["u_ada", "u_grace"], ws_2: ["u_ada"] }, ["u_linus"]);
    expect([...ids].sort()).toEqual(["u_ada", "u_grace", "u_linus"]);
  });
});

describe("onlineTeammates", () => {
  const ada = member("u_ada", "Ada Lovelace");
  const grace = member("u_grace", "Grace Hopper");
  const me = member("u_me", "Me");

  it("never lists the viewer, skips ids the roster cannot name, sorts by name", () => {
    const dir = directory("u_me", [ada, grace, me]);
    const out = onlineTeammates(new Set(["u_grace", "u_me", "u_guest", "u_ada"]), dir);
    expect(out.map((m) => m.userId)).toEqual(["u_ada", "u_grace"]);
  });

  it("is empty when nobody else is here", () => {
    expect(onlineTeammates(new Set(["u_me"]), directory("u_me", [me]))).toEqual([]);
  });
});

describe("onlineLabel", () => {
  it("names up to three people and counts the rest", () => {
    const people = ["Ada", "Grace", "Linus", "Barbara", "Ken"].map((n) => member(`u_${n}`, n));
    expect(onlineLabel(people.slice(0, 1))).toBe("Ada is online");
    expect(onlineLabel(people.slice(0, 3))).toBe("Ada, Grace and Linus are online");
    expect(onlineLabel(people)).toBe("Ada, Grace and 3 others are online");
  });
});
