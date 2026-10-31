import { Popover } from "@base-ui/react/popover";
import { Copy, Download, FileText, FileType2, Image as ImageIcon, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
import { DockButton, DOCK_TRIGGER, HeaderDock } from "@/features/artifacts/components/header-dock";
import type { DateRange } from "../types";
import { DateRangeControl } from "./date-range-control";
import { DestinationActions } from "@/features/layout/components/destination-actions";

export type ExportKind = "pdf" | "jpeg" | "markdown" | "copy-markdown";

/**
 * The Usage controls: what window you are looking through, and the two
 * actions on the page. They sit in the destination bar (ADR-0024), which
 * already says "Usage" and the organization, so there is no title row of
 * their own repeating it.
 *
 * One round-ended track for the setting, one icon dock: what this replaced
 * drew five bordered boxes across two rows to say "last 30 days".
 */
export function UsageHeader({
  range,
  onRange,
  earliest,
  onExport,
  onRefresh,
  loading,
  canExport,
}: {
  range: DateRange;
  onRange: (r: DateRange) => void;
  earliest: string | null;
  onExport: (kind: ExportKind) => void;
  onRefresh: () => void;
  loading: boolean;
  canExport: boolean;
}) {
  return (
    <DestinationActions>
      <div className="flex shrink-0 items-center gap-2">
        <DateRangeControl range={range} onChange={onRange} earliest={earliest} />
        {/* No `HintGroup` of its own: `HeaderDock` already is one, and nesting
            a second group gives the dock two sliding tooltips racing the same
            pointer. */}
        <HeaderDock>
          <ExportMenu onExport={onExport} disabled={!canExport} />
          <DockButton label="Reload usage" onClick={onRefresh}>
            <RefreshCw size={12} className={cn(loading && "animate-spin")} />
          </DockButton>
        </HeaderDock>
      </div>
    </DestinationActions>
  );
}

const ITEMS: ReadonlyArray<{ kind: ExportKind; label: string; hint: string; icon: typeof Copy }> = [
  { kind: "pdf", label: "PDF report", hint: ".pdf", icon: FileType2 },
  { kind: "jpeg", label: "JPEG image", hint: ".jpg", icon: ImageIcon },
  { kind: "markdown", label: "Markdown report", hint: ".md", icon: FileText },
  { kind: "copy-markdown", label: "Copy as Markdown", hint: "⌘C", icon: Copy },
];

/** Export, as a dock glyph — same shape the Timeline's export takes. */
function ExportMenu({
  onExport,
  disabled,
}: {
  onExport: (kind: ExportKind) => void;
  disabled: boolean;
}) {
  return (
    <Popover.Root>
      <HintItem label="Export usage">
        <Popover.Trigger
          render={
            <button
              type="button"
              disabled={disabled}
              className={cn(DOCK_TRIGGER, "disabled:opacity-40")}
            >
              <Download size={12} strokeWidth={1.7} />
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        {/* z-index belongs to the Positioner — the Popup is static inside it.
            `--transform-origin` is Base UI's spelling of Radix's
            `--radix-popover-content-transform-origin`. */}
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="w-[196px] origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]/90 p-1 shadow-md backdrop-blur-2xl data-closed:animate-scale-out data-open:animate-scale-in">
            {ITEMS.map((item) => (
              <Popover.Close
                key={item.kind}
                render={
                  <button
                    type="button"
                    onClick={() => onExport(item.kind)}
                    className="flex h-control-md w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--secondary-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                  >
                    <item.icon size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 text-2xs text-[var(--atlas-text-disabled)]">
                      {item.hint}
                    </span>
                  </button>
                }
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
