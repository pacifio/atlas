// The plain elements the tab hands to a tooltip or popover trigger as its
// `render`: the trigger primitives own no look, so each surface names its
// own here rather than restyling the primitive at the call site. Each one
// spreads what the trigger merges in (ref, handlers, aria state).

import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** The coloured `#12` that opens the pull request on GitHub. */
export function NumberLinkButton({ tone, ...props }: ComponentProps<"button"> & { tone: string }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
        tone,
      )}
    />
  );
}

/** The base branch when the pull request has fallen behind it. */
export function StaleBaseButton(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex max-w-2/5 min-w-0 shrink-0 cursor-help items-center gap-1 rounded-sm text-warning"
    />
  );
}

/** Text that copies itself: the checkout command, the branch name. */
export function CopyButton({
  placement,
  ...props
}: ComponentProps<"button"> & { placement?: string }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "grid w-fit max-w-full min-w-0 shrink cursor-pointer rounded px-1 py-0.5 text-left transition-colors hover:bg-element-hover hover:text-foreground",
        placement,
      )}
    />
  );
}

/** The tab bar's checks rollup. */
export function ChecksButton(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="ml-auto flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
    />
  );
}

const PILL =
  "inline-flex h-control-xs shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs transition-colors";

/** One reaction's pill, pressed when the viewer is among them. */
export function ReactionPill({
  reacted,
  interactive,
  ...props
}: ComponentProps<"button"> & { reacted: boolean; interactive: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        PILL,
        reacted
          ? "border-primary bg-primary-muted text-foreground"
          : "border-border bg-card text-muted-foreground",
        interactive ? "cursor-pointer hover:border-border-strong" : "cursor-default",
      )}
    />
  );
}

/** The add-a-reaction pill: quiet until its comment is hovered or focused,
 *  unless reactions are already showing beside it. */
export function AddReactionPill({
  quiet,
  ...props
}: ComponentProps<"button"> & { quiet: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        PILL,
        "cursor-pointer border-border text-muted-foreground hover:text-foreground",
        quiet &&
          "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
      )}
    />
  );
}

/** A reviewer's avatar, ringed in the colour of their verdict. */
export function VerdictRing({ ring, ...props }: ComponentProps<"span"> & { ring: string | null }) {
  return <span {...props} className={cn("relative rounded-full hover:z-10", ring)} />;
}
