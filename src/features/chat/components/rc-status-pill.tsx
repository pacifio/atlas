// The title bar's remote-control indicator: a status dot, a word, and the
// viewer count while a room is live — or, while someone else holds the seat,
// their name. Shown only while the session has a room (or just lost one), in
// the same ghost-button pill the pinned-messages count uses; it is the
// trigger of the room's menu (`rc-header-menu.tsx`), which holds Take over,
// Copy viewer link, Share and Stop. Start lives in the Details card.

import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { driverLabel, type RcLinkState } from "../lib/rc-api";
import type { RemoteControl } from "../lib/use-remote-control";

const DOT: Record<RcLinkState, string> = {
  connecting: "bg-[var(--atlas-status-warning-foreground)]",
  live: "bg-[var(--atlas-status-success-foreground)] atlas-live-pulse",
  offline: "bg-[var(--atlas-status-warning-foreground)]",
  ended: "bg-[var(--muted-foreground)]",
};

const LABEL: Record<RcLinkState, string> = {
  connecting: "Connecting",
  live: "Live",
  offline: "Offline",
  ended: "Ended",
};

/** The pill's hover text: the room's state, in a sentence. */
export function hintFor(control: RemoteControl): string {
  const room = control.room;
  if (!room) return "";
  if (room.state === "ended") {
    return room.lastError ? `Remote control ended: ${room.lastError}` : "Remote control ended";
  }
  if (room.state === "offline") {
    return room.lastError
      ? `Reconnecting to the room (${room.lastError}). Viewers see you as offline.`
      : "Reconnecting to the room. Viewers see you as offline.";
  }
  if (room.state === "connecting") return "Connecting to the room";
  const who = room.viewers === 0 ? "No one watching" : `${room.viewers} watching`;
  if (control.remoteDriver) {
    return `${driverLabel(control.remoteDriver)} is driving from remote control. ${who}. Only they can prompt until you take over from this menu.`;
  }
  return `Remote control is live. ${who}. Options for the room.`;
}

/** The pill's word: the link state, or the driver while it is someone else. */
export function pillLabel(control: RemoteControl): string {
  const room = control.room;
  if (!room) return "";
  if (room.state === "live" && control.remoteDriver) {
    return `${driverLabel(control.remoteDriver)} driving`;
  }
  return LABEL[room.state];
}

/** The pill's contents — dot, word, viewer count — for the trigger button
 *  the menu wraps around them. Renders nothing without a room. */
export function RcStatusPill({ control }: { control: RemoteControl }) {
  const room = control.room;
  if (!room) return null;
  return (
    <>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", DOT[room.state])}
        style={
          room.state === "live"
            ? {
                ["--atlas-pulse-color" as string]:
                  "color-mix(in oklab, var(--atlas-status-success-foreground) 40%, transparent)",
              }
            : undefined
        }
      />
      <span>{pillLabel(control)}</span>
      {room.state === "live" && room.viewers > 0 && (
        <span className="flex items-center gap-0.5 tabular-nums">
          <Users size={12} />
          {room.viewers}
        </span>
      )}
    </>
  );
}
