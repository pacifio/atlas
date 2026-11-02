/**
 * One chat's Universal RC controls: its room (from the mirror) and what the
 * header can do with it — start, stop, copy the viewer link, take the seat
 * back, answer a request to drive. The room itself is Rust's; this only asks
 * and reports.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
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
    copyLink,
    takeOver,
    answerControl,
    shareWith,
    share,
    membersDrive,
    setMembersDrive,
    dismiss,
  };
}
