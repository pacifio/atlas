import { beforeEach, describe, expect, it } from "vitest";
import { drivenElsewhere, driverLabel, type RcRoom } from "../lib/rc-api";
import { useRcStore } from "./rc-store";

function room(sessionId: string, patch: Partial<RcRoom> = {}): RcRoom {
  return {
    sessionId,
    roomId: `room-${sessionId}`,
    scope: null,
    viewerUrl: `https://app.example.invalid/rc/rooms/room-${sessionId}`,
    state: "live",
    ownerOnline: true,
    viewers: 0,
    driver: { id: "user_owner", name: null, isOwner: true, lost: false },
    pending: [],
    memberTier: "view",
    lastError: null,
    endReason: null,
    ...patch,
  };
}

const ada = { id: "user_member", name: "Ada", isOwner: false, lost: false };

describe("rc-store", () => {
  beforeEach(() => useRcStore.setState({ bySession: {} }));

  it("replaces a room whole, and keeps the same object for an unchanged one", () => {
    const { upsert } = useRcStore.getState().actions;
    upsert(room("s1"));
    const first = useRcStore.getState().bySession;
    upsert(room("s1"));
    expect(useRcStore.getState().bySession).toBe(first);
    upsert(room("s1", { viewers: 2 }));
    expect(useRcStore.getState().bySession.s1.viewers).toBe(2);
  });

  it("a seat change, a request and a scope each count as a change", () => {
    const { upsert } = useRcStore.getState().actions;
    upsert(room("s1"));
    const before = useRcStore.getState().bySession;
    upsert(room("s1", { driver: ada }));
    const withDriver = useRcStore.getState().bySession;
    expect(withDriver).not.toBe(before);
    upsert(room("s1", { driver: { ...ada } }));
    expect(useRcStore.getState().bySession).toBe(withDriver);
    upsert(
      room("s1", {
        driver: ada,
        pending: [{ requestId: "r1", fromId: "u2", fromName: null, requestedAt: 1, expiresAt: 2 }],
      }),
    );
    const withRequest = useRcStore.getState().bySession;
    expect(withRequest).not.toBe(withDriver);
    upsert(room("s1", { driver: ada, pending: [], scope: { orgId: "org_1", workspaceId: null } }));
    expect(useRcStore.getState().bySession).not.toBe(withRequest);
  });

  it("a seed drops rooms Rust no longer has, but keeps an ended one so its reason shows", () => {
    const { upsert, seed } = useRcStore.getState().actions;
    upsert(room("gone"));
    upsert(room("ended", { state: "ended", endReason: "closed_by_admin" }));
    seed([room("live")]);
    const rooms = useRcStore.getState().bySession;
    expect(Object.keys(rooms).sort()).toEqual(["ended", "live"]);
    expect(rooms.ended.endReason).toBe("closed_by_admin");
  });

  it("a seed never regresses a room the listener already advanced", () => {
    const { upsert, seed } = useRcStore.getState().actions;
    // The listener is installed before `rc_status` is asked, so an event that
    // lands during the round-trip is fresher than the answer.
    upsert(room("s1", { state: "live" }));
    seed([room("s1", { state: "connecting" }), room("s2", { state: "connecting" })]);
    const rooms = useRcStore.getState().bySession;
    expect(rooms.s1.state).toBe("live");
    expect(rooms.s2.state).toBe("connecting");
  });

  it("forgets a dismissed room", () => {
    const { upsert, forget } = useRcStore.getState().actions;
    upsert(room("s1", { state: "ended" }));
    forget("s1");
    expect(useRcStore.getState().bySession).toEqual({});
  });
});

describe("drivenElsewhere", () => {
  it("is the driver only while someone other than the owner holds an open room's seat", () => {
    expect(drivenElsewhere(undefined)).toBeNull();
    expect(drivenElsewhere(room("s", { driver: null }))).toBeNull();
    expect(drivenElsewhere(room("s"))).toBeNull();
    expect(drivenElsewhere(room("s", { driver: ada }))).toEqual(ada);
    // A driver the desktop cannot hear is not driving: the composer is free
    // while the room is offline or still connecting (Rust draws the same line).
    expect(drivenElsewhere(room("s", { driver: ada, state: "offline" }))).toBeNull();
    expect(drivenElsewhere(room("s", { driver: ada, state: "connecting" }))).toBeNull();
    expect(drivenElsewhere(room("s", { driver: ada, state: "ended" }))).toBeNull();
  });

  it("names the driver, or falls back when the room gave no name", () => {
    expect(driverLabel(ada)).toBe("Ada");
    expect(driverLabel({ ...ada, name: "  " })).toBe("Someone else");
    expect(
      driverLabel({ requestId: "r", fromId: "u", fromName: "Bo", requestedAt: 0, expiresAt: 1 }),
    ).toBe("Bo");
  });
});
