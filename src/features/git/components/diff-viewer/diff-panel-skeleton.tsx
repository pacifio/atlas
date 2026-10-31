/** A file header's shape, at the viewer's 32px header height. */
export function FileHeaderSkeleton({ width }: { width: "w-2/5" | "w-1/2" | "w-3/5" }) {
  return (
    <div className="flex h-8 items-center gap-2 border-b border-border-subtle px-2">
      <div className="size-3 shrink-0 rounded bg-element-selected" />
      <div className={`h-2.5 ${width} rounded-full bg-element-selected`} />
      <div className="ml-auto h-2.5 w-10 rounded-full bg-element-selected" />
    </div>
  );
}

function CodeLineSkeleton({ width }: { width: "w-3/5" | "w-2/3" | "w-4/5" }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-5 shrink-0 rounded-full bg-element-hover" />
      <div className={`h-2 ${width} rounded-full bg-element-hover`} />
    </div>
  );
}

/** What the panel shows while its diff or its workers are on their way: the
 *  structure of a diff, not a spinner. Static, so it costs no frames. */
export function DiffPanelSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-label="Loading diff">
      <FileHeaderSkeleton width="w-1/2" />
      <div className="space-y-2 px-3 py-2">
        <CodeLineSkeleton width="w-2/3" />
        <CodeLineSkeleton width="w-4/5" />
        <CodeLineSkeleton width="w-3/5" />
      </div>
      <FileHeaderSkeleton width="w-2/5" />
      <FileHeaderSkeleton width="w-3/5" />
    </div>
  );
}
