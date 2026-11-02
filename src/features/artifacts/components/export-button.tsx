/**
 * Take the Session out of Atlas.
 *
 * Two formats, because there are two reasons to want one — the machine-readable
 * record and the one you paste into a ticket — and the choice is one click deep
 * rather than a dialog, since neither is the obvious default.
 *
 * Lives in the reader's footer pill beside share and filter (`footer-pill.tsx`),
 * rather than floating in the masthead: it is an action on the open Session,
 * and the footer is where the reader keeps those.
 */

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Download, Loader2 } from "lucide-react";

import { HintItem } from "@/ui/hint-group";

import type { SessionDetail as Detail } from "../types";
import { exportSession, type ExportFormat } from "../lib/export";
import { PILL_BUTTON, PILL_ICON } from "./footer-pill";

export function ExportButton({ detail }: { detail: Detail }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [open, setOpen] = useState(false);

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(format);
    try {
      await exportSession(detail, format);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label="Export session">
        <Popover.Trigger
          render={
            <button type="button" disabled={busy !== null} className={PILL_BUTTON}>
              {busy ? (
                <Loader2 size={PILL_ICON} className="animate-spin" />
              ) : (
                <Download size={PILL_ICON} strokeWidth={1.7} />
              )}
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        {/* The pill sits on the reader's bottom-left: the menu opens up from it. */}
        <Popover.Positioner className="z-popover" side="top" align="start" sideOffset={8}>
          {/* The filter menu's surface: opaque, on the theme's own
              background, in the page's appearance. */}
          <Popover.Popup className="w-[184px] origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-border bg-background p-1 text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in">
            <ExportItem onClick={() => void run("md")} label="Markdown" hint=".md" />
            <ExportItem onClick={() => void run("json")} label="JSON" hint=".json" />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExportItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
    >
      {label}
      <span className="flex-1" />
      <span className="font-mono text-2xs text-[var(--atlas-text-disabled)]">{hint}</span>
    </button>
  );
}
