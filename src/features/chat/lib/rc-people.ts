// Faces and names for the people in a remote-control room.
//
// The room never names a user — its roster and every command's sender carry
// an id and `name: null` (only a guest has a name) — so a desktop that showed
// what the wire said labelled every prompt "Someone else". The web viewer
// resolves ids against the Organisation's member list, and so does this: the
// signed-in account first (a prompt you sent from your phone is yours), then
// the room's Organisation's roster, then whatever name the wire did carry.

import { useEffect, useMemo } from "react";

import type { AccountUser } from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

export interface RcPerson {
  /** Ready for `AccountAvatar` — a photo when the roster has one, else an
   *  initial on the id's colour. */
  user: AccountUser;
  /** What to call them: their name, or "Someone else" when nobody knows. */
  label: string;
  /** The signed-in account. */
  isYou: boolean;
}

export type RcPeopleResolver = (id: string, wireName?: string | null) => RcPerson;

/**
 * A resolver over the given server Organisation's roster (the room's scope),
 * falling back to the active Organisation's when the room is solo or gone.
 * The roster load is shared and cached by `members-store`, so ten callers are
 * one request.
 */
export function useRcPeople(scopeOrgId: string | null): RcPeopleResolver {
  const snapshot = useAuthStore.use.snapshot();
  const me = snapshot.status === "signed-in" ? (snapshot.user ?? null) : null;
  const activeRemoteId = useOrgStore(
    (s) => s.organisations.find((o) => o.id === s.activeOrganisationId)?.remoteId ?? null,
  );
  const orgId = scopeOrgId ?? activeRemoteId;
  const members = useMembersStore((s) => (orgId ? s.byOrg[orgId]?.members : undefined));
  const { load } = useMembersStore.use.actions();
  useEffect(() => {
    if (orgId) void load(orgId);
  }, [orgId, load]);

  return useMemo(() => {
    const byId = new Map((members ?? []).map((m) => [m.userId, m]));
    return (id: string, wireName?: string | null): RcPerson => {
      if (me && id === me.id) return { user: me, label: me.name || "You", isYou: true };
      const member = byId.get(id);
      if (member) {
        return {
          user: {
            id: member.userId,
            name: member.name,
            email: member.email,
            avatarPath: member.avatarPath,
          } as AccountUser,
          label: member.name || member.email,
          isYou: false,
        };
      }
      const name = wireName?.trim() || "";
      return {
        user: { id, name, email: "", avatarPath: null } as AccountUser,
        label: name || "Someone else",
        isYou: false,
      };
    };
  }, [members, me]);
}
