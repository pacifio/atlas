/**
 * One chat's Universal RC controls: its room (from the mirror) and what the
 * header can do with it — start, stop, copy the viewer link, take the seat
 * back, answer a request to drive. The room itself is Rust's; this only asks
 * and reports.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { TOAST_GLYPHS } from "@/components/toast-icons";
import { confirm } from "@/lib/confirm";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { errInfo } from "./agent-signin";
import { drivenElsewhere, driverLabel, rc, type RcDriver, type RcRoom } from "./rc-api";
import { ensureRcMirror } from "./rc-mirror";
import { useRcRoom, useRcStore } from "../stores/rc-store";

export interface RemoteControl {
  room: RcRoom | undefined;
  /** A room is open (or opening) for this session. */
  active: boolean;
  /** Someone other than this account holds the seat; the composer is theirs. */
  remoteDriver: RcDriver | null;
  busy: boolean;
  start: () => void;
  stop: () => void;
  /** Owner: delete the room outright (asks first). Stop closes the door and
   *  the next start reopens the same room; delete demolishes it — the link
   *  dies, invites go, and the next start makes a new room. */
  remove: () => void;
  copyLink: () => void;
  /** Owner: take the seat back. */
  takeOver: () => void;
  /** Owner: answer a visitor's request to drive. */
  answerControl: (requestId: string, approve: boolean) => void;
  /** The cloud Organisation Atlas now targets, when the room is solo and
   *  could be shared with it — `null` otherwise (no room, already shared, a
   *  local-only Organisation, signed out). Rust decides whether the account
   *  really belongs to it; this only knows whether to offer. */
  shareWith: { name: string } | null;
  /** Owner: share the solo room with `shareWith`. Set once; Rust refuses a
   *  second scope. */
  share: () => void;
  /** Invited members may prompt and ask for the seat (tier `steer`), not
   *  only watch. Meaningful once the room is shared. */
  membersDrive: boolean;
  /** Owner: turn that on or off for this room. */
  setMembersDrive: (on: boolean) => void;
  /** Owner: hand the seat to a connected person, without their asking. */
  grant: (principalId: string, label: string) => void;
  /** Owner: drop a person's connections; a driver so removed loses the seat. */
  kick: (principalId: string, label: string) => void;
  /** Owner: whether visitors may ask to drive. Off declines every open ask. */
  setAcceptRequests: (on: boolean) => void;
  /** Owner: invite a teammate from the room's Organisation. Resolves when the
   *  server has the invite, so the caller can re-read who is invited. */
  invite: (userId: string, label: string) => Promise<boolean>;
  /** Owner: withdraw an invite (and drop them if they are here). */
  revokeInvite: (userId: string, label: string) => Promise<boolean>;
  dismiss: () => void;
}

async function copyViewerLink(url: string) {
  if (await copyText(url)) toast.success("Viewer link copied");
  else toast.error("Could not copy the link to the clipboard");
}

export function useRemoteControl(sessionId: string, title: string): RemoteControl {
  useEffect(() => ensureRcMirror(), []);
  const room = useRcRoom(sessionId || null);
  const [busy, setBusy] = useState(false);
  const active = !!room && room.state !== "ended";
  const remoteDriver = drivenElsewhere(room);
  const signedIn = useAuthStore((s) => s.snapshot.status === "signed-in");
  const activeOrg = useOrgStore((s) =>
    s.organisations.find((o) => o.id === s.activeOrganisationId),
  );
  const shareWith =
    active && room.scope === null && signedIn && activeOrg?.remoteId
      ? { name: activeOrg.name }
      : null;

  const start = useCallback(() => {
    if (!sessionId || busy) return;
    setBusy(true);
    rc.start(sessionId, title)
      .then((started) => {
        toast.success("Remote control is on", {
          description: "Open the viewer link on your phone to watch and steer this session.",
          action: { label: "Copy link", onClick: () => void copyViewerLink(started.viewerUrl) },
          // The bare glyph, which drops the toaster's copy-the-message button
          // (`toast-icons.tsx`): beside "Copy link" it read as a second way to
          // copy the link, and copied the sentence instead.
          icon: TOAST_GLYPHS.success,
        });
        // The room opened; only the sharing did not. Said, never blocking.
        if (started.note) toast.info(started.note);
      })
      .catch((e) => toast.error(errInfo(e).message))
      .finally(() => setBusy(false));
  }, [sessionId, title, busy]);

  const stop = useCallback(() => {
    if (!sessionId || busy) return;
    setBusy(true);
    rc.stop(sessionId)
      .then(() => toast.success("Remote control is off"))
      .catch((e) => toast.error(errInfo(e).message))
      .finally(() => setBusy(false));
  }, [sessionId, busy]);

  const remove = useCallback(() => {
    if (!sessionId || busy) return;
    const watching = room && room.state !== "ended" ? room.viewers : 0;
    void confirm({
      title: "Delete this room?",
      body:
        (watching > 0
          ? `${watching} ${watching === 1 ? "person" : "people"} watching will be disconnected. `
          : "") +
        "The viewer link stops working, and starting remote control on this session again makes a new room with a new link. The session itself is untouched.",
      confirmLabel: "Delete room",
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      setBusy(true);
      rc.delete(sessionId)
        .then(() => {
          useRcStore.getState().actions.forget(sessionId);
          toast.success("Room deleted");
        })
        .catch((e) => toast.error(errInfo(e).message))
        .finally(() => setBusy(false));
    });
  }, [sessionId, busy, room]);

  // The room's title follows the session's: a rename, or the agent's own
  // title landing after the first turn. Sent when the room comes up here
  // (the start carried a title, but the agent's may have landed during the
  // round-trip — one idempotent PATCH covers it) and on every change after,
  // while the room stands.
  const sentTitle = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !sessionId) {
      sentTitle.current = null;
      return;
    }
    if (title === sentTitle.current) return;
    sentTitle.current = title;
    rc.setTitle(sessionId, title).catch(() => {
      // Best effort: the list shows the old name until the next change.
    });
  }, [active, sessionId, title]);

  const copyLink = useCallback(() => {
    if (room) void copyViewerLink(room.viewerUrl);
  }, [room]);

  const takeOver = useCallback(() => {
    if (!sessionId || busy) return;
    setBusy(true);
    rc.takeOver(sessionId)
      .then(() => toast.success("You are driving again"))
      .catch((e) => toast.error(errInfo(e).message))
      .finally(() => setBusy(false));
  }, [sessionId, busy]);

  const answerControl = useCallback(
    (requestId: string, approve: boolean) => {
      if (!sessionId) return;
      const request = room?.pending.find((r) => r.requestId === requestId);
      rc.answerControl(sessionId, requestId, approve)
        .then(() => {
          if (approve && request) {
            toast.success(`${driverLabel(request)} is driving`, {
              description:
                "Only they can prompt now. Take over any time from the pill in the title bar.",
            });
          }
        })
        .catch((e) => toast.error(errInfo(e).message));
    },
    [sessionId, room],
  );

  const share = useCallback(() => {
    if (!sessionId || busy || !shareWith) return;
    setBusy(true);
    rc.setScope(sessionId)
      .then((scope) => {
        if (scope) {
          toast.success(`Shared with ${shareWith.name}`, {
            description: "People of this organisation can now be invited to watch and steer.",
          });
        } else {
          toast.info("This room stays personal", {
            description: "The organisation Atlas targets is not one this account belongs to.",
          });
        }
      })
      .catch((e) => toast.error(errInfo(e).message))
      .finally(() => setBusy(false));
  }, [sessionId, busy, shareWith]);

  const membersDrive = !!room && room.memberTier !== "view";
  const setMembersDrive = useCallback(
    (on: boolean) => {
      if (!sessionId || busy) return;
      setBusy(true);
      rc.setMemberTier(sessionId, on ? "steer" : "view")
        .then(() => toast.success(on ? "Teammates can drive" : "Teammates can watch"))
        .catch((e) => toast.error(errInfo(e).message))
        .finally(() => setBusy(false));
    },
    [sessionId, busy],
  );

  const grant = useCallback(
    (principalId: string, label: string) => {
      if (!sessionId || busy) return;
      setBusy(true);
      rc.grantControl(sessionId, principalId)
        .then(() =>
          toast.success(`${label} is driving`, {
            description: "Only they can prompt now. Take back control any time from this panel.",
          }),
        )
        .catch((e) => toast.error(errInfo(e).message))
        .finally(() => setBusy(false));
    },
    [sessionId, busy],
  );

  const kick = useCallback(
    (principalId: string, label: string) => {
      if (!sessionId || busy) return;
      setBusy(true);
      rc.kick(sessionId, principalId)
        .then(() => toast.success(`Removed ${label} from the room`))
        .catch((e) => toast.error(errInfo(e).message))
        .finally(() => setBusy(false));
    },
    [sessionId, busy],
  );

  const setAcceptRequests = useCallback(
    (on: boolean) => {
      if (!sessionId || busy) return;
      setBusy(true);
      rc.setAcceptRequests(sessionId, on)
        .catch((e) => toast.error(errInfo(e).message))
        .finally(() => setBusy(false));
    },
    [sessionId, busy],
  );

  const invite = useCallback(
    async (userId: string, label: string) => {
      if (!sessionId) return false;
      try {
        await rc.invite(sessionId, userId);
        toast.success(`Invited ${label}`, {
          description: "They can open the viewer link now.",
        });
        return true;
      } catch (e) {
        toast.error(errInfo(e).message);
        return false;
      }
    },
    [sessionId],
  );

  const revokeInvite = useCallback(
    async (userId: string, label: string) => {
      if (!sessionId) return false;
      try {
        await rc.revokeInvite(sessionId, userId);
        toast.success(`${label} is no longer invited`);
        return true;
      } catch (e) {
        toast.error(errInfo(e).message);
        return false;
      }
    },
    [sessionId],
  );

  const dismiss = useCallback(() => {
    if (sessionId) useRcStore.getState().actions.forget(sessionId);
  }, [sessionId]);

  return {
    room,
    active,
    remoteDriver,
    busy,
    start,
    stop,
    remove,
    copyLink,
    takeOver,
    answerControl,
    shareWith,
    share,
    membersDrive,
    setMembersDrive,
    grant,
    kick,
    setAcceptRequests,
    invite,
    revokeInvite,
    dismiss,
  };
}
