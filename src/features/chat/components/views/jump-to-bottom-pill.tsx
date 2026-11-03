import { memo } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Scroll to bottom" / "N new messages", floated above the composer stack.
 *
 * The no-grant setup state (D15a) used to share this row as a centred pill. It
 * moved into the composer itself (`AiGrantBar`, rendered from
 * `message-input.tsx`), because the two overlapped whenever both showed. The
 * wrapper is `pointer-events-none` so the empty width either side of the pill
 * never swallows clicks meant for the transcript.
 */
export const JumpToBottomPill = memo(function JumpToBottomPill({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <div className="pointer-events-none absolute bottom-full inset-x-0 mb-2 z-20 flex justify-center">
      <button
        onClick={onClick}
        title="Jump to latest"
        style={{ backdropFilter: "blur(4px)" }}
        className={cn(
          "pointer-events-auto atlas-pill-in inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
          "border border-[var(--border)] bg-[var(--card)]",
          "text-xs leading-none font-medium text-[var(--secondary-foreground)]",
          "shadow-sm cursor-pointer transition-colors",
          "hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
        )}
      >
        <ChevronDown size={11} />
        <span>
          {count > 0 ? `${count} new message${count === 1 ? "" : "s"}` : "Scroll to bottom"}
        </span>
      </button>
    </div>
  );
});
