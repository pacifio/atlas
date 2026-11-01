// The chat header's remote-control indicator: a status dot, a word, and the
// viewer count while a room is live — or, while someone else holds the seat,
// their name. Rendered only while the session has a room (or just lost one),
// in the header's own pill treatment — the same box the pinned-messages
// count uses.
//
// Clicking it copies the viewer link; on an ended room it clears the
// indicator. Start, stop and "Take over" live in the header's "More" menu.

import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
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

function hintFor(control: RemoteControl): string {
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
    return `${driverLabel(control.remoteDriver)} is driving from remote control. ${who}. Only they can prompt until you take over (More menu).`;
  }
  return `Remote control is live. ${who}. Click to copy the viewer link.`;
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

export function RcStatusPill({
  control,
  className,
}: {
  control: RemoteControl;
  /** The header's shared control treatment — one height, one border. */
  className?: string;
}) {
  const room = control.room;
  if (!room) return null;
  const ended = room.state === "ended";
  return (
    <HintItem label={hintFor(control)}>
      <button
        type="button"
        onClick={ended ? control.dismiss : control.copyLink}
        aria-label={ended ? "Dismiss remote control status" : "Copy viewer link"}
        className={className}
      >
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
        <span className="text-xs leading-none">{pillLabel(control)}</span>
        {room.state === "live" && room.viewers > 0 && (
          <span className="flex items-center gap-0.5 text-xs leading-none tabular-nums">
            <Users size={11} />
            {room.viewers}
          </span>
        )}
      </button>
    </HintItem>
  );
}
