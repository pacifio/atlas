import type { ReactNode } from "react";
import {
  Check,
  Cloud,
  Copy,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  Hint,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Spinner,
} from "@tryatlas/design";

import { isSyncedOrg, type Organisation } from "../../types";
import type { OrgAccess } from "../../lib/org-switcher-model";
import { OrgMark } from "./org-mark";

export interface OrgRow {
  org: Organisation;
  isActive: boolean;
  access: OrgAccess;
}

/** An action that may be unavailable, with why. */
export type Gate = { enabled: true } | { enabled: false; reason: string };

export type OrgSyncState = "syncing" | "synced" | { state: "off"; signedIn: boolean };

/**
 * The organisation menu's body: a filter, the org list (a synced org this
 * account cannot open is locked, with the reason on hover), create, members,
 * the org id and sync.
 *
 * Scoped to organisations only. Identity, Settings and sign-out live in the
 * account menu, which is backed by real auth.
 *
 * Renders menu items, so it goes inside a menu popup or submenu popup: the
 * title bar's breadcrumb menu and the sidebar project picker's Organization
 * submenu both host it, so the two never drift.
 */
export function OrgMenuPanelView({
  active,
  rows,
  query,
  onQueryChange,
  canRefresh,
  refreshing,
  onRefresh,
  editingId,
  editName,
  onEditNameChange,
  onBeginRename,
  onSubmitRename,
  onCancelRename,
  canDelete,
  onRequestDelete,
  onSelect,
  onCreate,
  members,
  onManageMembers,
  copyId,
  onCopyId,
  sync,
  onEnableSync,
}: {
  active: Organisation;
  /** The orgs the filter keeps, in order. */
  rows: readonly OrgRow[];
  query: string;
  onQueryChange: (query: string) => void;
  /** A manual re-sync means something only with a credential to pull with. */
  canRefresh: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  editingId: string | null;
  editName: string;
  onEditNameChange: (name: string) => void;
  onBeginRename: (org: Organisation) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  /** More than one org: the last one can't be deleted. */
  canDelete: boolean;
  onRequestDelete: (org: Organisation) => void;
  onSelect: (org: Organisation) => void;
  onCreate: () => void;
  members: Gate;
  onManageMembers: () => void;
  /** The ACTIVE org's server id, when it has one. */
  copyId: { enabled: true; id: string } | { enabled: false; reason: string };
  onCopyId: () => void;
  sync: OrgSyncState;
  onEnableSync: () => void;
}) {
  return (
    <>
      {/* A filter field with the refresh beside it. */}
      <div
        className="flex shrink-0 items-center gap-1 p-1"
        onKeyDown={(e) => {
          // Keep keys from the popup's typeahead and arrow nav, but let Escape
          // bubble to the dismiss handler so it still closes the popup.
          if (e.key !== "Escape") e.stopPropagation();
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <Icon icon={Search} size="sm" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search organizations…"
            aria-label="Search organizations"
          />
        </InputGroup>
        {/* Silent on failure: Rust keeps the last-known list. */}
        {canRefresh && (
          <Hint label="Refresh organizations">
            <span className={refreshing ? "flex animate-spin" : "flex"}>
              <IconButton
                icon={RefreshCw}
                label="Refresh organizations"
                size="sm"
                disabled={refreshing}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onRefresh();
                }}
              />
            </span>
          </Hint>
        )}
      </div>

      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain py-0.5">
        {rows.length === 0 && (
          <div className="px-2.5 py-3 text-center text-xs text-muted-foreground">
            No organizations match.
          </div>
        )}
        {rows.map(({ org, isActive, access }) =>
          editingId === org.id ? (
            // Inline-rename row: a plain input (NOT a menu item) so typing
            // doesn't trigger the menu's typeahead / select / close.
            <div
              key={org.id}
              className="flex items-center gap-2 px-2 py-0.5"
              onKeyDown={(e) => e.stopPropagation()}
            >
              <OrgMark org={org} />
              <Input
                size="sm"
                autoFocus
                aria-label="Organization name"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitRename();
                  if (e.key === "Escape") onCancelRename();
                }}
                onBlur={onSubmitRename}
              />
            </div>
          ) : (
            <Titled key={org.id} title={access.ok ? undefined : access.reason}>
              <DropdownMenuItem
                disabled={!access.ok}
                onClick={() => {
                  if (access.ok && !isActive) onSelect(org);
                }}
                className="group/org"
              >
                <OrgMark org={org} />
                <span className="flex-1 truncate text-left">{org.name}</span>
                {/* A locked org offers no row actions — you can't manage an
                    org this account has no access to. */}
                {/* Rename — local-only orgs only: a synced org's name is owned
                    by the server and re-applied on every auth refresh, so a
                    local rename would silently revert. */}
                {access.ok && !isSyncedOrg(org) && (
                  <RowAction>
                    <Hint label="Rename organization">
                      <IconButton
                        icon={Pencil}
                        label="Rename organization"
                        size="xs"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onBeginRename(org);
                        }}
                      />
                    </Hint>
                  </RowAction>
                )}
                {/* Hidden when this is the only org (can't delete the last). */}
                {access.ok && canDelete && (
                  <RowAction>
                    <Hint label="Delete organization">
                      <IconButton
                        icon={Trash2}
                        label="Delete organization"
                        size="xs"
                        variant="ghost-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onRequestDelete(org);
                        }}
                      />
                    </Hint>
                  </RowAction>
                )}
                {!access.ok ? (
                  <Icon icon={Lock} size="sm" className="text-muted-foreground" />
                ) : (
                  isActive && <Icon icon={Check} size="md" className="text-foreground" />
                )}
              </DropdownMenuItem>
            </Titled>
          ),
        )}
      </div>

      <DropdownMenuSeparator />

      {/* Opens the name + handle modal (the handle is globally unique, so it
          needs a real form, not an inline input). */}
      <DropdownMenuItem onClick={onCreate}>
        <Plus />
        Create organization…
      </DropdownMenuItem>

      {/* Members live on the server, so this only means anything for a SYNCED
          org with a live credential. */}
      <Titled title={members.enabled ? undefined : members.reason}>
        <DropdownMenuItem disabled={!members.enabled} onClick={onManageMembers}>
          <Users />
          Invite &amp; Manage members
        </DropdownMenuItem>
      </Titled>

      {/* Disabled rather than hidden when the org is local: the row explains
          why the id the user came looking for isn't there yet. */}
      <Titled title={copyId.enabled ? copyId.id : copyId.reason}>
        <DropdownMenuItem disabled={!copyId.enabled} onClick={onCopyId}>
          <Copy />
          Copy organization ID
        </DropdownMenuItem>
      </Titled>

      <DropdownMenuSeparator />

      {/* Sync for the ACTIVE org — in the footer (not under the org list) so
          it's unambiguous which org it applies to. Signed out, the action
          starts sign-in; already synced, it just reports state. */}
      {sync === "syncing" ? (
        <SyncStatus title="Syncing…">
          <Spinner size="sm" label="" />
          <span className="flex-1 truncate">Syncing {active.name}…</span>
        </SyncStatus>
      ) : sync === "synced" ? (
        <SyncStatus title="This organization is synced with your Atlas account">
          <Icon icon={Cloud} size="sm" className="text-muted-foreground" />
          <span className="flex-1 truncate">{active.name} is synced</span>
          <Icon icon={Check} size="sm" />
        </SyncStatus>
      ) : (
        <DropdownMenuItem
          closeOnClick={false}
          onClick={onEnableSync}
          title={
            sync.signedIn
              ? "Create this organization in your Atlas account"
              : "Sign in to sync this organization"
          }
        >
          <Cloud />
          <span className="flex-1 truncate">Turn on sync for {active.name}…</span>
        </DropdownMenuItem>
      )}
    </>
  );
}

/**
 * A disabled menu item takes no pointer events, so a `title` on it never
 * shows. The reason sits on a wrapper instead, which still gets the hover.
 */
function Titled({ title, children }: { title: string | undefined; children: ReactNode }) {
  return title ? <div title={title}>{children}</div> : children;
}

/** A row action revealed on hover or keyboard focus; it doesn't switch or
 *  close (each one stops its own click). */
function RowAction({ children }: { children: ReactNode }) {
  return (
    <span className="flex opacity-0 group-hover/org:opacity-100 focus-within:opacity-100">
      {children}
    </span>
  );
}

/** A non-interactive row reporting the active org's sync state. */
function SyncStatus({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      title={title}
      className="flex items-center gap-2 px-2 py-1 text-xs text-secondary-foreground select-none"
    >
      {children}
    </div>
  );
}
