import { create } from "zustand";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import {
  auth,
  type OrgInvitation,
  type OrgMember,
  type Role,
} from "@/features/auth/lib/auth-api";

/** One org's cached roster. Keyed by the SERVER org id (`remoteId`). */
interface OrgRoster {
  members: OrgMember[];
  invitations: OrgInvitation[];
  /** Epoch ms of the last successful load — `null` means never loaded, which
   *  is what separates "empty org" from "not fetched yet". */
  loadedAt: number | null;
  /** A fetch is in flight. Purely an indicator: a revalidation NEVER blanks
   *  the cached rows, so the table stays readable while it runs. */
  loading: boolean;
  /** Last load failure, kept so a stale-but-present roster can still render
   *  with a quiet error rather than being replaced by one. */
  error: string | null;
}

const EMPTY: OrgRoster = {
  members: [],
  invitations: [],
  loadedAt: null,
  loading: false,
  error: null,
};

interface MembersState {
  byOrg: Record<string, OrgRoster>;
  actions: {
    /**
     * Stale-while-revalidate. Returns immediately; the cached roster (if any)
     * keeps rendering while the network runs, so reopening the modal is
     * instant and only the refresh indicator moves.
     *
     * `force` bypasses the freshness check (the explicit refresh button).
     */
    load: (orgId: string, opts?: { force?: boolean }) => Promise<void>;
    /** Optimistic role change; reverts + toasts if the server refuses. */
    setRole: (orgId: string, memberId: string, role: Role) => Promise<void>;
    /** Optimistic removal; reverts + toasts if the server refuses. */
    remove: (orgId: string, member: OrgMember) => Promise<void>;
    /** Invite, then fold the returned invitation (with its `acceptUrl`) in. */
    invite: (
      orgId: string,
      email: string,
      role: Role,
    ) => Promise<OrgInvitation | null>;
    /** Optimistic invite cancellation. */
    cancelInvite: (orgId: string, invitationId: string) => Promise<void>;
  };
}

/** How long a roster is considered fresh enough to skip a background refetch.
 *  Short, because the modal is opened deliberately and rarely — but non-zero so
 *  a double-open doesn't fire two round trips into the shared 100/60s budget. */
const FRESH_MS = 30_000;

/** Concurrency guard: in-flight org ids. A second `load` for the same org is a
 *  no-op rather than a second request racing the first. */
const inFlight = new Set<string>();

export const useMembersStore = createSelectors(
  create<MembersState>()((set, get) => {
    const roster = (orgId: string): OrgRoster => get().byOrg[orgId] ?? EMPTY;
    const patch = (orgId: string, next: Partial<OrgRoster>) =>
      set((s) => ({
        byOrg: {
          ...s.byOrg,
          [orgId]: { ...(s.byOrg[orgId] ?? EMPTY), ...next },
        },
      }));

    return {
      byOrg: {},
      actions: {
        load: async (orgId, opts) => {
          if (!orgId) return;
          const current = roster(orgId);
          const fresh =
            current.loadedAt !== null &&
            Date.now() - current.loadedAt < FRESH_MS;
          if (!opts?.force && (fresh || inFlight.has(orgId))) return;
          if (inFlight.has(orgId)) return;

          inFlight.add(orgId);
          patch(orgId, { loading: true });
          try {
            // Invitations are admin-scoped, so a non-admin's call rejects while
            // members still resolves. Settling both independently keeps the
            // members tab working for everyone instead of failing as one unit.
            const [membersRes, invitesRes] = await Promise.allSettled([
              auth.listMembers(orgId),
              auth.listInvitations(orgId),
            ]);

            if (membersRes.status === "rejected") {
              const e = membersRes.reason;
              patch(orgId, {
                loading: false,
                error: typeof e === "string" ? e : "Couldn't load members.",
              });
              return;
            }
            patch(orgId, {
              members: membersRes.value,
              invitations:
                invitesRes.status === "fulfilled" ? invitesRes.value : [],
              loadedAt: Date.now(),
              loading: false,
              error: null,
            });
          } finally {
            inFlight.delete(orgId);
          }
        },

        setRole: async (orgId, memberId, role) => {
          const before = roster(orgId).members;
          patch(orgId, {
            members: before.map((m) =>
              m.id === memberId ? { ...m, role } : m,
            ),
          });
          try {
            await auth.updateMemberRole(orgId, memberId, role);
          } catch (e) {
            patch(orgId, { members: before }); // put it back exactly as it was
            toast.error(
              typeof e === "string" ? e : "Couldn't change that role.",
            );
          }
        },

        remove: async (orgId, member) => {
          const before = roster(orgId).members;
          patch(orgId, { members: before.filter((m) => m.id !== member.id) });
          try {
            // Address by membership id; the server also accepts an email, but
            // the id is unambiguous when two accounts share an address.
            await auth.removeMember(orgId, member.id);
          } catch (e) {
            patch(orgId, { members: before });
            toast.error(
              typeof e === "string" ? e : "Couldn't remove that member.",
            );
          }
        },

        invite: async (orgId, email, role) => {
          try {
            const invitation = await auth.inviteMember(orgId, email, role);
            patch(orgId, {
              invitations: [invitation, ...roster(orgId).invitations],
            });
            return invitation;
          } catch (e) {
            toast.error(
              typeof e === "string" ? e : "Couldn't send that invite.",
            );
            return null;
          }
        },

        cancelInvite: async (orgId, invitationId) => {
          const before = roster(orgId).invitations;
          patch(orgId, {
            invitations: before.filter((i) => i.id !== invitationId),
          });
          try {
            await auth.cancelInvitation(invitationId);
          } catch (e) {
            patch(orgId, { invitations: before });
            toast.error(
              typeof e === "string" ? e : "Couldn't cancel that invite.",
            );
          }
        },
      },
    };
  }),
);

/** The cached roster for `orgId`, or an empty one. Never returns undefined so
 *  callers don't each re-implement the not-loaded-yet case. */
export function rosterFor(orgId: string | null | undefined): OrgRoster {
  if (!orgId) return EMPTY;
  return useMembersStore.getState().byOrg[orgId] ?? EMPTY;
}
