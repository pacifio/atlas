import { memo } from "react";
import { cn } from "@/lib/utils";
import { avatarHue, initials } from "../lib/derive";
import type { OrgMemberProfile } from "../types";

/**
 * A member's face, with an optional presence dot.
 *
 * The hue derivation matches `AccountAvatar` deliberately — the same person must
 * be the same colour in the titlebar and in a chat bubble, and two derivations
 * would eventually disagree.
 *
 * Presence is binary on purpose. The API has no `last_seen` and will never have
 * one, so there is no "active 5m ago" state to render here.
 */
export const CommsAvatar = memo(function CommsAvatar({
  member,
  size = 24,
  online,
  className,
}: {
  member: OrgMemberProfile | null;
  size?: number;
  /** Omit entirely to draw no dot (e.g. inside a channel transcript). */
  online?: boolean;
  className?: string;
}) {
  const label = member?.name ?? "Unknown";
  const dot = Math.max(6, Math.round(size * 0.3));

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {member?.image ? (
        <img
          src={member.image}
          alt=""
          draggable={false}
          style={{ width: size, height: size }}
          className="rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.4),
            backgroundColor: member ? `hsl(${avatarHue(member.id)} 42% 40%)` : "#2a2a2a",
          }}
          className="flex items-center justify-center rounded-full font-medium leading-none text-white/90 select-none tracking-tight"
        >
          {initials(label)}
        </span>
      )}
      {online !== undefined && (
        <span
          aria-label={online ? "Online" : "Offline"}
          style={{ width: dot, height: dot }}
          className={cn(
            "absolute -bottom-px -right-px rounded-full border-2 border-[var(--panel-bg-2)]",
            online ? "bg-[var(--comms-unread)]" : "bg-[#3d3d3d]",
          )}
        />
      )}
    </span>
  );
});

/** The stacked avatars used for a group DM or a channel row. */
export function CommsAvatarStack({
  members,
  size = 24,
}: {
  members: OrgMemberProfile[];
  size?: number;
}) {
  const shown = members.slice(0, 2);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {shown.map((m, i) => (
        <CommsAvatar
          key={m.id}
          member={m}
          size={i === 0 ? Math.round(size * 0.72) : Math.round(size * 0.72)}
          className={cn(
            "absolute ring-2 ring-[var(--panel-bg-2)] rounded-full",
            i === 0 ? "left-0 top-0" : "right-0 bottom-0",
          )}
        />
      ))}
    </span>
  );
}
