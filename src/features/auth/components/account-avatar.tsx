import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import type { AccountUser } from "../lib/auth-api";

/**
 * The signed-in user's face: their cached photo, or their initial on a colour
 * derived from their user id.
 *
 * There is no third "broken photo" state — every failure path, in Rust and
 * here, lands on the initial, because a missing avatar is not something the
 * user can act on.
 *
 * Sized by prop rather than by class so the title-bar button (18px) and the
 * account-menu header (28px) stay the same component: the initial's colour is
 * identity, and two implementations of it would eventually disagree.
 */
export function AccountAvatar({ user, size }: { user: AccountUser; size: number }) {
  // Keyed by path rather than a bare boolean, so a photo that changes gets a
  // fresh attempt instead of inheriting the previous one's failure.
  const [failedPath, setFailedPath] = useState<string | null>(null);

  if (user.avatarPath && failedPath !== user.avatarPath) {
    return (
      <img
        src={convertFileSrc(user.avatarPath)}
        alt=""
        draggable={false}
        onError={() => setFailedPath(user.avatarPath)}
        style={{ width: size, height: size }}
        className="rounded-full object-cover shrink-0"
      />
    );
  }
  return <Initial user={user} size={size} />;
}

/**
 * A single letter on a colour derived from the user id.
 *
 * Deriving rather than picking keeps the same person the same colour on every
 * machine and every launch, which is what makes the circle read as *their*
 * badge rather than decoration.
 */
function Initial({ user, size }: { user: AccountUser; size: number }) {
  const source = user.name.trim() || user.email.trim();
  // `Array.from` rather than `[0]`, so a name starting outside the BMP does not
  // render as half a character.
  const letter = (Array.from(source)[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        backgroundColor: `hsl(${hueFor(user.id)} 42% 40%)`,
      }}
      className="flex items-center justify-center shrink-0 rounded-full font-medium leading-none text-white/90 select-none"
    >
      {letter}
    </span>
  );
}

/** Stable hue in [0, 360) for a string. */
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}
