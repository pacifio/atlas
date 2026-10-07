/**
 * Who else is here — a row of faces, each with the online dot,
 * in the Timeline's header.
 *
 * The web Timeline shows the same thing on every face it draws; the desktop
 * received the roster and dropped it. Sits beside the "Timeline" label because
 * it answers the question that label raises — whose work is this, and who can
 * I ask about it right now.
 */

import { memo } from "react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import type { OrgMember } from "@/features/auth/lib/auth-api";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";

import { avatarUser } from "./comment-thread";

/** Faces before the stack becomes a count. Four reads as a group at 16px. */
export const MAX_ONLINE_FACES = 4;
const FACE_PX = 16;

/**
 * The green dot, ringed in the surface it sits on so it reads as cut out of
 * the photo. Sized by the caller: a 10px byline face and a 16px stack face
 * want different dots.
 */
export function OnlineDot({ px, className }: { px: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: px, height: px }}
      className={cn(
        "absolute -bottom-px -right-px rounded-full bg-[var(--atlas-status-success-foreground)] ring-1 ring-[var(--background)]",
        className,
      )}
    />
  );
}

/** "Ada, Grace and 3 others are online" — the stack's accessible name. */
export function onlineLabel(members: OrgMember[]): string {
  const names = members.map((m) => m.name || m.email);
  if (names.length === 0) return "Nobody else is online";
  if (names.length === 1) return `${names[0]} is online`;
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are online`;
  }
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others are online`;
}

export const OnlineTeammates = memo(function OnlineTeammates({
  members,
}: {
  members: OrgMember[];
}) {
  if (members.length === 0) return null;
  const shown = members.slice(0, MAX_ONLINE_FACES);
  const extra = members.length - shown.length;
  const label = onlineLabel(members);

  return (
    <Hint
      label={
        <span className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Online now</span>
          {members.map((m) => (
            <span key={m.userId}>{m.name || m.email}</span>
          ))}
        </span>
      }
    >
      <span
        role="img"
        aria-label={label}
        tabIndex={0}
        className="flex shrink-0 items-center gap-1 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
      >
        {/* Side by side, not overlapped: every face carries its dot in the
         *  bottom-right corner, and an overlapping stack would bury each dot
         *  under the next face — the one thing this row exists to show. */}
        <span className="flex items-center gap-0.5">
          {shown.map((m) => (
            <span key={m.userId} className="relative inline-flex rounded-full">
              <AccountAvatar user={avatarUser(m)} size={FACE_PX} />
              <OnlineDot px={6} />
            </span>
          ))}
        </span>
        {extra > 0 && (
          <span className="text-2xs tabular-nums text-[var(--muted-foreground)]">+{extra}</span>
        )}
      </span>
    </Hint>
  );
});
