import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { auth } from "@/features/auth/lib/auth-api";
import { useOrgStore } from "../stores/org-store";
import { switchOrg, deleteOrgAndData } from "../lib/org-switch";
import { filterOrgs, orgAccess } from "../lib/org-switcher-model";
import { isSyncedOrg, type Organisation } from "../types";
import { CreateOrgDialog } from "./create-org-dialog";
import { MembersModal } from "./members-modal";
import { ConfirmOrgDialogView } from "./views/confirm-org-dialog-view";
import { OrgMark } from "./views/org-mark";
import { OrgMenuPanelView, type OrgSyncState } from "./views/org-menu-panel-view";
import { OrgSwitcherView } from "./views/org-switcher-view";

/** The sidebar project picker's name for `OrgMark`. `plain` is the only look
 *  left; the prop is accepted so that call site needs no change. */
export function OrgAvatar({ org, size }: { org: Organisation; size?: number; plain?: boolean }) {
  return <OrgMark org={org} size={size} />;
}

/** The surround the sidebar project picker draws its menus on, the
 *  Organization submenu (which hosts `useOrgMenu().panel`) included. The title
 *  bar's menu is the package `DropdownMenuContent`.
 *
 *  No inset top highlight: on a card this size it draws a bright line across
 *  the whole head of the menu, which reads as a second border above the
 *  first. The surround is the foreground at 4% over the background — a shade
 *  over the inset card, not the card token, which read as a grey slab beside
 *  it. */
export const ORG_MENU_POPUP_CLASS =
  "flex max-h-[min(480px,70vh)] w-[268px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-[color-mix(in_srgb,var(--foreground)_4%,var(--background)_92%)] p-1.5 shadow-sm backdrop-blur-2xl atlas-panel-in-tl select-none text-secondary-foreground";

/**
 * The organisation menu — the top-level tenant picker — as a hook, so two
 * places can host it: the title bar's `org / project` breadcrumb, and the
 * Organization submenu at the foot of the sidebar's project picker.
 *
 * `panel(close)` is the menu's body (`OrgMenuPanelView`); it renders menu
 * items, so it goes inside a menu popup or submenu popup, and `close` shuts
 * whichever menu hosts it. `reset` clears the search and any inline rename
 * when that menu closes. `dialogs` are the create, members and delete
 * dialogs, which outlive the menu and so render beside it.
 */
export function useOrgMenu(): {
  active: Organisation | null;
  panel: (close: () => void) => ReactNode;
  reset: () => void;
  dialogs: ReactNode;
} {
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const { rename, enableSync } = useOrgStore.use.actions();
  const projects = useProjectStore.use.projects();
  const snapshot = useAuthStore.use.snapshot();
  const signedIn = snapshot.status === "signed-in";
  /** The server orgs THIS account belongs to. `null` = signed out OR never
   *  listed on this machine (offline). */
  const memberOrgIds = useMemo(
    () =>
      snapshot.status === "signed-in" && snapshot.orgs
        ? new Set(snapshot.orgs.map((o) => o.id))
        : null,
    [snapshot],
  );

  // True while a manual list-refresh is in flight (spins the refresh icon).
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  // True while "Turn on sync" is creating the org server-side (spins the row).
  const [syncing, setSyncing] = useState(false);
  // Create-organisation modal (name + globally-unique handle).
  const [createOpen, setCreateOpen] = useState(false);
  // Inline-rename state: the org id being renamed + its draft name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Org pending delete-confirmation (null = no dialog).
  const [confirmDelete, setConfirmDelete] = useState<Organisation | null>(null);
  // True while the delete round-trips (server delete for a synced org, then
  // the local purge). Blocks the dialog from closing mid-flight.
  const [deleting, setDeleting] = useState(false);
  // Members manager (server-backed, so synced orgs only).
  const [membersOpen, setMembersOpen] = useState(false);

  const active = organisations.find((o) => o.id === activeOrganisationId) ?? organisations[0];
  /** Members are a SERVER surface, so this needs both halves: an org that
   *  actually exists server-side, AND a live credential to talk to it with.
   *  Signing out does not un-sync an org — you stay in it, and every member
   *  call would 401 — so the credential has to be checked separately. */
  const activeIsSynced = !!active && isSyncedOrg(active);
  /** The id worth copying is the org's identity ON THE SERVER — the one the
   *  gateway, support and every other machine know it by, and the same value
   *  sent as the `atlas-org` header. A local org's `id` is meaningful only on
   *  this Mac, so there is nothing to hand anyone until it is synced. */
  const copyableOrgId = active && isSyncedOrg(active) ? active.remoteId : null;

  const submitRename = () => {
    if (!editingId) return;
    const name = editName.trim();
    if (!name) {
      setEditingId(null);
      return;
    }
    const org = organisations.find((o) => o.id === editingId);
    // No change → just close (rename would no-op anyway).
    if (org && org.name === name) {
      setEditingId(null);
      return;
    }
    if (!rename(editingId, name)) {
      toast.error(`An organization named “${name}” already exists`);
      return;
    }
    setEditingId(null);
  };

  const reset = () => {
    setEditingId(null);
    setQuery("");
  };

  const projectCount = confirmDelete
    ? projects.filter((w) => w.orgId === confirmDelete.id).length
    : 0;

  const dialogs = active ? (
    <>
      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
      <MembersModal org={active} open={membersOpen} onOpenChange={setMembersOpen} />
      <ConfirmOrgDialogView
        open={!!confirmDelete}
        busy={deleting}
        title={`Delete “${confirmDelete?.name ?? ""}”?`}
        description={
          <>
            This permanently removes the organization
            {projectCount > 0 && (
              <>
                {" "}
                and its{" "}
                <span className="text-foreground">
                  {projectCount} project{projectCount === 1 ? "" : "s"}
                </span>{" "}
                (plus their chats)
              </>
            )}{" "}
            from Atlas. Your actual project files on disk are not touched. This can’t be undone.
          </>
        }
        confirmLabel="Delete organization"
        busyLabel="Deleting…"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          setDeleting(true);
          try {
            await deleteOrgAndData(confirmDelete.id);
          } finally {
            setDeleting(false);
            setConfirmDelete(null);
          }
        }}
      />
    </>
  ) : null;

  const sync: OrgSyncState = syncing
    ? "syncing"
    : active && isSyncedOrg(active)
      ? "synced"
      : { state: "off", signedIn };

  const panel = (close: () => void): ReactNode =>
    active ? (
      <OrgMenuPanelView
        active={active}
        rows={filterOrgs(organisations, query).map((org) => ({
          org,
          isActive: org.id === active.id,
          access: orgAccess(org, { signedIn, memberOrgIds }),
        }))}
        query={query}
        onQueryChange={setQuery}
        canRefresh={signedIn}
        refreshing={refreshing}
        onRefresh={async () => {
          setRefreshing(true);
          try {
            await auth.refresh();
          } catch {
            // Left as-is on purpose; the pull failing is not an error worth a
            // toast on a background list.
          } finally {
            setRefreshing(false);
          }
        }}
        editingId={editingId}
        editName={editName}
        onEditNameChange={setEditName}
        onBeginRename={(org) => {
          setEditingId(org.id);
          setEditName(org.name);
        }}
        onSubmitRename={submitRename}
        onCancelRename={() => setEditingId(null)}
        canDelete={organisations.length > 1}
        onRequestDelete={(org) => {
          setConfirmDelete(org);
          close();
        }}
        onSelect={(org) => void switchOrg(org.id)}
        onCreate={() => {
          close();
          setCreateOpen(true);
        }}
        members={
          activeIsSynced && signedIn
            ? { enabled: true }
            : {
                enabled: false,
                reason: activeIsSynced
                  ? "Sign in to manage members"
                  : "Turn on sync to manage members",
              }
        }
        onManageMembers={() => {
          close();
          setMembersOpen(true);
        }}
        copyId={
          copyableOrgId
            ? { enabled: true, id: copyableOrgId }
            : { enabled: false, reason: "Turn on sync to give this organization an ID" }
        }
        onCopyId={async () => {
          if (!copyableOrgId) return;
          close();
          if (await copyText(copyableOrgId)) toast.success("Organization ID copied");
          else toast.error("Could not copy the organization ID");
        }}
        sync={sync}
        onEnableSync={() => {
          // Signed out, enableSync opens sign-in and returns instantly — no
          // spinner. Signed in, it round-trips, so show the syncing state
          // until it settles (success → "synced", failure → toast).
          if (!signedIn) {
            void enableSync(active.id);
            return;
          }
          setSyncing(true);
          void enableSync(active.id).finally(() => setSyncing(false));
        }}
      />
    ) : null;

  return { active: active ?? null, panel, reset, dialogs };
}

/**
 * The org half of the title bar's `org / project` breadcrumb. The same menu
 * is the Organization submenu at the foot of the sidebar's project picker.
 */
export function OrgSwitcher() {
  const { active, panel, reset, dialogs } = useOrgMenu();
  const [open, setOpen] = useState(false);
  if (!active) return null;
  return (
    <OrgSwitcherView
      name={active.name}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
      panel={panel(() => setOpen(false))}
      overlays={dialogs}
    />
  );
}
