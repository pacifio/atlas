/**
 * One surround for a row's controls.
 *
 * Grouping the comment button and the copy button in one pill is what stops a
 * discussed row from showing a pill with a gap beside it, waiting for something
 * to appear: if any control in the group is pinned, the whole group is.
 *
 * Renders nothing when it has no children, so a row with nothing to offer
 * carries no empty pill.
 *
 * `reveal` is how the hidden state comes back. The Timeline fades; the chat
 * transcript SNAPS, because a running opacity transition is a compositing
 * layer in WebKit and rows passing under a resting pointer mid-fling each
 * took one (see the note in `chat/components/user-row-actions.tsx`).
 */

import { Children, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ActionCluster({
  pinned,
  reveal = "fade",
  className,
  children,
}: {
  pinned: boolean;
  reveal?: "fade" | "snap";
  className?: string;
  children: ReactNode;
}) {
  const shown = Children.toArray(children).filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <span
      className={cn(
        "-my-1 flex shrink-0 items-center gap-0.5 self-center rounded-full border border-border bg-card px-0.5 py-0.5",
        reveal === "fade" && "transition-opacity duration-150",
        pinned
          ? reveal === "fade"
            ? "opacity-100"
            : "visible"
          : reveal === "fade"
            ? "opacity-0 focus-within:opacity-100 group-hover/row:opacity-100"
            : // Opacity, not `visibility`: a `visibility: hidden` control
              // cannot take focus, so Tab skipped copy and comment entirely.
              // Hidden here stays focusable and inert to the pointer, and any
              // focus in the row brings it back. Still a snap — no transition.
              [
                "pointer-events-none opacity-0",
                "group-hover/row:pointer-events-auto group-hover/row:opacity-100",
                "focus-within:pointer-events-auto focus-within:opacity-100",
                "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100",
                "has-aria-expanded:pointer-events-auto has-aria-expanded:opacity-100",
                "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
              ],
        className,
      )}
    >
      {shown.map((child, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className="flex items-center">
          {i > 0 && <span aria-hidden className="mr-0.5 h-3 w-px bg-[var(--border)]" />}
          {child}
        </span>
      ))}
    </span>
  );
}
