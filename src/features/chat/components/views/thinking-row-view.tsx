import { memo, useLayoutEffect, useRef } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useVisibleAnimation } from "@/lib/visible-animation";
import type { ThinkingRow } from "../../lib/turn-rows";
import { ICON_PX, ICON_STROKE } from "../tool-glyph";
import { RowCommentPill } from "../chat-comment-pills";
import { Column } from "./transcript-row-parts";

// ── Thinking ───────────────────────────────────────────────────────────────

/** The thinking row, given whether it is discussed. The comment read lives in
 *  its container, `ThinkingRowView` in `transcript-rows.tsx`. */
export const ThinkingRowBody = memo(function ThinkingRowBody({
  row,
  tabId,
  discussed,
  onToggleExpand,
}: {
  row: ThinkingRow;
  tabId: string;
  /** The thought has a visible comment thread. */
  discussed: boolean;
  onToggleExpand: (id: string) => void;
}) {
  // `th:<messageId>`. A discussed thought wears its pill; the wrapper exists
  // only then, so an undiscussed row's DOM is exactly what it was.
  const messageId = row.id.slice(3);
  const shimmer = useVisibleAnimation<HTMLElement>();
  const toggle = (
    <button
      ref={row.streaming ? shimmer : undefined}
      type="button"
      onClick={() => onToggleExpand(row.id)}
      className={cn(
        "flex h-[26px] items-center gap-2 text-left text-base text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] cursor-pointer transition-colors",
        discussed ? "min-w-0 flex-1" : "w-full",
      )}
    >
      {/* Same slot, size and stroke as the tool rows around it. */}
      <span className="flex w-4 shrink-0 justify-center">
        <Brain
          size={ICON_PX}
          strokeWidth={ICON_STROKE}
          className={cn(row.streaming && "atlas-marker-running")}
        />
      </span>
      {/* The thought itself when it has one: "Checking the cache key" says
          more than "Thinking…", and it is the live line while the agent
          reasons. One truncated line, so the row stays 26px as it changes. */}
      <span className={cn("min-w-0 truncate", row.streaming && "atlas-thinking-shimmer")}>
        {row.headline ?? (row.streaming ? "Thinking…" : "Thought process")}
      </span>
      <ChevronRight
        size={ICON_PX}
        strokeWidth={ICON_STROKE}
        className={cn("shrink-0 transition-transform", row.expanded && "rotate-90")}
      />
    </button>
  );
  return (
    // A turn often emits several thinking blocks in a row, and at the bare
    // 26px button height they stacked into one undifferentiated block — three
    // "Thought process" lines read as a list with no items. 3px either side
    // takes the pitch to 32px (the row plus a quarter) which is enough to tell
    // them apart without turning them into paragraphs.
    <Column className="py-[3px]">
      {discussed ? (
        <div className="flex items-center gap-2">
          {toggle}
          <RowCommentPill tabId={tabId} chatKey={messageId} />
        </div>
      ) : (
        toggle
      )}
      {row.expanded && (
        <div className="pb-3 pl-6">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[19px] text-[var(--muted-foreground)] select-text">
            {row.text}
          </pre>
        </div>
      )}
      {/* The current thought, open while the agent is in it: its newest
          lines, bottom-aligned so the words land where the eye already is.
          It folds back to the line above as soon as a tool call or the answer
          follows (`ThinkingRow.live`). */}
      {row.live && <LiveThought text={row.live} />}
    </Column>
  );
});

/** The live thought's box. The top-edge fade is for older lines cut off
 *  above, so it is on only while the text overflows: a thought that fits
 *  shows at full strength. Set on the element, not in state, because the
 *  text changes with every streamed token. */
function LiveThought({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.toggleAttribute("data-clipped", el.scrollHeight > el.clientHeight);
  }, [text]);
  return (
    <div ref={ref} className="atlas-live-thought pb-1 pl-6">
      <p className="text-sm leading-[19px] text-[var(--muted-foreground)]">{text}</p>
    </div>
  );
}
