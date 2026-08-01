import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TerminalSquare, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { isBashToolCall, bashCommandOf } from "../lib/tool-calls";
import { timeAgo } from "@/lib/time-ago";

interface BashEntry {
  command: string;
  description?: string;
  messageIndex: number;
  toolCallId: string;
  timestamp: string;
}

interface BashHistoryPanelProps {
  messages: ChatMessage[];
  onJump: (messageIndex: number) => void;
  onClose: () => void;
}

export function BashHistoryPanel({
  messages,
  onJump,
  onClose,
}: BashHistoryPanelProps) {
  const bashPanel = useLayoutStore.use.bashPanel();
  const { setBashPanelWidth } = useLayoutStore.use.actions();

  // Esc closes the overlay (it's a plain div, not a Radix dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const entries = useMemo<BashEntry[]>(() => {
    const out: BashEntry[] = [];
    messages.forEach((m, i) => {
      for (const tc of m.toolCalls) {
        if (!isBashToolCall(tc)) continue;
        const args = tc.arguments as Record<string, unknown>;
        const cmd = bashCommandOf(args);
        const desc = (args.description as string) ?? undefined;
        if (!cmd) continue;
        out.push({
          command: cmd,
          description: desc,
          messageIndex: i,
          toolCallId: tc.id,
          timestamp: m.timestamp,
        });
      }
    });
    return out.reverse();
  }, [messages]);

  // Resize handle on the LEFT edge of the panel
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = bashPanel.width;
      const onMove = (ev: MouseEvent) => {
        if (resizeStartXRef.current === null) return;
        // Dragging left makes the panel WIDER (it's anchored on the right side)
        const delta = resizeStartXRef.current - ev.clientX;
        setBashPanelWidth(resizeStartWidthRef.current + delta);
      };
      const onUp = () => {
        resizeStartXRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [bashPanel.width, setBashPanelWidth],
  );

  // Virtualized list
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => entries[i]?.toolCallId ?? i,
  });

  return (
    <>
      {/* Scrim — click outside the panel to dismiss. Subtle so the chat stays
          readable underneath the overlay. */}
      <div
        className="absolute inset-0 z-20 bg-black/20 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        style={{ width: bashPanel.width }}
        className="absolute right-0 top-0 bottom-0 z-30 flex flex-col border-l border-[var(--border-default)] bg-[var(--bg-sidebar)] shadow-[var(--shadow-overlay)] animate-slide-in-right"
      >
        {/* Left-edge resize handle */}
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 -left-px w-px h-full bg-border-default hover:bg-accent transition-colors cursor-col-resize z-10"
          title="Drag to resize"
        />

        {/* Header */}
        <div className="flex items-center justify-between px-3 h-[32px] border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-center gap-1.5">
            <TerminalSquare size={11} className="text-[var(--text-tertiary)]" />
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              Bash calls
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)]">
              · {entries.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            title="Hide bash history"
          >
            <ChevronRight size={12} />
          </button>
        </div>

        {/* Virtualized list */}
        <div ref={parentRef} className="flex-1 overflow-y-auto hide-scrollbar">
          {entries.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
              No bash commands in this chat yet.
            </div>
          ) : (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
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
                      onClick={() => onJump(e.messageIndex)}
                      className={cn(
                        "group w-full text-left px-3 py-2 transition-colors flex flex-col gap-1 cursor-pointer",
                        "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] opacity-80 hover:opacity-100",
                        !isLast && "border-b border-[var(--border-subtle)]",
                      )}
                      title={e.command}
                    >
                      <div className="text-[11px] font-mono break-all line-clamp-2 whitespace-pre-wrap">
                        {e.command}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        {e.description ? (
                          <span className="text-[9px] text-[var(--text-tertiary)] truncate flex-1">
                            {e.description}
                          </span>
                        ) : (
                          <span className="flex-1" />
                        )}
                        <span className="text-[9px] text-[var(--text-tertiary)] shrink-0">
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
      </div>
    </>
  );
}
