import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { scheduleAppStateSave } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useRecentChatsStore } from "@/features/workspaces/stores/recent-chats-store";
import type { Organisation } from "../types";
import { slugify } from "../types";
import { auth, type AccountOrg } from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { toast } from "sonner";

const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Whether `name` (case-insensitive, trimmed) is already used by an org other
 *  than `exceptId`. Enforces GitHub-style globally-unique org names. */
function nameTaken(
  name: string,
  orgs: Organisation[],
  exceptId?: string,
): boolean {
  const norm = name.trim().toLowerCase();
  return orgs.some(
    (o) => o.id !== exceptId && o.name.trim().toLowerCase() === norm,
  );
}

/**
 * Collapse local orgs that point at the SAME server org into one.
 *
 * Two rows for one `remoteId` is always a bug — the id is the sync key — but it
 * could be produced by a create racing the `atlas:auth-changed` merge, and once
 * written to `state.json` it survives restarts. So this repairs rather than
 * merely preventing.
 *
 * The survivor is the active org if one of the duplicates is active (switching
 * away from under the user would be worse than the duplicate), else the first.
 * Workspaces and groups tagged with a dropped org are re-tagged to the survivor
 * — dropping the org without that would strand every project inside it.
 */
function collapseDuplicateRemotes(
  set: (fn: (s: OrgState) => Partial<OrgState>) => void,
  get: () => OrgState,
): void {
  const { organisations, activeOrganisationId } = get();
  const byRemote = new Map<string, Organisation[]>();
  for (const org of organisations) {
    if (!org.remoteId) continue;
    const group = byRemote.get(org.remoteId);
    if (group) group.push(org);
    else byRemote.set(org.remoteId, [org]);
  }

  /** droppedLocalId → survivingLocalId */
  const remap = new Map<string, string>();
  for (const group of byRemote.values()) {
    if (group.length < 2) continue;
    const keep = group.find((o) => o.id === activeOrganisationId) ?? group[0];
    for (const dup of group) {
      if (dup.id !== keep.id) remap.set(dup.id, keep.id);
    }
  }
  if (remap.size === 0) return;

  // Re-tag before dropping, so nothing is briefly owned by a missing org.
  useWorkspaceStore.setState((s) => ({
    workspaces: s.workspaces.map((w) =>
      w.orgId && remap.has(w.orgId) ? { ...w, orgId: remap.get(w.orgId) } : w,
    ),
    groups: s.groups.map((g) =>
      g.orgId && remap.has(g.orgId) ? { ...g, orgId: remap.get(g.orgId) } : g,
    ),
  }));

  set((s) => ({
    organisations: s.organisations.filter((o) => !remap.has(o.id)),
    activeOrganisationId:
      s.activeOrganisationId && remap.has(s.activeOrganisationId)
        ? (remap.get(s.activeOrganisationId) ?? s.activeOrganisationId)
        : s.activeOrganisationId,
  }));
  scheduleAppStateSave();
}

/** Make `slug` unique within the current local org set (append -2, -3, …).
 *  The server enforces global slug uniqueness; the auth branch reconciles on
 *  link. This only prevents local collisions. */
function uniqueSlug(base: string, orgs: Organisation[]): string {
  const taken = new Set(orgs.map((o) => o.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface OrgState {
  /** All organisations known to this window. */
  organisations: Organisation[];
  /** The single active org (mirrors the one-active-workspace invariant). */
  activeOrganisationId: string | null;
  /** True while an org switch is tearing down + reloading; gates the full-app
   *  "Loading Organisation…" overlay. Driven by `lib/org-switch.ts`. */
  orgSwitching: boolean;
  actions: {
    /** One-shot hydration from Rust `AppState` on boot. */
    hydrate: (payload: {
      organisations: Organisation[];
      activeOrganisationId: string | null;
    }) => void;
    /** Create a new local org (unsynced) with an explicit handle. Returns its
     *  id, or `null` if the name or slug is already used locally. Does NOT
     *  switch. */
    createOrg: (name: string, slug: string) => string | null;
    /**
     * Create an org. When `cloud` (and signed in) it goes **server-first**, so
     * the globally-unique slug is settled BEFORE anything is committed locally
     * — a duplicate handle must not leave a half-created org behind.
     *
     * `cloud: false` creates a private, offline org: no server call, no
     * `remoteId`, `syncEnabled: false`. It is a first-class choice, not a
     * fallback — "Turn on sync" (`enableSync`) links it later, which is the
     * same path a signed-out user's orgs take once they sign in.
     *
     * Rejects with the user-facing string from Rust on server failure — the
     * caller toasts it. Resolves to the new LOCAL org id.
     */
    createOrgSynced: (
      name: string,
      slug: string,
      cloud: boolean,
    ) => Promise<string>;
    /** Rename an org. Returns `false` (no-op) if the name is blank or already
     *  taken by ANOTHER org (case-insensitive), so no two orgs collide. */
    rename: (id: string, name: string) => boolean;
    setColor: (id: string, color: string | null) => void;
    /** Remove an org. Refuses if it's the last org or still owns workspaces
     *  (the caller must reassign/close those first). Returns whether removed. */
    deleteOrg: (id: string) => boolean;
    /** Record the per-org last-active workspace (restore target on switch). */
    setActiveWorkspaceForOrg: (
      orgId: string,
      workspaceId: string | null,
    ) => void;
    /** Low-level setter used by the org-switch orchestration + overlay gate. */
    setSwitching: (v: boolean) => void;
    /** Set the active org id (authoritative swap; called by org-switch). */
    setActiveOrganisation: (id: string) => void;

    // --- Server sync (ATL-36) ---------------------------------------------
    /** Add-only merge of the server's org list into the local one: link/add
     *  every server org not already linked locally, keeping local-only orgs.
     *  Fired on every signed-in snapshot whose `orgs` is known (not `null`). */
    mergeServerOrgs: (serverOrgs: AccountOrg[]) => void;
    /** Opt into cloud sync for an org ("Turn on sync"): create it server-side
     *  and write the returned id onto the local org as `remoteId`. Signed out,
     *  it starts sign-in instead. */
    enableSync: (id: string) => Promise<void>;
    /** Invite a member. Stub until auth ships. */
    inviteMember: (orgId: string, email: string, role: string) => void;
  };
}

export const useOrgStore = createSelectors(
  create<OrgState>()((set, get) => ({
    organisations: [],
    activeOrganisationId: null,
    orgSwitching: false,
    actions: {
      hydrate: (payload) => {
        set({
          organisations: payload.organisations ?? [],
          activeOrganisationId: payload.activeOrganisationId ?? null,
        });
      },

      createOrg: (name, slug) => {
        const trimmed = name.trim() || "New organisation";
        const handle = slugify(slug || trimmed);
        // GitHub-style: names are globally unique (case-insensitive). The slug
        // is what the SERVER enforces globally; locally we only stop obvious
        // self-collisions.
        if (nameTaken(trimmed, get().organisations)) return null;
        if (get().organisations.some((o) => o.slug === handle)) return null;
        const org: Organisation = {
          id: uuid(),
          name: trimmed,
          slug: handle,
          createdAt: new Date().toISOString(),
          syncEnabled: false,
        };
        set((s) => ({ organisations: [...s.organisations, org] }));
        scheduleAppStateSave();
        logEvent({
          source: "project",
          kind: "org-create",
          summary: org.name,
          payload: { orgId: org.id, slug: org.slug },
        });
        return org.id;
      },

      createOrgSynced: async (name, slug, cloud) => {
        const trimmed = name.trim();
        const handle = slugify(slug || trimmed);
        if (!trimmed) throw "Enter a name for the organisation.";
        if (!handle) throw "Enter a handle for the organisation.";
        if (nameTaken(trimmed, get().organisations)) {
          throw `An organisation named “${trimmed}” already exists.`;
        }
        if (get().organisations.some((o) => o.slug === handle)) {
          throw `The handle “${handle}” is already used by another organisation.`;
        }

        // Server FIRST for a cloud org: the unique index on `organization.slug`
        // is the real guard (the pre-check is advisory and can lose a race), so
        // letting it reject before we touch local state is what keeps a failed
        // create from leaving a stray unsynced org behind.
        //
        // A local org never calls out at all — that is the point of it — so its
        // handle is only checked against the other local orgs above.
        let remoteId: string | null = null;
        if (cloud && useAuthStore.getState().snapshot.status === "signed-in") {
          const created = await auth.createOrg(trimmed, handle);
          remoteId = created.id;
        }

        // `auth.createOrg` broadcasts a refreshed snapshot on its way back, so
        // `mergeServerOrgs` can have ALREADY added this org while we were
        // awaiting — nothing local carried its `remoteId` yet, and the
        // adopt-by-name path needs an existing unlinked org, which there wasn't.
        // Appending blindly is what produced two identical rows. Adopt instead.
        const raced = remoteId
          ? get().organisations.find((o) => o.remoteId === remoteId)
          : undefined;
        if (raced) {
          set((s) => ({
            organisations: s.organisations.map((o) =>
              o.id === raced.id
                ? { ...o, name: trimmed, slug: handle, syncEnabled: true }
                : o,
            ),
          }));
          scheduleAppStateSave();
          return raced.id;
        }

        const org: Organisation = {
          id: uuid(),
          name: trimmed,
          slug: handle,
          createdAt: new Date().toISOString(),
          syncEnabled: !!remoteId,
          ...(remoteId ? { remoteId } : {}),
        };
        set((s) => ({ organisations: [...s.organisations, org] }));
        scheduleAppStateSave();
        logEvent({
          source: "project",
          kind: "org-create",
          summary: org.name,
          payload: { orgId: org.id, slug: org.slug, remoteId },
        });
        return org.id;
      },

      rename: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        // Reject if ANOTHER org already has this name (case-insensitive).
        if (nameTaken(trimmed, get().organisations, id)) return false;
        set((s) => ({
          organisations: s.organisations.map((o) =>
            o.id === id ? { ...o, name: trimmed } : o,
          ),
        }));
        scheduleAppStateSave();
        return true;
      },

      setColor: (id, color) => {
        set((s) => ({
          organisations: s.organisations.map((o) =>
            o.id === id ? { ...o, color: color ?? undefined } : o,
          ),
        }));
        scheduleAppStateSave();
      },

      deleteOrg: (id) => {
        const { organisations } = get();
        if (organisations.length <= 1) return false; // never delete the last org
        // Cascade: wipe all app-state scoped to this org — its workspace/group
        // references, and the recent chats for those projects. (The user's
        // actual project files + `.atlas/` data on disk are NOT touched; only
        // Atlas's org-scoped tracking is removed.) The caller (deleteOrgAndData)
        // must have already switched away if this is the active org.
        const ws = useWorkspaceStore.getState();
        const orgPaths = new Set(
          ws.workspaces.filter((w) => w.orgId === id).map((w) => w.path),
        );
        ws.actions.removeWorkspacesForOrg(id);
        const rc = useRecentChatsStore.getState();
        for (const c of rc.items) {
          if (orgPaths.has(c.projectPath)) rc.actions.remove(c.tabId);
        }
        set((s) => ({
          organisations: s.organisations.filter((o) => o.id !== id),
        }));
        scheduleAppStateSave();
        return true;
      },

      setActiveWorkspaceForOrg: (orgId, workspaceId) => {
        set((s) => ({
          organisations: s.organisations.map((o) =>
            o.id === orgId
              ? { ...o, activeWorkspaceId: workspaceId ?? undefined }
              : o,
          ),
        }));
        // Persisted via the switch's flushAppStateSave / scheduleAppStateSave.
      },

      setSwitching: (v) => set({ orgSwitching: v }),

      setActiveOrganisation: (id) => set({ activeOrganisationId: id }),

      mergeServerOrgs: (serverOrgs) => {
        // Repair first: earlier builds could append a local org for a server id
        // that a racing merge had already added, leaving two identical rows in
        // the switcher. Collapsing here (rather than only preventing new ones)
        // is what cleans up state already on disk.
        collapseDuplicateRemotes(set, get);

        const linked = new Set(
          get()
            .organisations.map((o) => o.remoteId)
            .filter((x): x is string => !!x),
        );
        // Build the next list immutably; `next` grows as we go so slug/name
        // disambiguation accounts for orgs added earlier in the same pass.
        let next = get().organisations;
        let changed = false;

        for (const s of serverOrgs) {
          if (linked.has(s.id)) continue; // add-only: already linked, leave it

          // Adopt a same-named, still-local org rather than duplicating it —
          // covers an org created offline that later arrives from the server.
          const adoptIdx = next.findIndex(
            (o) =>
              !o.remoteId &&
              o.name.trim().toLowerCase() === s.name.trim().toLowerCase(),
          );
          if (adoptIdx !== -1) {
            next = next.map((o, i) =>
              i === adoptIdx ? { ...o, remoteId: s.id, syncEnabled: true } : o,
            );
            linked.add(s.id);
            changed = true;
            continue;
          }

          next = [
            ...next,
            {
              id: uuid(),
              name: s.name,
              slug: uniqueSlug(slugify(s.name), next),
              createdAt: new Date().toISOString(),
              syncEnabled: true,
              remoteId: s.id,
            },
          ];
          linked.add(s.id);
          changed = true;
        }

        if (!changed) return;
        set({ organisations: next });
        scheduleAppStateSave();
      },

      enableSync: async (id) => {
        const org = get().organisations.find((o) => o.id === id);
        if (!org) return;
        if (org.remoteId && org.syncEnabled) return; // already linked

        // No credential → send them through sign-in; syncing needs one, and the
        // sign-in that follows re-merges the server list anyway.
        if (useAuthStore.getState().snapshot.status !== "signed-in") {
          void useAuthStore.getState().actions.beginSignIn();
          return;
        }

        try {
          const { id: remoteId } = await auth.createOrg(org.name, org.slug);
          // Set `remoteId` from the command's own result, before the follow-up
          // `atlas:auth-changed` broadcast lands — that is what stops
          // `mergeServerOrgs` from re-adding this org (it matches on remoteId).
          set((s) => ({
            organisations: s.organisations.map((o) =>
              o.id === id ? { ...o, remoteId, syncEnabled: true } : o,
            ),
          }));
          scheduleAppStateSave();
          logEvent({
            source: "project",
            kind: "org-enable-sync",
            summary: org.name,
            payload: { orgId: id, remoteId },
          });
        } catch (e) {
          toast.error(
            typeof e === "string" ? e : "Couldn't sync organisation.",
          );
        }
      },

      inviteMember: (orgId, email, role) => {
        logEvent({
          source: "project",
          kind: "org-invite-member",
          summary: "Invite requested (auth pending)",
          payload: { orgId, email, role, deferred: "auth-branch" },
        });
      },
    },
  })),
);

/** Convenience: the active `Organisation` record (or null). */
export function activeOrganisation(): Organisation | null {
  const { organisations, activeOrganisationId } = useOrgStore.getState();
  return organisations.find((o) => o.id === activeOrganisationId) ?? null;
}
