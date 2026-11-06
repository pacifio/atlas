import type { ReactNode } from "react";

/** The count a pill shows before it caps (`MAX_COUNT` in `comment-thread.tsx`). */
const MAX_COUNT = 9;

/**
 * A folded tool sequence's comment summary: the commenters' faces and a count.
 * `faces` arrive as rendered elements, one per commenter, keyed by the
 * container — the avatar resolves images over IPC, which a view cannot.
 * Renders nothing at zero.
 */
export function GroupCommentPillView({
  count,
  faces,
  onOpen,
}: {
  count: number;
  faces: ReactNode[];
  onOpen: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${count} ${count === 1 ? "comment" : "comments"} on these tool calls`}
      className="ml-auto flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-card pl-0.5 pr-1.5 text-secondary-foreground hover:bg-element-hover hover:text-foreground"
    >
      {faces.length > 0 && <span className="flex shrink-0 items-center -space-x-1.5">{faces}</span>}
      <span className="text-2xs tabular-nums">{count > MAX_COUNT ? `${MAX_COUNT}+` : count}</span>
    </button>
  );
}
