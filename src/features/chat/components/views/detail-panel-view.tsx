// The detail panel's frame and its tool-output body, from props alone.
// `detail-panel.tsx` owns the store, the Esc key, the drag and the clipboard.

import type { MouseEvent, ReactNode } from "react";
import { ChevronRight, TerminalSquare } from "lucide-react";
import { CopyGlyph, HintGroup, HintItem, Icon, IconButton } from "@tryatlas/design";

/** The panel anchored to the pane's right edge, with its left-edge resize
 *  handle (anchored right, so dragging left widens). */
export function DetailPanelFrameView({
  width,
  top,
  onResizeStart,
  children,
}: {
  width: number;
  top: number;
  onResizeStart: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="detail-panel"
      style={{ width, top }}
      className="absolute right-0 bottom-0 z-30 flex flex-col border-l border-border bg-sidebar shadow-md animate-slide-in-right"
    >
      <div
        onMouseDown={onResizeStart}
        className="absolute -left-px top-0 z-10 h-full w-px cursor-col-resize bg-border transition-colors hover:bg-primary"
        title="Drag to resize"
      />
      {children}
    </div>
  );
}

/** The panel's bar: glyph, title, an optional action, and close. */
export function DetailPanelHeaderView({
  icon,
  title,
  onClose,
  action,
}: {
  icon: ReactNode;
  title: string;
  onClose: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-[32px] shrink-0 items-center justify-between border-b border-border px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-xs font-medium text-secondary-foreground">{title}</span>
      </div>
      <HintGroup>
        <div className="flex shrink-0 items-center gap-0.5">
          {action}
          <HintItem label="Close (Esc)">
            <IconButton
              variant="ghost"
              size="xs"
              icon={ChevronRight}
              label="Close (Esc)"
              onClick={onClose}
            />
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
}

/**
 * The copy control the panel's bodies share. Not an `IconButton`: the glyph is
 * the animated `CopyGlyph`, and `IconButton` takes a Lucide icon only.
 */
export function DetailCopyButton({
  label,
  copied,
  count,
  onCopy,
}: {
  label: string;
  copied: boolean;
  /** Goes up once per copy, so a repeat copy re-shows "Copied". */
  count: number;
  onCopy: () => void;
}) {
  return (
    <HintItem label={copied ? "Copied" : label} reshowKey={count}>
      <button
        type="button"
        onClick={onCopy}
        className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground"
      >
        <CopyGlyph copied={copied} size="sm" />
      </button>
    </HintItem>
  );
}

export function DetailPanelEmpty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">{children}</div>;
}

/** One tool call: its arguments (when it had any), its output, or why there is none. */
export function ToolOutputView({
  toolName,
  args,
  output,
  running,
  copied,
  copyCount,
  onCopy,
  onClose,
}: {
  toolName: string | undefined;
  args: Record<string, unknown> | undefined;
  output: string;
  running: boolean;
  copied: boolean;
  copyCount: number;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <DetailPanelHeaderView
        icon={<Icon icon={TerminalSquare} size="sm" className="text-muted-foreground" />}
        title={toolName ?? "Output"}
        onClose={onClose}
        action={
          output ? (
            <DetailCopyButton
              label="Copy output"
              copied={copied}
              count={copyCount}
              onCopy={onCopy}
            />
          ) : undefined
        }
      />
      <div className="flex-1 overflow-auto hide-scrollbar">
        {args && Object.keys(args).length > 0 && (
          <div className="border-b border-border-subtle px-3 py-2">
            <div className="pb-1 text-3xs uppercase tracking-wider text-muted-foreground">
              Arguments
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-snug text-secondary-foreground select-text">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}
        {output ? (
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-snug text-secondary-foreground select-text">
            {output}
          </pre>
        ) : (
          <DetailPanelEmpty>{running ? "Still running…" : "No output."}</DetailPanelEmpty>
        )}
      </div>
    </>
  );
}
