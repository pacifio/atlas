import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Copy,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import {
  ROLE_LABELS,
  type OrgInvitation,
  type OrgMember,
  type Role,
} from "@/features/auth/lib/auth-api";
import { useMembersStore } from "../stores/members-store";
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
  const { load, setRole, remove, invite, cancelInvite } =
    useMembersStore.use.actions();
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

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
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
    if (!orgId || pendingInvites.length === 0 || invalidInvites.length > 0)
      return;
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
    // Email delivery is deferred server-side, so the links ARE the invite —
    // copy them so the inviter can paste them straight out.
    if (links.length > 0) {
      void copy(
        links.join("\n"),
        links.length === 1
          ? "Invite link copied — send it to them."
          : `${links.length} invite links copied.`,
      );
    } else {
      toast.success(`Invited ${sent.join(", ")}.`);
    }
  };

  if (!org) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 bg-black/60"
          style={{ zIndex: "var(--z-overlay)" as unknown as number }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-8.5 left-4 right-4 bottom-6 rounded-xl border border-[var(--border-default)] bg-[var(--bg-sidebar)] overflow-hidden flex flex-col shadow-[var(--shadow-overlay)] focus:outline-none"
          style={{ zIndex: "var(--z-modal)" as unknown as number }}
        >
          <Dialog.Title className="sr-only">Members of {org.name}</Dialog.Title>

          {/* Header — mirrors the git-graph fullscreen bar. */}
          <div className="flex items-center justify-between px-3 h-[32px] shrink-0 border-b border-border-subtle">
            <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">
              {org.name} · {members.length}{" "}
              {members.length === 1 ? "member" : "members"}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                disabled={!signedIn}
                onClick={() => orgId && void load(orgId, { force: true })}
                className={cn(
                  "p-1 rounded text-text-tertiary transition-colors",
                  signedIn
                    ? "hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                    : "opacity-40 cursor-not-allowed",
                  loading && "animate-spin",
                )}
                title={signedIn ? "Refresh" : "Sign in to refresh"}
              >
                <RefreshCw size={11} />
              </button>
              <Dialog.Close
                className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X size={11} />
              </Dialog.Close>
            </div>
          </div>

          {/* Toolbar — tabs with counts + search. */}
          <div className="flex items-center gap-1 px-2 h-[40px] shrink-0 border-b border-border-default">
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
                  "flex items-center gap-1.5 px-2.5 h-[40px] text-[11px] font-medium transition-colors border-b-2 -mb-px cursor-pointer",
                  tab === id
                    ? "text-text-primary border-b-[var(--accent-primary)]"
                    : "text-text-secondary hover:text-text-primary border-b-transparent",
                )}
              >
                {label}
                <span className="text-[9px] text-text-tertiary tabular-nums">
                  {count}
                </span>
              </button>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 h-6 rounded-md border border-border-default bg-bg-elevated px-2 min-w-[200px] focus-within:border-[var(--border-focus)]">
              <Search size={11} className="text-text-tertiary shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people…"
                className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
              />
            </div>
          </div>

          {/* Invite bar — admin only; the API refuses anyone else anyway. */}
          {isAdmin && (
            <div className="flex items-center gap-2 px-3 h-[44px] shrink-0 border-b border-border-default">
              <UserPlus size={12} className="text-text-tertiary shrink-0" />
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
                  <button className="flex items-center gap-1 h-7 rounded-md border border-border-default bg-bg-elevated px-2 text-[11px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer shrink-0">
                    {ROLE_LABELS[inviteRole]}
                  </button>
                }
              />
              <button
                disabled={
                  pendingInvites.length === 0 ||
                  invalidInvites.length > 0 ||
                  inviting
                }
                title={
                  invalidInvites.length > 0
                    ? `Not a valid email: ${invalidInvites.join(", ")}`
                    : undefined
                }
                onClick={() => void submitInvite()}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] font-medium leading-none text-text-primary cursor-pointer transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
              >
                {inviting ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <UserPlus size={11} />
                )}
                Invite
                {pendingInvites.length > 1 && ` ${pendingInvites.length}`}
              </button>
            </div>
          )}

          {/* Table */}
          <div className="flex-1 min-h-0 relative">
            <div className="absolute inset-0 overflow-auto hide-scrollbar">
              <div style={{ minWidth: TABLE_MIN_W }}>
                <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-border-default bg-bg-base px-3 text-[10px] uppercase tracking-wider text-text-tertiary">
                  <span className={COL.person}>
                    {tab === "members" ? "Person" : "Email"}
                  </span>
                  <span className={COL.role}>Role</span>
                  <span className={COL.joined}>
                    {tab === "members" ? "Joined" : "Status"}
                  </span>
                  <span className={COL.actions} />
                </div>

                {!signedIn ? (
                  <div className="grid place-items-center h-[160px] text-[11px] text-text-tertiary px-6 text-center">
                    Sign in to manage this organisation's members.
                  </div>
                ) : firstLoad ? (
                  <div className="grid place-items-center h-[160px] text-[11px] text-text-tertiary">
                    <Loader2 size={14} className="animate-spin" />
                  </div>
                ) : roster?.error && members.length === 0 ? (
                  <div className="grid place-items-center h-[160px] text-[11px] text-text-tertiary px-6 text-center">
                    {roster.error}
                  </div>
                ) : tab === "members" ? (
                  filteredMembers.length === 0 ? (
                    <div className="grid place-items-center h-[160px] text-[11px] text-text-tertiary">
                      {query ? "No people match." : "No members yet."}
                    </div>
                  ) : (
                    filteredMembers.map((m) => (
                      <MemberRow
                        key={m.id}
                        member={m}
                        isAdmin={isAdmin}
                        isSelf={
                          snapshot.status === "signed-in" &&
                          snapshot.user?.id === m.userId
                        }
                        onRole={(role) =>
                          orgId && void setRole(orgId, m.id, role)
                        }
                        onRemove={() => orgId && void remove(orgId, m)}
                      />
                    ))
                  )
                ) : filteredInvites.length === 0 ? (
                  <div className="grid place-items-center h-[160px] text-[11px] text-text-tertiary">
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MemberRow({
  member,
  isAdmin,
  isSelf,
  onRole,
  onRemove,
}: {
  member: OrgMember;
  isAdmin: boolean;
  isSelf: boolean;
  onRole: (role: Role) => void;
  onRemove: () => void;
}) {
  /** An admin removing themselves could leave the org with no admin at all —
   *  nobody able to invite, change roles, or delete it. Removing OTHER people
   *  (including other admins) stays allowed; it's only self-removal that can
   *  strand the org. */
  const canLeave = !(isSelf && member.role === "admin");

  return (
    <div className="border-b border-border-subtle">
      <div className="w-full flex items-center h-[40px] px-3 text-left transition-colors hover:bg-bg-hover">
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
            <span className="block truncate text-[12px] text-text-primary">
              {member.name || member.email}
              {isSelf && (
                <span className="ml-1.5 text-[10px] text-text-tertiary">
                  You
                </span>
              )}
            </span>
            {member.name && (
              <span className="block truncate text-[10px] text-text-tertiary">
                {member.email}
              </span>
            )}
          </span>
        </span>
        <span className={cn(COL.role, "text-[11px] text-text-secondary")}>
          {member.role ? ROLE_LABELS[member.role] : "—"}
        </span>
        <span className={cn(COL.joined, "text-[10px] text-text-tertiary")}>
          {timeAgo(member.createdAt, { suffix: true }) || "—"}
        </span>
        <span className={cn(COL.actions, "flex items-center justify-end")}>
          {isAdmin && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary outline-none transition-colors cursor-pointer"
                  title="Manage"
                >
                  <MoreHorizontal size={12} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-[var(--z-max)] min-w-[168px] rounded-md border border-[var(--border-default)] bg-black py-0.5 shadow-[var(--shadow-overlay)] text-[11px] text-[var(--text-secondary)]"
                >
                  <div className="px-2.5 py-1 text-[9px] uppercase tracking-wider text-text-tertiary">
                    Role
                  </div>
                  {ROLES.map((r) => (
                    <DropdownMenu.Item
                      key={r}
                      onSelect={() => onRole(r)}
                      className="px-2.5 h-6 flex items-center justify-between outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      {ROLE_LABELS[r]}
                      {member.role === r && <Check size={11} />}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border-default)]" />
                  {/* An admin can't leave: doing so could strip the org of its
                      last admin, leaving nobody able to invite, change roles or
                      delete it. Hand the role over first. */}
                  <DropdownMenu.Item
                    disabled={!canLeave}
                    onSelect={canLeave ? onRemove : undefined}
                    title={
                      canLeave
                        ? undefined
                        : "Admins can't leave — give someone else the Admin role first."
                    }
                    className={cn(
                      "px-2.5 h-6 flex items-center gap-1.5 outline-none",
                      canLeave
                        ? "hover:bg-[var(--bg-hover)] hover:text-[var(--status-error,#f44)] cursor-pointer"
                        : "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <Trash2 size={11} />
                    {isSelf ? "Leave organisation" : "Remove from organisation"}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
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
      <div className="w-full flex items-center h-[40px] px-3 text-left transition-colors hover:bg-bg-hover">
        <span
          className={cn(
            COL.person,
            "min-w-0 truncate text-[12px] text-text-primary",
          )}
        >
          {invite.email}
        </span>
        <span className={cn(COL.role, "text-[11px] text-text-secondary")}>
          {invite.role ? ROLE_LABELS[invite.role] : "—"}
        </span>
        <span
          className={cn(
            COL.joined,
            "text-[10px] text-text-tertiary capitalize",
          )}
        >
          {invite.status}
        </span>
        <span
          className={cn(COL.actions, "flex items-center justify-end gap-0.5")}
        >
          {invite.acceptUrl && (
            <button
              onClick={() =>
                void copy(invite.acceptUrl!, "Invite link copied.")
              }
              className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
              title="Copy invite link"
            >
              <Copy size={11} />
            </button>
          )}
          {isAdmin && (
            <button
              onClick={onCancel}
              className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-[var(--status-error,#f44)] transition-colors cursor-pointer"
              title="Cancel invite"
            >
              <X size={11} />
            </button>
          )}
        </span>
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
      className="flex-1 min-w-0 flex items-center gap-1 h-7 rounded-md border border-border-default bg-bg-elevated px-1.5 overflow-x-auto hide-scrollbar focus-within:border-[var(--border-focus)] cursor-text"
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
            title={valid ? email : "Not a valid email address"}
            className={cn(
              // h-5 + a 14px avatar keeps the chip inside the 28px field.
              "inline-flex shrink-0 items-center gap-1 rounded-full border pl-0.5 pr-1 h-5 text-[11px] max-w-[220px]",
              valid
                ? "border-border-default bg-bg-base text-text-primary"
                : "border-error text-error",
            )}
          >
            <AccountAvatar
              user={{ id: email, name: "", email, avatarPath: null }}
              size={14}
            />
            <span className="truncate">{email}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEmailsChange(emails.filter((x) => x !== email));
              }}
              className="shrink-0 rounded-full p-0.5 text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
              aria-label={`Remove ${email}`}
            >
              <X size={9} />
            </button>
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
        className="flex-1 shrink-0 min-w-[120px] h-full bg-transparent text-[11px] text-text-primary placeholder:text-text-tertiary outline-none"
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
  trigger: React.ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[var(--z-max)] min-w-[150px] rounded-md border border-[var(--border-default)] bg-black py-0.5 shadow-[var(--shadow-overlay)] text-[11px] text-[var(--text-secondary)]"
        >
          {ROLES.map((r) => (
            <DropdownMenu.Item
              key={r}
              onSelect={() => onSelect(r)}
              className="px-2.5 h-6 flex items-center justify-between outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              {ROLE_LABELS[r]}
              {role === r && <Check size={11} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

async function copy(text: string, success: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Couldn't copy to the clipboard.");
  }
}
