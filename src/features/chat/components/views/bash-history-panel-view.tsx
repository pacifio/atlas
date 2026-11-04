import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import type { BashEntry } from "../../lib/bash-history";

/**
 * The session's shell commands, newest first, virtualised. Commands only —
 * never their output, which the transcript owns. A row click jumps the
 * transcript to the message that ran it.
 */
export function BashHistoryPanelView({
  entries,
  onJump,
}: {
  entries: BashEntry[];
  onJump: (messageIndex: number) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => entries[i]?.toolCallId ?? i,
  });

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto hide-scrollbar">
      {entries.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground leading-relaxed">
          No bash commands in this session yet.
        </div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((vItem) => {
            const e = entries[vItem.index];
            const isLast = vItem.index === entries.length - 1;
            return (
              <div
                key={e.toolCallId}
                ref={virtualizer.measureElement}
                data-index={vItem.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vItem.start}px)`,
                }}
              >
                <button
                  type="button"
                  onClick={() => onJump(e.messageIndex)}
                  className={cn(
                    "group w-full text-left px-3 py-2 transition-colors flex flex-col gap-1 cursor-pointer",
                    "text-secondary-foreground hover:bg-element-hover hover:text-foreground opacity-80 hover:opacity-100",
                    !isLast && "border-b border-border-subtle",
                  )}
                  title={e.command}
                >
                  <div className="text-xs font-mono break-all line-clamp-2 whitespace-pre-wrap">
                    {e.command}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    {e.description ? (
                      <span className="text-3xs text-muted-foreground truncate flex-1">
                        {e.description}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    <span className="text-3xs text-muted-foreground shrink-0">
                      {timeAgo(e.timestamp)}
                    </span>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
