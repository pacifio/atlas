import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { CanvasNodeFrame, CanvasNote } from "@tryatlas/design";
import { useAppStore } from "@/features/app/stores/app-store";
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
  const projectPath = useAppStore.use.currentProject()?.path ?? null;

  return (
    // The note sizes to its content between these bounds and xyflow measures
    // it. The handles sit outside the frame, so the card's clip never hides them.
    <div className="group relative min-w-[260px] max-w-[360px]">
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="note" selected={selected}>
        <CanvasNote
          title={d.title || "Untitled"}
          icon={d.icon || undefined}
          meta={timeAgo(d.updatedAt, { suffix: true })}
          empty={isEmpty}
          body={
            isEmpty ? undefined : (
              // Rendered markdown, so the block draws no fade of its own: the
              // preview is capped here and dissolves into the card. 160px of
              // content plus the block's body padding is the old 180px box.
              <div className="relative max-h-[160px] overflow-hidden">
                <div className="text-sm leading-relaxed text-secondary-foreground [&_*]:!my-1 [&_p]:!my-0">
                  <Markdown fileRoot={projectPath}>{d.body}</Markdown>
                </div>
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-card/85"
                />
              </div>
            )
          }
        />
      </CanvasNodeFrame>
    </div>
  );
});
