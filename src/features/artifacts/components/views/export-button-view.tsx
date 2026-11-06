/**
 * The export control in the reader's footer pill, drawn from props alone.
 *
 * Two formats, because there are two reasons to want one — the machine-readable
 * record and the one you paste into a ticket — and the choice is one click deep
 * rather than a dialog, since neither is the obvious default.
 *
 * The trigger wears the footer pill's own button class rather than an
 * `IconButton`: it sits beside share and filter in that pill, and all three
 * have to be the same 28px round target.
 *
 * The formats are a package `DropdownMenu`: menuitem roles, arrow keys and
 * typeahead, and the menu closes before the export runs.
 */

import { Download, LoaderCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  HintItem,
} from "@tryatlas/design";

import { PILL_BUTTON, PILL_ICON } from "../footer-pill";

/** Restated, not imported: `lib/export.ts` reaches Tauri, and a view may not
 *  depend on it even for a type. The container's call into it type-checks the
 *  two against each other. */
export type ExportFormat = "json" | "md";

const FORMATS: ReadonlyArray<{ format: ExportFormat; label: string; hint: string }> = [
  { format: "md", label: "Markdown", hint: ".md" },
  { format: "json", label: "JSON", hint: ".json" },
];

export function ExportButtonView({
  busy,
  onPick,
}: {
  /** The format being written, or `null` when idle. */
  busy: ExportFormat | null;
  onPick: (format: ExportFormat) => void;
}) {
  return (
    <DropdownMenu>
      <HintItem label="Export session">
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Export session"
              disabled={busy !== null}
              className={PILL_BUTTON}
            >
              {busy ? (
                <LoaderCircle size={PILL_ICON} className="animate-spin" />
              ) : (
                <Download size={PILL_ICON} strokeWidth={1.7} />
              )}
            </button>
          }
        />
      </HintItem>
      {/* The pill sits on the reader's bottom-left: the menu opens up from it. */}
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[184px]">
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f.format} onClick={() => onPick(f.format)}>
            {f.label}
            <DropdownMenuShortcut>{f.hint}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
