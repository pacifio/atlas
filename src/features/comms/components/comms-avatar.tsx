import { memo } from "react";
import { Webhook } from "lucide-react";
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
  /** Omit entirely to draw no dot — for avatars too small or too overlapped to
   *  carry one (a mention chip, a 16px byline, the header's facepile), and for
   *  an unresolved member, where `false` would assert "offline" about someone
   *  we cannot even name. */
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
            // ratchet-allow: an identity hue derived from the member id, not a theme colour.
            backgroundColor: member ? `hsl(${avatarHue(member.id)} 42% 40%)` : "var(--muted)",
          }}
          // ratchet-allow: the initials ride on that same identity hue, which is
          // saturated at a fixed lightness; white is what reads on all of them.
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
            "absolute -bottom-px -right-px rounded-full border-2 border-[var(--background)]",
            online ? "bg-[var(--atlas-status-success-foreground)]" : "bg-border-strong",
          )}
        />
      )}
    </span>
  );
});

/**
 * An integration's face: a rounded square, not a circle, so it never reads as
 * a person — the generated webhook glyph on a hue derived from the webhook's
 * id. No presence dot: an integration is not somewhere.
 *
 * The webhook's uploaded picture (`author_avatar_hash`) lives in the server's
 * media store behind the web session; the desktop has no fetch for it yet, so
 * every integration draws the glyph, as the web does when there is no picture.
 */
export const IntegrationAvatar = memo(function IntegrationAvatar({
  id,
  name,
  size = 24,
}: {
  id: string;
  name: string;
  size?: number;
}) {
  return (
    <span
      role="img"
      aria-label={`${name} (app)`}
      style={{
        width: size,
        height: size,
        // ratchet-allow: an identity hue derived from the webhook id, the same
        // derivation a member's initials use, not a theme colour.
        backgroundColor: `hsl(${avatarHue(id)} 42% 40%)`,
      }}
      // ratchet-allow: the glyph rides on that identity hue, which is
      // saturated at a fixed lightness; white is what reads on all of them.
      className="inline-flex shrink-0 items-center justify-center rounded-md text-white/90"
    >
      <Webhook size={Math.round(size * 0.55)} strokeWidth={1.75} />
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
            "absolute ring-2 ring-[var(--background)] rounded-full",
            i === 0 ? "left-0 top-0" : "right-0 bottom-0",
          )}
        />
      ))}
    </span>
  );
}
