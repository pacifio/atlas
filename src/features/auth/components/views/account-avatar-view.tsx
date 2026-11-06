import { Avatar, AvatarFallback, AvatarImage } from "@tryatlas/design";

/**
 * A person's face: their photo when there is one, else their initial.
 *
 * The fallback is the package's muted initial, never a hue derived from the id:
 * in a members table eight colours read as eight categories rather than eight
 * people. A photo that fails to load falls back too — Base UI tracks the load
 * status, and a new `src` gets a fresh attempt — because a missing avatar is
 * not something the user can act on.
 *
 * Sized in pixels rather than by class so the title-bar button (18px), the
 * account-menu header (28px) and a 14px invite chip stay one component. The
 * nearest package size picks the initial's type step.
 */
export function AccountAvatarView({
  name,
  email,
  src,
  size,
  className,
}: {
  name: string;
  email: string;
  /** A URL the webview can load, already resolved by the caller. */
  src: string | null;
  size: number;
  className?: string;
}) {
  const step = size >= 32 ? "lg" : size >= 26 ? "md" : size >= 22 ? "sm" : "xs";
  return (
    <Avatar size={step} className={className} style={{ width: size, height: size }}>
      {src && <AvatarImage src={src} alt="" draggable={false} />}
      <AvatarFallback aria-hidden>{initialOf(name, email)}</AvatarFallback>
    </Avatar>
  );
}

/** The letter a face falls back to: the name's first, else the address's. */
export function initialOf(name: string, email: string): string {
  const source = name.trim() || email.trim();
  // `Array.from` rather than `[0]`, so a name starting outside the BMP does not
  // render as half a character.
  return (Array.from(source)[0] ?? "?").toUpperCase();
}
