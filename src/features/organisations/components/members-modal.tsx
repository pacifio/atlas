import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { avatarSrc } from "@/features/auth/components/account-avatar";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import type { Role } from "@/features/auth/lib/roles";
import { memberRowAccess } from "../lib/member-access";
import { leaveOrgAndData } from "../lib/org-switch";
import { useMembersStore } from "../stores/members-store";
import { useOrgStore } from "../stores/org-store";
import type { Organisation } from "../types";
import { dedupe, isEmail, splitEmails } from "./views/email-chips-input";
import {
  MembersModalView,
  type MemberRowData,
  type MembersBody,
  type MembersTab,
} from "./views/members-modal-view";

/**
 * The members manager's container for a SYNCED organisation: reads the members
 * cache and the auth snapshot, and hands `MembersModalView` plain rows.
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
  const members = useMemo(() => roster?.members ?? [], [roster]);
  const invitations = roster?.invitations ?? [];
  const loading = roster?.loading ?? false;
  /** Never loaded AND currently loading — the only state that shows a
   *  placeholder instead of rows. A revalidation over cached rows must not. */
  const firstLoad = loading && (roster?.loadedAt ?? null) === null;

  const [tab, setTab] = useState<MembersTab>("members");
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
  const selfId = snapshot.status === "signed-in" ? (snapshot.user?.id ?? null) : null;

  /** How many orgs this desktop tracks: leaving the only one keeps it here
   *  as a local-only org instead of dropping it (see `leaveOrgAndData`). */
  const orgCount = useOrgStore((s) => s.organisations.length);
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

  const rows = useMemo<MemberRowData[]>(
    () =>
      members.map((m) => {
        const self = selfId === m.userId;
        return {
          id: m.id,
          name: m.name,
          email: m.email,
          role: m.role,
          isOwner: m.isOwner,
          createdAt: m.createdAt,
          // A LOCAL cache path, resolved in Rust — the remote photo URL is
          // never handed to the frontend. `null` falls back to initials.
          avatarSrc: avatarSrc(m.avatarPath),
          self,
          access: memberRowAccess({ member: m, isAdmin, isSelf: self, soleAdmin }),
        };
      }),
    [members, selfId, isAdmin, soleAdmin],
  );

  const submitInvite = async () => {
    const pending = dedupe([...inviteEmails, ...splitEmails(emailDraft)]);
    if (!orgId || pending.length === 0 || pending.some((e) => !isEmail(e))) return;
    setInviting(true);
    // Sequential, not Promise.all: every /api/auth/* path shares one
    // 100-req/60s budget, and a partial failure should still leave the invites
    // that DID land in place rather than being lost in a rejected batch.
    const sent: string[] = [];
    const links: string[] = [];
    for (const email of pending) {
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

  const body: MembersBody = !signedIn
    ? "signed-out"
    : firstLoad
      ? "first-load"
      : roster?.error && members.length === 0
        ? "error"
        : "ready";

  return (
    <MembersModalView
      open={open}
      onOpenChange={onOpenChange}
      orgName={org.name}
      body={body}
      error={roster?.error ?? null}
      refreshing={loading}
      canRefresh={signedIn}
      onRefresh={() => orgId && void load(orgId, { force: true })}
      isAdmin={isAdmin}
      tab={tab}
      onTabChange={setTab}
      members={rows}
      invitations={invitations}
      onRoleChange={(memberId, role) => orgId && void setRole(orgId, memberId, role)}
      onRemove={(memberId) => {
        const member = members.find((m) => m.id === memberId);
        if (orgId && member) void remove(orgId, member);
      }}
      onLeave={() => setConfirmLeave(true)}
      onCancelInvite={(id) => orgId && void cancelInvite(orgId, id)}
      onCopyInviteLink={(url) => void copy(url, "Invite link copied.")}
      invite={
        isAdmin
          ? {
              emails: inviteEmails,
              draft: emailDraft,
              role: inviteRole,
              sending: inviting,
              onEmailsChange: setInviteEmails,
              onDraftChange: setEmailDraft,
              onRoleChange: setInviteRole,
              onSubmit: () => void submitInvite(),
            }
          : null
      }
      leave={{
        open: confirmLeave,
        leaving,
        onlyOrg: orgCount <= 1,
        onConfirm: () => void leave(),
        onCancel: () => setConfirmLeave(false),
      }}
    />
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
