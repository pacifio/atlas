import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  Check,
  Copy,
  Loader2,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/time-ago";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import {
  ROLE_LABELS,
  type OrgInvitation,
  type OrgMember,
  type Role,
} from "@/features/auth/lib/auth-api";
import { memberRowAccess } from "../lib/member-access";
import { leaveOrgAndData } from "../lib/org-switch";
import { useMembersStore } from "../stores/members-store";
import { useOrgStore } from "../stores/org-store";
import type { Organisation } from "../types";

const ROLES: Role[] = ["admin", "product_owner", "developer", "member"];

/** Shared column widths so the header and every row line up — the same device
 *  the providers table uses. */
const COL = {
  person: "flex-1 min-w-[240px]",
  role: "w-[150px] shrink-0",
  joined: "w-[120px] shrink-0",
  actions: "w-[40px] shrink-0",
} as const;
const TABLE_MIN_W = 240 + 150 + 120 + 40;

type Tab = "members" | "invitations";

/**
 * Near-fullscreen members manager for a SYNCED organisation.
 *
 * Reads from the members cache, so reopening renders instantly and only
 * revalidates in the background — the table never blanks while it refreshes.
 */
export function MembersModal({
  org,
  open,
  onOpenChange,
}: {
  org: Organisation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const orgId = org?.remoteId ?? null;
  const byOrg = useMembersStore.use.byOrg();
  const { load, setRole, remove, invite, cancelInvite } = useMembersStore.use.actions();
  const snapshot = useAuthStore.use.snapshot();

  const roster = (orgId && byOrg[orgId]) || null;
  const members = roster?.members ?? [];
  const invitations = roster?.invitations ?? [];
  const loading = roster?.loading ?? false;
  /** Never loaded AND currently loading — the only state that shows a spinner
   *  instead of rows. A revalidation over cached rows must not. */
  const firstLoad = loading && (roster?.loadedAt ?? null) === null;

  const [tab, setTab] = useState<Tab>("members");
  const [query, setQuery] = useState("");
  /** Committed invitee chips, plus whatever is still being typed. The draft is
   *  held here (not inside the input) so submitting can absorb it — typing an
   *  address and hitting Invite without pressing comma must still work. */
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("developer");
  const [inviting, setInviting] = useState(false);

  /** Signing out does not leave the org — you stay in a synced org with no
   *  credential — so every read here would 401. Check it separately from
   *  whether the org is synced. */
  const signedIn = snapshot.status === "signed-in";

  // Open → revalidate. `load` is stale-while-revalidate, so this is cheap and
  // never blanks what's already on screen. Skipped signed out: the session can
  // end while this modal is open, and retrying a dead credential just loops.
  useEffect(() => {
    if (open && orgId && signedIn) void load(orgId);
  }, [open, orgId, signedIn, load]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setInviteEmails([]);
      setEmailDraft("");
      setTab("members");
    }
  }, [open]);

  /** The caller's own role here — gates the destructive controls. The server
   *  403s regardless; this just avoids showing buttons that can only fail. */
  const myRole =
    snapshot.status === "signed-in"
      ? (snapshot.orgs?.find((o) => o.id === orgId)?.role ?? null)
      : null;
  const isAdmin = myRole === "admin";
  /** The org would have no admin left if this account went — the server
   *  refuses that leave, so the menu says why instead of offering it. */
  const soleAdmin = isAdmin && members.filter((m) => m.role === "admin").length <= 1;

  /** How many orgs this desktop tracks: leaving the only one keeps it here
   *  as a local-only org instead of dropping it (see `leaveOrgAndData`). */
  const orgCount = useOrgStore((s) => s.organisations.length);
  /** The leave confirmation is open. */
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    if (!org) return;
    setLeaving(true);
    try {
      // `false`: the switch away was declined, and nothing was left.
      if (!(await leaveOrgAndData(org.id))) return;
      toast.success(`You left ${org.name}.`);
      setConfirmLeave(false);
      onOpenChange(false);
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Couldn't leave the organization.");
    } finally {
      setLeaving(false);
    }
  };

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  }, [members, query]);

  const filteredInvites = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return invitations;
    return invitations.filter((i) => i.email.toLowerCase().includes(q));
  }, [invitations, query]);

  /** Chips + a still-unconfirmed draft, deduped — what Invite actually sends. */
  const pendingInvites = useMemo(
    () => dedupe([...inviteEmails, ...splitEmails(emailDraft)]),
    [inviteEmails, emailDraft],
  );
  const invalidInvites = pendingInvites.filter((e) => !isEmail(e));

  const submitInvite = async () => {
    if (!orgId || pendingInvites.length === 0 || invalidInvites.length > 0) return;
    setInviting(true);
    // Sequential, not Promise.all: every /api/auth/* path shares one
    // 100-req/60s budget, and a partial failure should still leave the invites
    // that DID land in place rather than being lost in a rejected batch.
    const sent: string[] = [];
    const links: string[] = [];
    for (const email of pendingInvites) {
      const created = await invite(orgId, email, inviteRole);
      if (!created) continue; // the store already toasted this one
      sent.push(created.email);
      if (created.acceptUrl) links.push(created.acceptUrl);
    }
    setInviting(false);
    if (sent.length === 0) return;

    setInviteEmails([]);
    setEmailDraft("");
    setTab("invitations");
    // The server emails each invitee their accept link; copy the links too so
    // the inviter can also share them directly (chat, DM) if they prefer.
    if (links.length > 0) {
      void copy(
        links.join("\n"),
        links.length === 1
          ? "Invitation emailed. Link copied — you can share it directly too."
          : `${links.length} invitations emailed. Links copied — you can share them directly too.`,
      );
    } else {
      toast.success(`Invited ${sent.join(", ")}.`);
    }
  };

  if (!org) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim" />
        <Dialog.Popup
          aria-describedby={undefined}
          className="fixed top-8.5 left-4 right-4 bottom-6 z-modal rounded-xl border border-[var(--border)] bg-[var(--sidebar)] overflow-hidden flex flex-col shadow-lg focus:outline-none"
        >
          <Dialog.Title className="sr-only">Members of {org.name}</Dialog.Title>

          {/* Header — mirrors the git-graph fullscreen bar. */}
          <div className="flex items-center justify-between px-3 h-[32px] shrink-0 border-b border-border-subtle">
            <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wide">
              {org.name} · {members.length} {members.length === 1 ? "member" : "members"}
            </span>
            <HintGroup>
              <div className="flex items-center gap-0.5">
                <HintItem label={signedIn ? "Refresh" : "Sign in to refresh"}>
                  <button
                    disabled={!signedIn}
                    onClick={() => orgId && void load(orgId, { force: true })}
                    className={cn(
                      "p-1 rounded text-muted-foreground transition-colors",
                      signedIn
                        ? "hover:bg-element-hover hover:text-foreground cursor-pointer"
                        : "opacity-40 cursor-not-allowed",
                      loading && "animate-spin",
                    )}
                  >
                    <RefreshCw size={11} />
                  </button>
                </HintItem>
                <HintItem label="Close">
                  <Dialog.Close className="p-1 rounded hover:bg-element-hover text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    <X size={11} />
                  </Dialog.Close>
                </HintItem>
              </div>
            </HintGroup>
          </div>

          {/* Toolbar — tabs with counts + search. */}
          <div className="flex items-center gap-1 px-2 h-[40px] shrink-0 border-b border-border">
            {(
              [
                ["members", "Members", members.length],
                ["invitations", "Invitations", invitations.length],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 h-[40px] text-xs font-medium transition-colors border-b-2 -mb-px cursor-pointer",
                  tab === id
                    ? "text-foreground border-b-[var(--primary)]"
                    : "text-secondary-foreground hover:text-foreground border-b-transparent",
                )}
              >
                {label}
                <span className="text-3xs text-muted-foreground tabular-nums">{count}</span>
              </button>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 h-6 rounded-md border border-border bg-card px-2 min-w-[200px] focus-within:border-[var(--atlas-border-strong)]">
              <Search size={11} className="text-muted-foreground shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people…"
                className="flex-1 min-w-0 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Invite bar — admin only; the API refuses anyone else anyway. */}
          {isAdmin && (
            <div className="flex items-center gap-2 px-3 h-[44px] shrink-0 border-b border-border">
              <UserPlus size={12} className="text-muted-foreground shrink-0" />
              <EmailChipsInput
                emails={inviteEmails}
                draft={emailDraft}
                onEmailsChange={setInviteEmails}
                onDraftChange={setEmailDraft}
                onSubmit={() => void submitInvite()}
              />
              <RolePicker
                role={inviteRole}
                onSelect={setInviteRole}
                trigger={
                  <button className="flex items-center gap-1 h-7 rounded-md border border-border bg-card px-2 text-xs text-secondary-foreground hover:text-foreground transition-colors cursor-pointer shrink-0">
                    {ROLE_LABELS[inviteRole]}
                  </button>
                }
              />
              <button
                disabled={pendingInvites.length === 0 || invalidInvites.length > 0 || inviting}
                title={
                  invalidInvites.length > 0
                    ? `Not a valid email: ${invalidInvites.join(", ")}`
                    : undefined
                }
                onClick={() => void submitInvite()}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium leading-none text-foreground cursor-pointer transition-colors hover:bg-[var(--atlas-element-hover)] disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
              >
                {inviting ? <Loader2 size={11} className="animate-spin" /> : <UserPlus size={11} />}
                Invite
                {pendingInvites.length > 1 && ` ${pendingInvites.length}`}
              </button>
            </div>
          )}

          {/* Table */}
          <div className="flex-1 min-h-0 relative">
            <div className="absolute inset-0 overflow-auto hide-scrollbar">
              <div style={{ minWidth: TABLE_MIN_W }}>
                <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-border bg-background px-3 text-2xs uppercase tracking-wider text-muted-foreground">
                  <span className={COL.person}>{tab === "members" ? "Person" : "Email"}</span>
                  <span className={COL.role}>Role</span>
                  <span className={COL.joined}>{tab === "members" ? "Joined" : "Status"}</span>
                  <span className={COL.actions} />
                </div>

                {!signedIn ? (
                  <div className="grid place-items-center h-[160px] text-xs text-muted-foreground px-6 text-center">
                    Sign in to manage this organization's members.
                  </div>
                ) : firstLoad ? (
                  <div className="grid place-items-center h-[160px] text-xs text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" />
                  </div>
                ) : roster?.error && members.length === 0 ? (
                  <div className="grid place-items-center h-[160px] text-xs text-muted-foreground px-6 text-center">
                    {roster.error}
                  </div>
                ) : tab === "members" ? (
                  filteredMembers.length === 0 ? (
                    <div className="grid place-items-center h-[160px] text-xs text-muted-foreground">
                      {query ? "No people match." : "No members yet."}
                    </div>
                  ) : (
                    filteredMembers.map((m) => (
                      <MemberRow
                        key={m.id}
                        member={m}
                        isAdmin={isAdmin}
                        isSelf={snapshot.status === "signed-in" && snapshot.user?.id === m.userId}
                        soleAdmin={soleAdmin}
                        onRole={(role) => orgId && void setRole(orgId, m.id, role)}
                        onRemove={() => orgId && void remove(orgId, m)}
                        onLeave={() => setConfirmLeave(true)}
                      />
                    ))
                  )
                ) : filteredInvites.length === 0 ? (
                  <div className="grid place-items-center h-[160px] text-xs text-muted-foreground">
                    {query ? "No invites match." : "No pending invitations."}
                  </div>
                ) : (
                  filteredInvites.map((i) => (
                    <InviteRow
                      key={i.id}
                      invite={i}
                      isAdmin={isAdmin}
                      onCancel={() => orgId && void cancelInvite(orgId, i.id)}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
          <LeaveOrgDialog
            orgName={org.name}
            onlyOrg={orgCount <= 1}
            open={confirmLeave}
            leaving={leaving}
            onCancel={() => setConfirmLeave(false)}
            onConfirm={() => void leave()}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * "Leave Acme?" — the confirmation in front of a leave.
 *
 * Nested in the members dialog rather than replacing it, so Cancel lands you
 * back on the roster you were reading. Says what is lost and that coming back
 * takes an invitation, which is the part a misclick most needs to hear.
 */
function LeaveOrgDialog({
  orgName,
  onlyOrg,
  open,
  leaving,
  onCancel,
  onConfirm,
}: {
  orgName: string;
  /** It is the only org on this desktop, so it stays as a local-only one. */
  onlyOrg: boolean;
  open: boolean;
  leaving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !leaving && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "w-[400px] max-w-[92vw] rounded-lg border border-border",
            "bg-[var(--card)] p-5 shadow-lg animate-scale-in",
          )}
        >
          <Dialog.Title className="text-md font-medium text-[var(--foreground)]">
            Leave “{orgName}”?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-[var(--secondary-foreground)]">
            You lose access to its chat, projects and shared sessions at once. Coming back takes a
            new invitation.{" "}
            {onlyOrg
              ? "It stays on this desktop as a local-only organization, with its projects."
              : "Atlas stops listing its projects here."}{" "}
            Your project files on this machine are not touched.
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={leaving}
              className="px-3 h-8 rounded-md text-sm text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={leaving}
              className="px-3 h-8 rounded-md text-sm font-medium bg-error text-destructive-foreground hover:opacity-90 transition-opacity cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {leaving && <Loader2 size={12} className="animate-spin" />}
              {leaving ? "Leaving…" : "Leave organization"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MemberRow({
  member,
  isAdmin,
  isSelf,
  soleAdmin,
  onRole,
  onRemove,
  onLeave,
}: {
  member: OrgMember;
  isAdmin: boolean;
  isSelf: boolean;
  /** The viewer is the org's only admin. */
  soleAdmin: boolean;
  onRole: (role: Role) => void;
  onRemove: () => void;
  /** Ask to leave — the caller confirms first. */
  onLeave: () => void;
}) {
  const access = memberRowAccess({ member, isAdmin, isSelf, soleAdmin });
  const roleLabel = member.role ? ROLE_LABELS[member.role] : null;

  return (
    <div className="border-b border-border-subtle">
      <div className="w-full flex items-center h-[40px] px-3 text-left transition-colors hover:bg-element-hover">
        <span className={cn(COL.person, "flex items-center gap-2 min-w-0")}>
          {/* A LOCAL cache path, resolved in Rust — the remote photo URL is
              never handed to the frontend. `null` falls back to initials. */}
          <AccountAvatar
            user={{
              id: member.userId,
              name: member.name,
              email: member.email,
              avatarPath: member.avatarPath,
            }}
            size={20}
          />
          <span className="min-w-0">
            <span className="block truncate text-sm text-foreground">
              {member.name || member.email}
              {isSelf && <span className="ml-1.5 text-2xs text-muted-foreground">You</span>}
            </span>
            {member.name && (
              <span className="block truncate text-2xs text-muted-foreground">{member.email}</span>
            )}
          </span>
        </span>
        <span className={cn(COL.role, "text-xs text-secondary-foreground")}>
          {/* Owner isn't a role, so a demoted Owner shows both. */}
          {member.isOwner
            ? member.role === "admin" || !roleLabel
              ? "Owner"
              : `Owner · ${roleLabel}`
            : (roleLabel ?? "—")}
        </span>
        <span className={cn(COL.joined, "text-2xs text-muted-foreground")}>
          {timeAgo(member.createdAt, { suffix: true }) || "—"}
        </span>
        <span className={cn(COL.actions, "flex items-center justify-end")}>
          {access.menu && (
            <DropdownMenu.Root>
              <Hint label={access.roles ? "Manage" : "Options"}>
                <DropdownMenu.Trigger
                  render={
                    <button
                      type="button"
                      aria-label={`${access.roles ? "Manage" : "Options for"} ${member.name || member.email}`}
                      className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] transition-colors cursor-pointer"
                    >
                      <MoreHorizontal size={12} />
                    </button>
                  }
                />
              </Hint>
              <DropdownMenu.Portal>
                <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
                  <DropdownMenu.Popup className="min-w-[168px] rounded-md border border-[var(--border)] bg-popover py-0.5 shadow-md text-xs text-[var(--secondary-foreground)]">
                    {access.roles && (
                      <>
                        <div className="px-2.5 py-1 text-3xs uppercase tracking-wider text-muted-foreground">
                          Role
                        </div>
                        {ROLES.map((r) => (
                          <DropdownMenu.Item
                            key={r}
                            onClick={() => onRole(r)}
                            className="px-2.5 h-6 flex items-center justify-between outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
                          >
                            {ROLE_LABELS[r]}
                            {member.role === r && <Check size={11} />}
                          </DropdownMenu.Item>
                        ))}
                        <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border)]" />
                      </>
                    )}
                    {/* Leave on your own row, Remove on anyone else's — each
                        disabled with the server's reason when it would refuse.
                        See `memberRowAccess`. */}
                    <DropdownMenu.Item
                      disabled={!access.actionAllowed}
                      onClick={access.actionAllowed ? (isSelf ? onLeave : onRemove) : undefined}
                      title={access.blockedReason ?? undefined}
                      className={cn(
                        "px-2.5 h-6 flex items-center gap-1.5 outline-none",
                        access.actionAllowed
                          ? "hover:bg-[var(--atlas-element-hover)] hover:text-error cursor-pointer"
                          : "opacity-40 cursor-not-allowed",
                      )}
                    >
                      {isSelf ? <LogOut size={11} /> : <Trash2 size={11} />}
                      {isSelf ? "Leave organization…" : "Remove from organization"}
                    </DropdownMenu.Item>
                  </DropdownMenu.Popup>
                </DropdownMenu.Positioner>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </span>
      </div>
    </div>
  );
}

function InviteRow({
  invite,
  isAdmin,
  onCancel,
}: {
  invite: OrgInvitation;
  isAdmin: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="border-b border-border-subtle">
      <div className="w-full flex items-center h-[40px] px-3 text-left transition-colors hover:bg-element-hover">
        <span className={cn(COL.person, "min-w-0 truncate text-sm text-foreground")}>
          {invite.email}
        </span>
        <span className={cn(COL.role, "text-xs text-secondary-foreground")}>
          {invite.role ? ROLE_LABELS[invite.role] : "—"}
        </span>
        <span className={cn(COL.joined, "text-2xs text-muted-foreground capitalize")}>
          {invite.status}
        </span>
        <HintGroup>
          <span className={cn(COL.actions, "flex items-center justify-end gap-0.5")}>
            {invite.acceptUrl && (
              <HintItem label="Copy invite link">
                <button
                  onClick={() => void copy(invite.acceptUrl!, "Invite link copied.")}
                  className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
                >
                  <Copy size={11} />
                </button>
              </HintItem>
            )}
            {isAdmin && (
              <HintItem label="Cancel invite">
                <button
                  onClick={onCancel}
                  className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-error transition-colors cursor-pointer"
                >
                  <X size={11} />
                </button>
              </HintItem>
            )}
          </span>
        </HintGroup>
      </div>
    </div>
  );
}

/** Split pasted/typed text on the separators people actually use between
 *  addresses — commas, semicolons, and any whitespace including newlines. */
function splitEmails(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Deliberately loose. The server is the authority on deliverability; this only
 *  catches the shapes that are obviously not an address, so a chip turns red
 *  before a round trip rather than instead of one. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Gmail-style recipient input: committed addresses become chips, the rest is a
 * free-typing draft. Commits on comma / Enter / Tab / blur / paste, and
 * Backspace on an empty draft eats the last chip.
 *
 * The draft is owned by the PARENT so that pressing Invite with a half-typed
 * address still sends it — the most common way to lose an invite is a field
 * that only counts what you remembered to press comma after.
 */
function EmailChipsInput({
  emails,
  draft,
  onEmailsChange,
  onDraftChange,
  onSubmit,
}: {
  emails: string[];
  draft: string;
  onEmailsChange: (next: string[]) => void;
  onDraftChange: (next: string) => void;
  onSubmit: () => void;
}) {
  const commit = (raw: string) => {
    const next = dedupe([...emails, ...splitEmails(raw)]);
    onEmailsChange(next);
    onDraftChange("");
  };

  return (
    <div
      // FIXED height, never `min-h` + wrap: the bar must not grow the moment a
      // chip appears. Overflowing chips scroll sideways instead.
      className="flex-1 min-w-0 flex items-center gap-1 h-7 rounded-md border border-border bg-card px-1.5 overflow-x-auto hide-scrollbar focus-within:border-[var(--atlas-border-strong)] cursor-text"
      onClick={(e) => {
        // Clicking the padding should focus the field, like a real input.
        const input = e.currentTarget.querySelector("input");
        input?.focus();
      }}
    >
      {emails.map((email) => {
        const valid = isEmail(email);
        return (
          <span
            key={email}
            className={cn(
              // h-5 + a 14px avatar keeps the chip inside the 28px field.
              "inline-flex shrink-0 items-center gap-1 rounded-full border pl-0.5 pr-1 h-5 text-xs max-w-[220px]",
              valid ? "border-border bg-background text-foreground" : "border-error text-error",
            )}
          >
            <AccountAvatar user={{ id: email, name: "", email, avatarPath: null }} size={14} />
            {/* The title sits on the text rather than the chip, so it doesn't
                open over the remove button's own tooltip. */}
            <span className="truncate" title={valid ? email : "Not a valid email address"}>
              {email}
            </span>
            <Hint label="Remove">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEmailsChange(emails.filter((x) => x !== email));
                }}
                className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-label={`Remove ${email}`}
              >
                <X size={9} />
              </button>
            </Hint>
          </span>
        );
      })}
      <input
        value={draft}
        onChange={(e) => {
          // Typing a separator commits, so pasting "a@b.com," lands as a chip.
          if (/[,;]/.test(e.target.value)) commit(e.target.value);
          else onDraftChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (draft.trim()) commit(draft);
            else onSubmit();
            return;
          }
          if (e.key === "Tab" && draft.trim()) {
            e.preventDefault();
            commit(draft);
            return;
          }
          if (e.key === "Backspace" && !draft && emails.length > 0) {
            onEmailsChange(emails.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (!/[,;\s]/.test(text)) return; // a single address — let it type
          e.preventDefault();
          commit(draft + text);
        }}
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={emails.length === 0 ? "teammate@company.com, …" : ""}
        className="flex-1 shrink-0 min-w-[120px] h-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
      />
    </div>
  );
}

/** Role dropdown shared by the invite bar. */
function RolePicker({
  role,
  onSelect,
  trigger,
}: {
  role: Role;
  onSelect: (role: Role) => void;
  trigger: React.ReactElement;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger render={trigger} />
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
          <DropdownMenu.Popup className="min-w-[150px] rounded-md border border-[var(--border)] bg-popover py-0.5 shadow-md text-xs text-[var(--secondary-foreground)]">
            {ROLES.map((r) => (
              <DropdownMenu.Item
                key={r}
                onClick={() => onSelect(r)}
                className="px-2.5 h-6 flex items-center justify-between outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
              >
                {ROLE_LABELS[r]}
                {role === r && <Check size={11} />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Both call sites copy *after* an await — the invite round-trip, or a click
 * handler that already yielded — so this must go through `copyText`, which
 * falls back to the native pasteboard when WKWebView has dropped the user
 * activation the web clipboard API demands.
 */
async function copy(text: string, success: string) {
  if (await copyText(text)) toast.success(success);
  else toast.error("Couldn't copy to the clipboard.");
}
