// One definition of a mention pill, for the two places that draw one.
//
// The rendered message (`components/message-body-impl`) and the composer's
// pill (`components/comms-mention-pill`). They must be indistinguishable — the
// point of the composer pill is that what you are typing already looks like
// what you are about to send — so the classes live here rather than being
// written out twice and drifting. Both draw the face with `CommsAvatar`.
//
// Shape follows the house pill (the transcript's "Scroll to bottom" button):
// fully round, a hairline border, an elevated fill.

/** Avatar diameter. Sized so the pill clears 17px and still sits inside the
 *  12.5px/18px line box of both surfaces without stretching it. */
export const MENTION_AVATAR_SIZE = 13;

const BASE =
  "inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] align-middle " +
  "text-sm font-medium leading-none";

/** Addressed to you, or to everyone — the brighter of the two. */
const SELF = "border-border-strong bg-[var(--atlas-element-emphasis)] text-[var(--foreground)]";
/** Someone else: the same neutral surface every other pill in the app uses. */
const OTHER = "border-border bg-card text-secondary-foreground";

export function mentionPillClass(highlight: boolean): string {
  return `${BASE} ${highlight ? SELF : OTHER}`;
}

/**
 * Marker attributes both renderers put on the pill.
 *
 * A stable hook for tests and for anything that needs to find a mention in the
 * DOM: keying on the Tailwind classes means a colour tweak silently breaks the
 * selector, which is exactly what happened when this pill was restyled.
 */
export const MENTION_PILL_ATTR = "data-mention-pill";
export const MENTION_SELF_ATTR = "data-mention-self";
