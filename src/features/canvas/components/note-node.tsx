import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { timeAgo } from "@/lib/time-ago";
import { NodeHandles } from "./node-handles";

export interface NoteNodeData extends Record<string, unknown> {
  title: string;
  body: string;
  updatedAt: string;
  /** Optional emoji shown instead of the default sticky-note glyph. */
  icon?: string;
}

export const NoteNode = memo(function NoteNode({ data, selected }: NodeProps) {
  const d = data as NoteNodeData;
  const isEmpty = !d.body.trim();

  return (
    <div
      className={cn(
        "group relative rounded-2xl overflow-visible",
        "min-w-[260px] max-w-[360px]",
        "bg-[var(--bg-secondary)]/70 backdrop-blur-3xl backdrop-saturate-150",
        "border shadow-2xl transition-colors",
        selected ? "border-[var(--accent-primary)]/60" : "border-white/10 hover:border-white/20",
      )}
    >
      {/* Inner glow */}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-b from-white/5 to-transparent opacity-60 pointer-events-none" />

      {/* Connection handles — one per side (4-way linking). */}
      <NodeHandles selected={selected} />

      {/* Header */}
      <div className="relative flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 shrink-0">
          {d.icon ? (
            <span className="text-[15px] leading-none">{d.icon}</span>
          ) : (
            <StickyNote size={13} className="text-white/80" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
            {d.title || "Untitled"}
          </div>
          <div className="text-[10px] text-[var(--text-tertiary)]">
            {timeAgo(d.updatedAt, { suffix: true })}
          </div>
        </div>
      </div>

      {/* Body preview */}
      <div className="relative px-3 py-2.5 max-h-[180px] overflow-hidden rounded-b-2xl">
        {isEmpty ? (
          <div className="text-[11px] text-[var(--text-tertiary)] italic">
            Empty note — open to edit.
          </div>
        ) : (
          <div className="text-[12px] leading-relaxed text-[var(--text-secondary)] [&_*]:!my-1 [&_p]:!my-0">
            <Markdown>{d.body}</Markdown>
          </div>
        )}
        {/* Fade overlay so long content dissolves visually */}
        {!isEmpty && (
          <div
            aria-hidden
            className="absolute left-0 right-0 bottom-0 h-8 pointer-events-none"
            style={{
              background:
                "linear-gradient(to bottom, transparent, color-mix(in srgb, var(--bg-secondary) 85%, transparent))",
            }}
          />
        )}
      </div>
    </div>
  );
});
