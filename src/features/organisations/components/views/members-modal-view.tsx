import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { Check, Copy, LogOut, MoreHorizontal, RefreshCw, Trash2, UserPlus, X } from "lucide-react";
import {
  Button,
  Callout,
  DataTable,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Hint,
  HintGroup,
  HintItem,
  Icon,
  IconButton,
  Select,
  Skeleton,
  Spinner,
  TableSearch,
  Tag,
  type Column,
} from "@tryatlas/design";

import { timeAgo } from "@/lib/time-ago";
import { AccountAvatarView } from "@/features/auth/components/views/account-avatar-view";
import { ROLES, ROLE_HUE, ROLE_LABELS, type Role } from "@/features/auth/lib/roles";
import type { MemberRowAccess } from "../../lib/member-access";
import { ConfirmOrgDialogView } from "./confirm-org-dialog-view";
import { EmailChipsInput, dedupe, isEmail, splitEmails } from "./email-chips-input";

export interface MemberRowData {
  id: string;
  name: string;
  email: string;
  role: Role | null;
  /** The org's creator. Not a role: the Owner also holds one. */
  isOwner: boolean;
  createdAt: string | null;
  avatarSrc: string | null;
  /** This row is the viewer. */
  self: boolean;
  /** What the viewer may do from this row (`memberRowAccess`). */
  access: MemberRowAccess;
}

export interface InvitationRowData {
  id: string;
  email: string;
  role: Role | null;
  status: string;
  acceptUrl: string | null;
}

export type MembersBody = "signed-out" | "first-load" | "error" | "ready";
export type MembersTab = "members" | "invitations";

export interface InviteBand {
  emails: string[];
  draft: string;
  role: Role;
  sending: boolean;
  onEmailsChange: (next: string[]) => void;
  onDraftChange: (next: string) => void;
  onRoleChange: (role: Role) => void;
  onSubmit: () => void;
}

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

/**
 * The members manager for a SYNCED organisation: the roster and the pending
 * invitations, an invite band for admins, and each row's actions.
 *
 * Rendered from the members cache, so reopening is instant and a refresh only
 * moves the Refresh glyph — the table never blanks while it revalidates.
 */
export function MembersModalView({
  open,
  onOpenChange,
  orgName,
  body,
  error,
  refreshing,
  canRefresh,
  onRefresh,
  isAdmin,
  tab,
  onTabChange,
  members,
  invitations,
  onRoleChange,
  onRemove,
  onLeave,
  onCancelInvite,
  onCopyInviteLink,
  invite,
  leave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
  body: MembersBody;
  error: string | null;
  refreshing: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  isAdmin: boolean;
  tab: MembersTab;
  onTabChange: (tab: MembersTab) => void;
  members: MemberRowData[];
  invitations: InvitationRowData[];
  onRoleChange: (memberId: string, role: Role) => void;
  onRemove: (memberId: string) => void;
  /** Ask to leave — `leave` carries the confirmation. */
  onLeave: () => void;
  onCancelInvite: (invitationId: string) => void;
  onCopyInviteLink: (url: string) => void;
  /** `null` when the viewer is not an admin: the API refuses anyone else. */
  invite: InviteBand | null;
  /** The confirmation in front of a leave. Nested in this dialog rather than
   *  replacing it, so Cancel lands back on the roster. */
  leave: {
    open: boolean;
    leaving: boolean;
    /** It is the only org on this desktop, so it stays as a local-only one. */
    onlyOrg: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  };
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const shownMembers = useMemo(
    () =>
      q
        ? members.filter(
            (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
          )
        : members,
    [members, q],
  );
  const shownInvites = useMemo(
    () => (q ? invitations.filter((i) => i.email.toLowerCase().includes(q)) : invitations),
    [invitations, q],
  );

  const memberColumns: Column<MemberRowData>[] = [
    {
      id: "person",
      header: "Person",
      className: "w-full max-w-0",
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2">
          <AccountAvatarView name={m.name} email={m.email} src={m.avatarSrc} size={20} />
          <span className="min-w-0">
            <span className="block truncate text-sm text-foreground">
              {m.name || m.email}
              {m.self && <span className="ml-1.5 text-2xs text-muted-foreground">You</span>}
            </span>
            {m.name && (
              <span className="block truncate text-2xs text-muted-foreground">{m.email}</span>
            )}
          </span>
        </span>
      ),
    },
    {
      id: "role",
      header: "Role",
      className: "w-[150px] whitespace-nowrap",
      cell: (m) => <RoleCell role={m.role} isOwner={m.isOwner} />,
    },
    {
      id: "joined",
      header: "Joined",
      className: "w-[120px] whitespace-nowrap",
      cell: (m) => (
        <span className="text-2xs text-muted-foreground">
          {timeAgo(m.createdAt, { suffix: true }) || "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10",
      align: "right",
      cell: (m) =>
        m.access.menu ? (
          <MemberMenu
            member={m}
            onRoleChange={(role) => onRoleChange(m.id, role)}
            onRemove={() => onRemove(m.id)}
            onLeave={onLeave}
          />
        ) : null,
    },
  ];

  const inviteColumns: Column<InvitationRowData>[] = [
    {
      id: "email",
      header: "Email",
      className: "w-full max-w-0",
      cell: (i) => <span className="block truncate text-sm text-foreground">{i.email}</span>,
    },
    {
      id: "role",
      header: "Role",
      className: "w-[150px] whitespace-nowrap",
      cell: (i) => <RoleCell role={i.role} isOwner={false} />,
    },
    {
      id: "status",
      header: "Status",
      className: "w-[120px] whitespace-nowrap",
      cell: (i) => <span className="text-2xs text-muted-foreground capitalize">{i.status}</span>,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-16",
      align: "right",
      cell: (i) => (
        <HintGroup>
          <span className="flex items-center justify-end gap-0.5">
            {i.acceptUrl && (
              <HintItem label="Copy invite link">
                <IconButton
                  icon={Copy}
                  label="Copy invite link"
                  size="xs"
                  onClick={() => onCopyInviteLink(i.acceptUrl!)}
                />
              </HintItem>
            )}
            {isAdmin && (
              <HintItem label="Cancel invite">
                <IconButton
                  icon={X}
                  label="Cancel invite"
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() => onCancelInvite(i.id)}
                />
              </HintItem>
            )}
          </span>
        </HintGroup>
      ),
    },
  ];

  const toolbar = (
    <>
      {(
        [
          ["members", "Members", members.length],
          ["invitations", "Invitations", invitations.length],
        ] as const
      ).map(([id, label, count]) => (
        <Button
          key={id}
          variant={tab === id ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={tab === id}
          onClick={() => onTabChange(id)}
        >
          {label}
          <span className="text-3xs text-muted-foreground tabular-nums">{count}</span>
        </Button>
      ))}
      <div className="flex-1" />
      <TableSearch
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people…"
        aria-label="Search people"
      />
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-members-modal=""
        className="h-[min(40rem,calc(100vh-4rem))] max-w-[min(56rem,calc(100vw-2rem))] gap-0 p-0"
      >
        <DialogTitle className="sr-only">Members of {orgName}</DialogTitle>

        <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border-subtle pr-12 pl-4">
          <span className="eyebrow min-w-0 flex-1 truncate text-muted-foreground">
            {orgName} · {members.length} {members.length === 1 ? "member" : "members"}
          </span>
          <Hint label={canRefresh ? "Refresh" : "Sign in to refresh"}>
            <span className={refreshing ? "flex animate-spin" : "flex"}>
              <IconButton
                icon={RefreshCw}
                label={canRefresh ? "Refresh" : "Sign in to refresh"}
                size="sm"
                disabled={!canRefresh}
                onClick={onRefresh}
              />
            </span>
          </Hint>
        </div>

        {/* Tabs with counts, and the search. */}
        <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border px-3">
          {toolbar}
        </div>

        {invite && <InviteBandView invite={invite} />}

        <div className="flex min-h-0 flex-1 flex-col p-3">
          {body === "signed-out" ? (
            <EmptyState title="Sign in to manage this organization's members." />
          ) : body === "first-load" ? (
            <div className="flex flex-col gap-2" aria-busy>
              {[0, 1, 2, 3].map((n) => (
                <Skeleton key={n} className="h-10" />
              ))}
            </div>
          ) : body === "error" ? (
            <Callout
              tone="error"
              action={
                <Button size="sm" variant="secondary" disabled={!canRefresh} onClick={onRefresh}>
                  Retry
                </Button>
              }
            >
              {error}
            </Callout>
          ) : tab === "members" ? (
            <DataTable
              className="h-full"
              rows={shownMembers}
              rowId={(m) => m.id}
              columns={memberColumns}
              empty={q ? "No people match." : "No members yet."}
            />
          ) : (
            <DataTable
              className="h-full"
              rows={shownInvites}
              rowId={(i) => i.id}
              columns={inviteColumns}
              empty={q ? "No invites match." : "No pending invitations."}
            />
          )}
        </div>

        <ConfirmOrgDialogView
          open={leave.open}
          busy={leave.leaving}
          title={`Leave “${orgName}”?`}
          description={
            <>
              You lose access to its chat, projects and shared sessions at once. Coming back takes a
              new invitation.{" "}
              {leave.onlyOrg
                ? "It stays on this desktop as a local-only organization, with its projects."
                : "Atlas stops listing its projects here."}{" "}
              Your project files on this machine are not touched.
            </>
          }
          confirmLabel="Leave organization"
          busyLabel="Leaving…"
          onConfirm={leave.onConfirm}
          onCancel={leave.onCancel}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Owner isn't a role, so a demoted Owner shows both. */
function RoleCell({ role, isOwner }: { role: Role | null; isOwner: boolean }) {
  const label = role ? ROLE_LABELS[role] : null;
  const text = isOwner
    ? role === "admin" || !label
      ? "Owner"
      : `Owner · ${label}`
    : (label ?? "—");
  if (!role) return <span className="text-xs text-muted-foreground">{text}</span>;
  return (
    <Tag hue={ROLE_HUE[role]} dot>
      {text}
    </Tag>
  );
}

function MemberMenu({
  member,
  onRoleChange,
  onRemove,
  onLeave,
}: {
  member: MemberRowData;
  onRoleChange: (role: Role) => void;
  onRemove: () => void;
  onLeave: () => void;
}) {
  const { access, self } = member;
  const who = member.name || member.email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <HintedIconButton
            hint={access.roles ? "Manage" : "Options"}
            icon={MoreHorizontal}
            label={`${access.roles ? "Manage" : "Options for"} ${who}`}
            size="xs"
          />
        }
      />
      <DropdownMenuContent align="end">
        {access.roles && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Role</DropdownMenuLabel>
              {ROLES.map((r) => (
                <DropdownMenuItem
                  key={r}
                  // Picking the role a member already has changes nothing.
                  onClick={() => {
                    if (r !== member.role) onRoleChange(r);
                  }}
                >
                  {ROLE_LABELS[r]}
                  {member.role === r && <Icon icon={Check} size="sm" className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {/* Leave on your own row, Remove on anyone else's — each disabled with
            the server's reason when it would refuse. See `memberRowAccess`.
            The reason sits on a wrapper: a disabled item takes no pointer
            events, so a `title` on the item itself would never show. */}
        <div title={access.blockedReason ?? undefined}>
          <DropdownMenuItem
            variant="destructive"
            disabled={!access.actionAllowed}
            onClick={access.actionAllowed ? (self ? onLeave : onRemove) : undefined}
          >
            {self ? <LogOut /> : <Trash2 />}
            {self ? "Leave organization…" : "Remove from organization"}
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * An icon button with its tooltip inside, for a menu trigger's `render`: the
 * trigger's props and ref land here and must reach the button the tooltip
 * merges onto. The hint is shorter than the accessible name ("Manage" over
 * "Manage Priya Raghunathan"), so the name is passed as `aria-label` too —
 * `Hint` names its trigger only when it has no name of its own.
 */
function HintedIconButton({
  hint,
  ...props
}: ComponentProps<typeof IconButton> & { hint: string }) {
  return (
    <Hint label={hint}>
      <IconButton aria-label={props.label} {...props} />
    </Hint>
  );
}

/** The admin's invite band: addresses as chips, a role, and Invite. */
function InviteBandView({ invite }: { invite: InviteBand }) {
  /** Chips + a still-unconfirmed draft, deduped — what Invite actually sends. */
  const pending = dedupe([...invite.emails, ...splitEmails(invite.draft)]);
  const invalid = pending.filter((e) => !isEmail(e));
  return (
    <div className="flex h-[44px] shrink-0 items-center gap-2 border-b border-border px-3">
      <Icon icon={UserPlus} size="sm" className="shrink-0 text-muted-foreground" />
      <EmailChipsInput
        emails={invite.emails}
        draft={invite.draft}
        onEmailsChange={invite.onEmailsChange}
        onDraftChange={invite.onDraftChange}
        onSubmit={invite.onSubmit}
      />
      <Select
        value={invite.role}
        onValueChange={invite.onRoleChange}
        options={ROLE_OPTIONS}
        size="md"
        aria-label="Role"
      />
      <Button
        variant="default"
        size="md"
        disabled={pending.length === 0 || invalid.length > 0 || invite.sending}
        title={invalid.length > 0 ? `Not a valid email: ${invalid.join(", ")}` : undefined}
        onClick={invite.onSubmit}
      >
        {invite.sending ? <Spinner size="sm" label="" /> : <Icon icon={UserPlus} size="sm" />}
        Invite
        {pending.length > 1 && ` ${pending.length}`}
      </Button>
    </div>
  );
}
