import { GitCommitHorizontal, Layers } from "lucide-react";
import { Icon } from "@tryatlas/design";
import type { ChatSessionReference } from "../../types";

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** The card's second line: what the snapshot says about the run or commit. */
function detailOf(ref: ChatSessionReference): string {
  if (ref.kind === "checkpoint") {
    return [
      `Checkpoint ${ref.commit_sha.slice(0, 7)}`,
      ref.branch,
      `+${ref.insertions} −${ref.deletions}`,
      plural(ref.files, "file"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    "Recorded session",
    ref.agent,
    plural(ref.messages, "message"),
    plural(ref.tool_calls, "tool call"),
    plural(ref.checkpoints, "checkpoint"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A **Session Reference** a message carries: the recorded session (or one
 * checkpoint in it) the sender pointed at, drawn as the attachment file card
 * is drawn, and opening that recorded session on the Timeline when clicked.
 * The figures are the sender's snapshot; the Timeline has the current truth.
 */
export function SessionReferenceCardView({
  reference,
  onOpen,
}: {
  reference: ChatSessionReference;
  onOpen: () => void;
}) {
  const title = reference.session_title ?? "Untitled session";
  const glyph = reference.kind === "checkpoint" ? GitCommitHorizontal : Layers;
  return (
    <button
      type="button"
      data-session-reference={reference.kind}
      aria-label={`Session Reference: ${title}. Open it on the Timeline`}
      onClick={onOpen}
      className="group flex w-full max-w-[420px] cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors duration-fast hover:border-border-strong hover:bg-element-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon icon={glyph} size="md" className="text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-secondary-foreground">{title}</span>
        <span className="block truncate text-2xs tabular-nums text-disabled">
          {detailOf(reference)}
        </span>
      </span>
    </button>
  );
}
