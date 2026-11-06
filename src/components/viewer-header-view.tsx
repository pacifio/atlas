import type { ReactNode } from "react";

/**
 * The strip above a file viewer (notebook, image/video/audio, SVG,
 * unsupported file): the file's path, truncated with the full path on hover,
 * and any actions for the file on the right. The PDF viewer has its own
 * toolbar instead.
 */
export function ViewerHeaderView({ path, actions }: { path: string; actions?: ReactNode }) {
  return (
    <div
      data-slot="viewer-header"
      className="flex h-[32px] shrink-0 items-center gap-2 border-b border-border px-3"
    >
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        title={path}
      >
        {path}
      </span>
      {actions}
    </div>
  );
}
