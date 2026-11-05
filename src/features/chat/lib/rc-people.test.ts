// @vitest-environment happy-dom
//
// The room never names a user — every roster row and sender carries
// `name: null` — so the desktop labelled every remote prompt "Someone else".
// `useRcPeople` resolves the id: the signed-in account first, then the room's
// Organisation's roster, then whatever name the wire did carry.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import { renderHook } from "@testing-library/react";
import type { AccountUser, OrgMember } from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { useRcPeople } from "./rc-people";

const me = {
  id: "u-me",
  name: "Adib Mohsin",
  email: "adib@x.dev",
  avatarPath: null,
} as AccountUser;

function member(userId: string, name: string): OrgMember {
  return {
    id: `m-${userId}`,
    userId,
    name,
    email: `${userId}@x.dev`,
    role: null,
    createdAt: null,
    avatarPath: null,
    isOwner: false,
  } as OrgMember;
}

beforeEach(() => {
  useAuthStore.setState({
    snapshot: { status: "signed-in", user: me } as never,
  });
  useMembersStore.setState({
    byOrg: {
      "org-1": {
        members: [member("u-priya", "Priya Raghunathan")],
        invitations: [],
        loadedAt: Date.now(),
        loading: false,
        error: null,
      },
    },
  });
});

describe("useRcPeople", () => {
  it("names a prompt you sent from another surface as yours", () => {
    const { result } = renderHook(() => useRcPeople("org-1"));
    const person = result.current("u-me", null);
    expect(person.isYou).toBe(true);
    expect(person.label).toBe("Adib Mohsin");
  });

  it("names a teammate from the room's Organisation", () => {
    const { result } = renderHook(() => useRcPeople("org-1"));
    expect(result.current("u-priya", null).label).toBe("Priya Raghunathan");
  });

  it("falls back to the wire's name, then to Someone else", () => {
    const { result } = renderHook(() => useRcPeople("org-1"));
    expect(result.current("guest-1", "Visitor").label).toBe("Visitor");
    expect(result.current("guest-2", null).label).toBe("Someone else");
  });
});
