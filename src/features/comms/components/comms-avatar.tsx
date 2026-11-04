import { memo } from "react";
import { Webhook } from "lucide-react";
import { Avatar, AvatarFallback } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { initials } from "../lib/derive";
import type { OrgMemberProfile } from "../types";

/** Every diameter team chat draws a face at, in px. */
export type CommsAvatarSize = 12 | 13 | 16 | 18 | 20 | 22 | 24 | 30;

// Pixel sizes, not the spacing scale: `--spacing` is rem-based and the app's
// root font size is not 16px, so `size-6` would not come out at 24px here.
const SIZE: Record<CommsAvatarSize, string> = {
  12: "size-[12px]",
  13: "size-[13px]",
  16: "size-[16px]",
  18: "size-[18px]",
  20: "size-[20px]",
  22: "size-[22px]",
  24: "size-[24px]",
  30: "size-[30px]",
};

/** The presence dot: 30% of the face, never under 6px. */
const DOT: Record<CommsAvatarSize, string> = {
  12: "size-[6px]",
  13: "size-[6px]",
  16: "size-[6px]",
  18: "size-[6px]",
  20: "size-[6px]",
  22: "size-[7px]",
  24: "size-[7px]",
  30: "size-[9px]",
};

/**
 * A member's face, with an optional presence dot.
 *
 * The fallback is initials on `bg-muted`, never a hue generated from the id —
 * the package `Avatar`'s rule, because a list with eight colours in it reads as
 * eight categories rather than eight people.
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
  size?: CommsAvatarSize;
  /** Omit entirely to draw no dot — for avatars too small or too overlapped to
   *  carry one (a mention chip, a 16px byline, the header's facepile), and for
   *  an unresolved member, where `false` would assert "offline" about someone
   *  we cannot even name. */
  online?: boolean;
  className?: string;
}) {
  const label = member?.name ?? "Unknown";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 leading-none tracking-tight",
        // The initials' size, inherited by the fallback: with `data-size` not a
        // package step, none of its own text-size rules apply.
        size >= 24 ? "text-2xs" : "text-3xs",
        SIZE[size],
        className,
      )}
    >
      {/* `data-size` replaces the package's own (`md`), so its control-ladder
          size rule does not beat the pixel size. */}
      <Avatar data-size="comms" className={SIZE[size]}>
        {member?.image ? (
          // A plain <img>, not `AvatarImage`: that one swaps a broken image for
          // the initials, a behaviour change still awaiting review (ATL-718).
          <img
            src={member.image}
            alt=""
            draggable={false}
            className="aspect-square size-full object-cover"
          />
        ) : (
          <AvatarFallback aria-hidden>{initials(label)}</AvatarFallback>
        )}
      </Avatar>
      {online !== undefined && (
        <span
          aria-label={online ? "Online" : "Offline"}
          className={cn(
            "absolute -right-px -bottom-px rounded-full border-2 border-background",
            DOT[size],
            online ? "bg-success" : "bg-border-strong",
          )}
        />
      )}
    </span>
  );
});

/**
 * An integration's face: a rounded square, not a circle, so it never reads as
 * a person — the generated webhook glyph on the same muted fill a member's
 * initials use. No presence dot: an integration is not somewhere.
 *
 * The webhook's uploaded picture (`author_avatar_hash`) lives in the server's
 * media store behind the web session; the desktop has no fetch for it yet, so
 * every integration draws the glyph, as the web does when there is no picture.
 */
export const IntegrationAvatar = memo(function IntegrationAvatar({
  name,
  size = 24,
}: {
  /** The webhook's id. Unread since the face stopped deriving a hue from it;
   *  kept so a call site names its integration the way it names a member. */
  id: string;
  name: string;
  size?: CommsAvatarSize;
}) {
  return (
    <span
      role="img"
      aria-label={`${name} (app)`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-secondary-foreground",
        SIZE[size],
      )}
    >
      <Webhook size={Math.round(size * 0.55)} strokeWidth={1.75} />
    </span>
  );
});
