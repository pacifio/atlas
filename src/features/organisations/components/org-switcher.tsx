import { useMemo, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  ChevronDown,
  Plus,
  Cloud,
  Lock,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
  Users,
  Search,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { auth } from "@/features/auth/lib/auth-api";
import { useOrgStore } from "../stores/org-store";
import { switchOrg, deleteOrgAndData } from "../lib/org-switch";
import { AddProjectMenu } from "@/features/projects/components/add-project-menu";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { CreateOrgDialog } from "./create-org-dialog";
import { MembersModal } from "./members-modal";
import { isSyncedOrg, type Organisation } from "../types";

/** Two-letter avatar seed from an org name. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function OrgAvatar({
  org,
  size = 20,
  plain,
}: {
  org: Organisation;
  size?: number;
  /** Flat tinted square instead of the keycap. The keycap is a raised control
   *  — right for the ONE avatar that labels the rail, wrong repeated down a
   *  menu, where a dozen raised chips fight the row highlight for depth. */
  plain?: boolean;
}) {
  // A custom logo keeps its own square; the initials wear the hint-nav keycap
  // (`hint-overlay.tsx`) — a dark frosted pill with a hairline border, a top
  // highlight and a bottom shade.
  //
  // No `backdropFilter` here, unlike the overlay's: this sits on the rail's own
  // gradient, and a blur layer per avatar in a menu of them buys nothing.
  if (org.logo) {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-md"
        style={{ width: size, height: size }}
      >
        <img src={org.logo} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  if (plain) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-md font-semibold text-[var(--foreground)]"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, Math.round(size * 0.42)),
          background: org.color ?? "var(--atlas-element-hover)",
        }}
      >
        {initials(org.name)}
      </span>
    );
  }
  return (
    <span
      // `minWidth` + inline padding rather than a fixed square: two uppercase
      // glyphs at a legible size do not fit inside `size` with any breathing
      // room, and the previous fixed square + `tracking-wide` had them touching
      // both edges. A keycap is allowed to be wider than it is tall.
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-border px-[3px]",
        "inset-highlight font-sans font-semibold uppercase leading-none shadow-sm",
        // ratchet-allow: white reads on a saturated org colour and nowhere
        // else; the untinted keycap is a surface and takes the surface's own
        // foreground. The gradient used to be a fixed near-black, which on a
        // light theme put a black key in a cream sidebar.
        org.color ? "text-white" : "text-card-foreground",
      )}
      style={{
        minWidth: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.44)),
        // An org colour, when set, tints the keycap rather than replacing it —
        // the depth survives either way.
        background: org.color
          ? `linear-gradient(180deg, ${org.color} 0%, var(--atlas-element-active) 165%)`
          : "linear-gradient(180deg, var(--popover) 0%, var(--card) 100%)",
      }}
    >
      {initials(org.name)}
    </span>
  );
}

/**
 * Organisation switcher — the top-level tenant picker (Linear-style).
 *
 * Scoped to organisations only. Identity, Settings and sign-out live in the
 * title bar's account menu, which is backed by real auth; duplicating them here
 * as disabled rows only advertised things this menu cannot do.
 */
export function OrgSwitcher() {
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const { rename, enableSync } = useOrgStore.use.actions();
  const projects = useProjectStore.use.projects();
  const snapshot = useAuthStore.use.snapshot();
  const signedIn = snapshot.status === "signed-in";
  /** The server orgs THIS account belongs to. `null` = signed out OR never
   *  listed on this machine (offline). Used to gate access to synced orgs the
   *  current account isn't a member of. */
  const myOrgIds =
    snapshot.status === "signed-in" && snapshot.orgs
      ? new Set(snapshot.orgs.map((o) => o.id))
      : null;

  /**
   * Whether the current account may open `org` — and why not, for the tooltip.
   *
   * A LOCAL org is always accessible: it lives only on this machine and needs
   * no credential. A SYNCED org (`remoteId`) belongs to a server account, and
   * signing out or switching accounts must NOT keep you in someone else's org:
   *  - signed out → locked.
   *  - signed in, membership KNOWN, and this org isn't in it → locked.
   *  - membership UNKNOWN (offline, never listed) → allow; we can't prove a
   *    negative, and locking someone out of their own org on an offline launch
   *    is worse than the rare stale case.
   */
  const orgAccess = (org: Organisation): { ok: true } | { ok: false; reason: string } => {
    if (!isSyncedOrg(org)) return { ok: true };
    if (!signedIn) return { ok: false, reason: "Sign in to open this synced organization" };
    if (myOrgIds && !myOrgIds.has(org.remoteId)) {
      return { ok: false, reason: "This account isn't a member of this organization" };
    }
    return { ok: true };
  };

  /** Label for the search button's tooltip, from the live keymap. */
  const paletteHint = useActionShortcut("nav.commandPalette")?.label;

  const [open, setOpen] = useState(false);
  // True while a manual list-refresh is in flight (spins the refresh icon).
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  // Name AND slug: two orgs can share a display name, and the slug is what
  // tells them apart on the server.
  const filteredOrgs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return organisations;
    return organisations.filter(
      (o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q),
    );
  }, [organisations, query]);
  // True while "Turn on sync" is creating the org server-side (spins the row).
  const [syncing, setSyncing] = useState(false);
  // Create-organisation modal (name + globally-unique handle).
  const [createOpen, setCreateOpen] = useState(false);
  // Inline-rename state: the org id being renamed + its draft name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Org pending delete-confirmation (null = no dialog).
  const [confirmDelete, setConfirmDelete] = useState<Organisation | null>(null);
  const canDelete = organisations.length > 1;
  // Members manager (server-backed, so synced orgs only).
  const [membersOpen, setMembersOpen] = useState(false);

  const active = organisations.find((o) => o.id === activeOrganisationId) ?? organisations[0];
  /** Members are a SERVER surface, so this needs both halves: an org that
   *  actually exists server-side, AND a live credential to talk to it with.
   *  Signing out does not un-sync an org — you stay in it, and every member
   *  call would 401 — so the credential has to be checked separately. */
  const activeIsSynced = !!active && isSyncedOrg(active);
  const canManageMembers = activeIsSynced && signedIn;
  /** The id worth copying is the org's identity ON THE SERVER — the one the
   *  gateway, support and every other machine know it by, and the same value
   *  sent as the `atlas-org` header. A local org's `id` is meaningful only on
   *  this Mac, so there is nothing to hand anyone until it is synced. */
  const copyableOrgId = active && isSyncedOrg(active) ? active.remoteId : null;

  const beginRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };
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

  if (!active) return null;

  return (
    // Fixed 29px row + border-b so the divider aligns exactly with the file-tree
    // "ATLAS" header and the editor tab bar (both h-[29px] border-b under the
    // titlebar).
    // The visual top of the rail: avatar, name, chevron on the left; two ghost
    // icon actions on the right. No rule beneath it — the gradient surface
    // and the spacing do the separating.
    <div className="h-[32px] shrink-0 flex items-center px-2">
      <DropdownMenu.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setEditingId(null);
            setQuery("");
          }
        }}
      >
        <DropdownMenu.Trigger
          render={
            <button
              className="flex h-7 items-center gap-2 px-1.5 rounded-md outline-none text-sm font-medium text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] transition-colors cursor-pointer min-w-0"
              title="Switch organization"
            >
              <OrgAvatar org={active} size={18} />
              <span className="text-left truncate">{active.name}</span>
              <ChevronDown size={11} className="text-[var(--muted-foreground)] shrink-0" />
            </button>
          }
        />

        {/* Quick actions — the org row has spare width to its right, so the two
         *  things you reach for constantly (add a project, search everything)
         *  live here as icons instead of eating two full rows in the header
         *  list below. Usage moved up to the titlebar band with the rest of
         *  the rail chrome; Settings is reachable from the account menu and
         *  the command palette, so it no longer spends a slot here. */}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <AddProjectMenu />
          <Hint label="Search" shortcut={paletteHint}>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("atlas:command-palette"))}
              className="flex size-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] outline-none transition-colors cursor-pointer"
            >
              <Search size={13} />
            </button>
          </Hint>
        </div>

        <DropdownMenu.Portal>
          {/* The house menu surface (chat's session picker, the pin rail):
              border + translucent fill + backdrop blur + the grow-from-the-
              trigger animation, ALL on this one element. Splitting them across
              a wrapper isolates the layer and kills the blur. */}
          <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={6}>
            <DropdownMenu.Popup
              // No inset top highlight: on a card this size it draws a bright
              // line across the whole head of the menu, which reads as a second
              // border above the first.
              className="flex max-h-[min(480px,70vh)] w-[268px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-[var(--card)]/95 shadow-md backdrop-blur-2xl atlas-panel-in-tl select-none text-[var(--secondary-foreground)]"
            >
              {/* Head: a filter field with the refresh beside it, no rule under
                  it — the same row the chat session picker opens with. The list
                  below is short enough that a label would only cost a row. */}
              <div className="flex h-[30px] shrink-0 items-center gap-1.5 px-2.5">
                <Search size={11} className="shrink-0 text-[var(--muted-foreground)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Keep keys from the popup's typeahead and arrow nav, but let Escape
                    // bubble to the dismiss handler so it still closes the popup.
                    if (e.key !== "Escape") e.stopPropagation();
                  }}
                  placeholder="Search organizations…"
                  aria-label="Search organizations"
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
                />
                {/* Manual re-sync — only meaningful with a credential to pull
                    with. Silent on failure: Rust keeps the last-known list. */}
                {signedIn && (
                  <Hint label="Refresh organizations">
                    <button
                      disabled={refreshing}
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setRefreshing(true);
                        try {
                          await auth.refresh();
                        } catch {
                          // Left as-is on purpose; the pull failing is not an error
                          // worth a toast on a background list.
                        } finally {
                          setRefreshing(false);
                        }
                      }}
                      className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] outline-none transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw size={10} className={refreshing ? "animate-spin" : ""} />
                    </button>
                  </Hint>
                )}
              </div>

              <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto pb-1">
                {filteredOrgs.length === 0 && (
                  <div className="px-2.5 py-3 text-center text-xs text-[var(--atlas-text-disabled)]">
                    No organizations match.
                  </div>
                )}
                {filteredOrgs.map((org) => {
                  const isActive = org.id === active.id;
                  // Inline-rename row: a plain input (NOT a menu item) so typing
                  // doesn't trigger Radix typeahead / select / close.
                  if (editingId === org.id) {
                    return (
                      <div
                        key={org.id}
                        className="mx-1 flex h-control-md w-[calc(100%-8px)] items-center gap-2 rounded-md px-1.5"
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <OrgAvatar org={org} size={16} plain />
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") submitRename();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          onBlur={submitRename}
                          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-[var(--foreground)]"
                        />
                      </div>
                    );
                  }
                  const access = orgAccess(org);
                  return (
                    <DropdownMenu.Item
                      key={org.id}
                      disabled={!access.ok}
                      title={access.ok ? undefined : access.reason}
                      onClick={() => {
                        if (!access.ok) return;
                        if (!isActive) void switchOrg(org.id);
                      }}
                      className={cn(
                        // Inset rows (a margin, a radius) rather than full-bleed
                        // stripes: the highlight then reads as a chip inside the
                        // card, which is what the chat menus do.
                        "group/org mx-1 flex h-control-md w-[calc(100%-8px)] items-center gap-2 rounded-md px-1.5 text-sm outline-none transition-colors",
                        isActive && "bg-[var(--atlas-element-active)] text-[var(--foreground)]",
                        access.ok
                          ? "cursor-pointer hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                          : "cursor-not-allowed opacity-40",
                      )}
                    >
                      <OrgAvatar org={org} size={16} plain />
                      <span className="flex-1 text-left truncate">{org.name}</span>
                      {/* A locked org offers no row actions — you can't manage an
                          org this account has no access to. */}
                      {/* Rename (pencil) — appears on hover; doesn't switch/close.
                          Local-only orgs only: a synced org's name is owned by the
                          server and re-applied on every auth refresh, so a local
                          rename would silently revert. There is no org-update
                          route in the client to write it through with. */}
                      {access.ok && !isSyncedOrg(org) && (
                        <Hint label="Rename organization">
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              beginRename(org.id, org.name);
                            }}
                            className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 hover:bg-[var(--card)] hover:text-[var(--foreground)] group-hover/org:opacity-100 focus-visible:opacity-100 cursor-pointer transform-gpu [backface-visibility:hidden]"
                          >
                            <Pencil size={11} />
                          </button>
                        </Hint>
                      )}
                      {/* Delete — appears on hover; opens confirmation. Hidden when
                          this is the only org (can't delete the last one). */}
                      {access.ok && canDelete && (
                        <Hint label="Delete organization">
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setConfirmDelete(org);
                              setOpen(false);
                            }}
                            className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 hover:bg-[var(--card)] hover:text-error group-hover/org:opacity-100 focus-visible:opacity-100 cursor-pointer transform-gpu [backface-visibility:hidden]"
                          >
                            <Trash2 size={11} />
                          </button>
                        </Hint>
                      )}
                      {!access.ok ? (
                        <Lock size={11} className="text-[var(--muted-foreground)] shrink-0" />
                      ) : (
                        isActive && (
                          <Check size={13} className="shrink-0 text-[var(--foreground)]" />
                        )
                      )}
                    </DropdownMenu.Item>
                  );
                })}
              </div>

              <DropdownMenu.Separator className="h-px shrink-0 bg-border-subtle" />

              {/* Create organisation — opens the name + handle modal (the handle
                  is globally unique, so it needs a real form, not an inline input). */}
              <DropdownMenu.Item
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
                className="mx-1 mt-1 flex h-control-md w-[calc(100%-8px)] shrink-0 items-center gap-2 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
              >
                <Plus size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                <span className="flex-1 text-left">Create organization…</span>
              </DropdownMenu.Item>

              {/* Members live on the server, so this only means anything for a
                  SYNCED org — a local-only org has no server org to manage. */}
              {canManageMembers ? (
                <DropdownMenu.Item
                  onClick={() => {
                    setOpen(false);
                    setMembersOpen(true);
                  }}
                  className="mx-1 flex h-control-md w-[calc(100%-8px)] shrink-0 items-center gap-2 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
                >
                  <Users size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                  <span className="flex-1 text-left">Invite &amp; Manage members</span>
                </DropdownMenu.Item>
              ) : (
                <div
                  title={
                    activeIsSynced ? "Sign in to manage members" : "Turn on sync to manage members"
                  }
                  className="mx-1 flex h-control-md w-[calc(100%-8px)] shrink-0 cursor-not-allowed items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] opacity-40 select-none"
                >
                  <Users size={12} className="shrink-0" />
                  <span className="flex-1 text-left">Invite &amp; Manage members</span>
                </div>
              )}

              {/* The ACTIVE org's server id, for support threads and anywhere a
                  teammate has to name this org precisely. Disabled rather than
                  hidden when the org is local: the row explains why the id the
                  user came looking for isn't there yet. */}
              {copyableOrgId ? (
                <DropdownMenu.Item
                  onClick={async () => {
                    setOpen(false);
                    if (await copyText(copyableOrgId)) toast.success("Organization ID copied");
                    else toast.error("Could not copy the organization ID");
                  }}
                  title={copyableOrgId}
                  className="mx-1 mb-1 flex h-control-md w-[calc(100%-8px)] shrink-0 items-center gap-2 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
                >
                  <Copy size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                  <span className="flex-1 text-left">Copy organization ID</span>
                </DropdownMenu.Item>
              ) : (
                <div
                  title="Turn on sync to give this organization an ID"
                  className="mx-1 mb-1 flex h-control-md w-[calc(100%-8px)] shrink-0 cursor-not-allowed items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] opacity-40 select-none"
                >
                  <Copy size={12} className="shrink-0" />
                  <span className="flex-1 text-left">Copy organization ID</span>
                </div>
              )}

              <DropdownMenu.Separator className="h-px shrink-0 bg-border-subtle" />

              {/* Sync toggle for the ACTIVE org — in the footer (not under the org
               *  list) so it's unambiguous which org it applies to. Signed out,
               *  the action starts sign-in; already-synced, it just reports state. */}
              {syncing ? (
                <div
                  title="Syncing…"
                  className="mx-1 my-1 flex h-control-md w-[calc(100%-8px)] items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] select-none"
                >
                  <Loader2
                    size={12}
                    className="shrink-0 animate-spin text-[var(--muted-foreground)]"
                  />
                  <span className="flex-1 text-left truncate">Syncing {active.name}…</span>
                </div>
              ) : isSyncedOrg(active) ? (
                <div
                  title="This organization is synced with your Atlas account"
                  className="mx-1 my-1 flex h-control-md w-[calc(100%-8px)] items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] select-none"
                >
                  <Cloud size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                  <span className="flex-1 text-left truncate">{active.name} is synced</span>
                  <Check size={12} className="shrink-0 text-[var(--secondary-foreground)]" />
                </div>
              ) : (
                <DropdownMenu.Item
                  // Radix kept the menu open by calling preventDefault() inside
                  // onSelect; Base UI spells that closeOnClick={false}.
                  closeOnClick={false}
                  onClick={() => {
                    // Signed out, enableSync opens sign-in and returns instantly —
                    // no spinner. Signed in, it round-trips, so show the syncing
                    // state until it settles (success → "synced", failure → toast).
                    if (!signedIn) {
                      void enableSync(active.id);
                      return;
                    }
                    setSyncing(true);
                    void enableSync(active.id).finally(() => setSyncing(false));
                  }}
                  title={
                    signedIn
                      ? "Create this organization in your Atlas account"
                      : "Sign in to sync this organization"
                  }
                  className="mx-1 my-1 flex h-control-md w-[calc(100%-8px)] items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
                >
                  <Cloud size={12} className="shrink-0" />
                  <span className="flex-1 text-left truncate">Turn on sync for {active.name}…</span>
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Popup>
          </DropdownMenu.Positioner>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />

      <MembersModal org={active} open={membersOpen} onOpenChange={setMembersOpen} />

      <DeleteOrgDialog
        org={confirmDelete}
        projectCount={
          confirmDelete ? projects.filter((w) => w.orgId === confirmDelete.id).length : 0
        }
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** Confirmation before wiping an organisation + all its org-scoped app data. */
function DeleteOrgDialog({
  org,
  projectCount,
  onClose,
}: {
  org: Organisation | null;
  projectCount: number;
  onClose: () => void;
}) {
  // True while the delete round-trips (server delete for a synced org, then the
  // local purge). Blocks the dialog from closing mid-flight.
  const [deleting, setDeleting] = useState(false);
  return (
    <Dialog.Root
      open={!!org}
      onOpenChange={(o) => {
        if (!o && !deleting) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-sm" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "w-[400px] max-w-[92vw] rounded-lg border border-border",
            "bg-[var(--card)] p-5 shadow-lg animate-scale-in",
          )}
        >
          <Dialog.Title className="text-md font-medium text-[var(--foreground)]">
            Delete “{org?.name}”?
          </Dialog.Title>
          <p className="mt-2 text-sm leading-relaxed text-[var(--secondary-foreground)]">
            This permanently removes the organization
            {projectCount > 0 && (
              <>
                {" "}
                and its{" "}
                <span className="text-[var(--foreground)]">
                  {projectCount} project{projectCount === 1 ? "" : "s"}
                </span>{" "}
                (plus their chats)
              </>
            )}{" "}
            from Atlas. Your actual project files on disk are not touched. This can’t be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={deleting}
              className="px-3 h-8 rounded-md text-sm text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!org) return;
                setDeleting(true);
                try {
                  await deleteOrgAndData(org.id);
                } finally {
                  setDeleting(false);
                  onClose();
                }
              }}
              disabled={deleting}
              className="px-3 h-8 rounded-md text-sm font-medium bg-error text-destructive-foreground hover:opacity-90 transition-opacity cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {deleting && <Loader2 size={12} className="animate-spin" />}
              {deleting ? "Deleting…" : "Delete organization"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
