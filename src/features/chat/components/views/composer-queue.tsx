// Queued messages above the composer's input. Props-only.

import { Pencil, X } from "lucide-react";
import { Hint } from "@/ui/tooltip";

export function ComposerQueue({
  queue,
  remoteDriving,
  onEdit,
  onRemove,
}: {
  queue: readonly string[];
  remoteDriving: boolean;
  onEdit: (text: string, index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="mb-2 flex flex-col gap-1">
      <div className="text-2xs uppercase tracking-wider text-[var(--muted-foreground)] px-1">
        Queued · {queue.length}
        {/* The owner's queued prompts wait while someone else drives
            (R4): Rust's drain skips them until the seat is back. */}
        {remoteDriving && " · runs when you take over"}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {queue.map((q, i) => (
          <QueueChip key={i} text={q} onEdit={() => onEdit(q, i)} onRemove={() => onRemove(i)} />
        ))}
      </div>
    </div>
  );
}

function QueueChip({
  text,
  onEdit,
  onRemove,
}: {
  text: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-1 max-w-[260px] h-6 pl-2 pr-1 rounded-full border border-[var(--border)] bg-[var(--card)] text-xs text-[var(--secondary-foreground)]">
      <button
        onClick={onEdit}
        className="flex items-center gap-1 min-w-0 cursor-pointer hover:text-[var(--foreground)]"
        title="Edit / merge into input"
      >
        <Pencil size={9} className="text-[var(--muted-foreground)] shrink-0" />
        <span className="truncate">{text.replace(/\s+/g, " ")}</span>
      </button>
      <Hint label="Remove from queue" side="top">
        <button
          onClick={onRemove}
          className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-element-hover text-[var(--muted-foreground)] hover:text-error cursor-pointer shrink-0"
        >
          <X size={10} />
        </button>
      </Hint>
    </div>
  );
}
