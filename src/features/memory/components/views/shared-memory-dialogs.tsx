// The Shared view's three dialogs, props-only. Their containers (state, IPC,
// toasts) live in `../shared-memory-modals.tsx`. Composed from the Import
// sessions modal's Dialog shell, on the house dialog's scales: the dialog
// radius and elevation, a `heading` title, and `src/ui` buttons.

import type { ReactNode } from "react";
import { X, Check } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { DialogOverlay } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/utils";
import type {
  ClaudeImportLine,
  ClaudeImportPreview,
  ExportPreview,
  RepoImportLine,
} from "../../lib/shared-memory-format";
import { KindChip } from "./shared-memory-primitives";

/** The shell all three share: scrim, panel, a titled header with its close,
 *  the body, and a footer of actions. */
function DialogShell({
  open,
  onOpenChange,
  title,
  width,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  width: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] max-w-[92vw] flex-col overflow-hidden rounded-xl",
            "border border-border bg-card text-foreground shadow-lg outline-none",
            "data-open:animate-scale-in data-closed:animate-scale-out",
            width,
          )}
        >
          <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="heading">{title}</Dialog.Title>
            <Dialog.Close
              render={<IconButton icon={X} label="Close" size="sm" className="ml-auto" />}
            />
          </div>
          {children}
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
            <Dialog.Close render={<Button variant="ghost" size="sm" />}>Cancel</Dialog.Close>
            {footer}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The lead paragraph under a dialog's header. */
function Lead({ children }: { children: ReactNode }) {
  return <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

/** The AGENTS.md export: a preview of the file as it would be written, then
 *  Write. Only the managed block changes; nothing is written on Cancel. */
export function ExportAgentsDialog({
  open,
  onOpenChange,
  preview,
  error,
  writing,
  onWrite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: ExportPreview | null;
  error: string | null;
  writing: boolean;
  onWrite: () => void;
}) {
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Export to AGENTS.md"
      width="w-[620px]"
      footer={
        <Button size="sm" disabled={writing || preview === null} onClick={onWrite}>
          {writing ? "Writing…" : "Write"}
        </Button>
      }
    >
      <Lead>
        {preview
          ? `${preview.path}: only the block between the atlas-memory markers changes.`
          : error
            ? error
            : "Preparing the preview…"}
      </Lead>
      <div className="flex-1 overflow-auto px-4 py-3">
        {preview && (
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-2xs text-secondary-foreground">
            {preview.after}
          </pre>
        )}
      </div>
    </DialogShell>
  );
}

/** Import an Agent Memory Repo folder: pick it, see every line it would
 *  write, then Import. Lines land as unconfirmed candidates (Review tab). */
export function ImportRepoDialog({
  open,
  onOpenChange,
  dir,
  lines,
  selected,
  error,
  busy,
  onChoose,
  onToggle,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dir: string | null;
  lines: RepoImportLine[] | null;
  selected: ReadonlySet<string>;
  error: string | null;
  busy: boolean;
  onChoose: () => void;
  onToggle: (id: string) => void;
  onImport: () => void;
}) {
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Import memory repo"
      width="w-[520px]"
      footer={
        <Button size="sm" disabled={busy || selected.size === 0} onClick={onImport}>
          {busy ? "Importing…" : selected.size > 0 ? `Import ${selected.size}` : "Import"}
        </Button>
      }
    >
      <Lead>
        Bring in an Agent Memory Repo (a folder with a MEMORY.md). Lines land as unconfirmed
        candidates: no agent is briefed on them until you approve them in Review.
      </Lead>
      <div className="flex items-center gap-2 px-4 pt-3">
        <Button variant="outline" size="sm" onClick={onChoose}>
          Choose folder…
        </Button>
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {dir ?? ""}
        </span>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3">
        {error ? (
          <div className="text-xs text-muted-foreground">{error}</div>
        ) : lines && lines.length === 0 ? (
          <div className="text-xs text-muted-foreground">No memory lines in that folder.</div>
        ) : (
          lines?.map((l) => (
            <label key={l.id} className="flex items-baseline gap-2 py-1 text-xs">
              <input
                type="checkbox"
                disabled={!l.isNew}
                checked={selected.has(l.id)}
                onChange={() => onToggle(l.id)}
                className="accent-foreground"
              />
              <span className="w-20 shrink-0 text-2xs text-muted-foreground">{l.kind}</span>
              <span className={cn("min-w-0 flex-1", !l.isNew && "text-muted-foreground")}>
                {l.content}
                {l.meta && <span className="caption block">{l.meta}</span>}
              </span>
            </label>
          ))
        )}
      </div>
    </DialogShell>
  );
}

/** Preview, then consent: every line Claude's auto-memory maps to, with its
 *  kind; the new ones start ticked. Only Import writes. */
export function ImportClaudeMemoryDialog({
  open,
  onOpenChange,
  preview,
  selected,
  importing,
  fresh,
  onToggle,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: ClaudeImportPreview | null;
  selected: ReadonlySet<string>;
  importing: boolean;
  /** How many previewed lines are not yet in memory. */
  fresh: number;
  onToggle: (id: string) => void;
  onImport: () => void;
}) {
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Import Claude memory"
      width="w-[520px]"
      footer={
        <Button
          size="sm"
          disabled={importing || fresh === 0 || selected.size === 0}
          onClick={onImport}
        >
          {importing ? "Importing…" : selected.size > 0 ? `Import ${selected.size}` : "Import"}
        </Button>
      }
    >
      <Lead>
        {preview?.alreadyImported
          ? "Already imported: Claude's memory for this project was brought in before, so there is nothing new to import."
          : "Bring the memories Claude Code kept for this project into shared memory, so every agent sees them. Imported lines are marked as from Claude, at 70% confidence."}
      </Lead>

      <div className="hide-scrollbar flex-1 overflow-auto px-2 py-2">
        {preview === null ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            Reading Claude's memory…
          </div>
        ) : preview.lines.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            Claude has no memory for this project.
          </div>
        ) : (
          preview.lines.map((line) => (
            <ImportLineRow
              key={line.id}
              line={line}
              checked={selected.has(line.id)}
              onToggle={() => onToggle(line.id)}
            />
          ))
        )}
      </div>
    </DialogShell>
  );
}

function ImportLineRow({
  line,
  checked,
  onToggle,
}: {
  line: ClaudeImportLine;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={!line.isNew}
      onClick={onToggle}
      title={line.file}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
        "transition-colors duration-fast ease-out-strong",
        !line.isNew && "cursor-not-allowed opacity-50",
        line.isNew && (checked ? "bg-element-selected" : "cursor-pointer hover:bg-element-hover"),
      )}
    >
      <span className="w-[72px] shrink-0">
        <KindChip kind={line.kind} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{line.content}</span>
      {!line.isNew && <span className="caption shrink-0">already in memory</span>}
      {checked && <Check size={12} className="shrink-0 text-foreground" />}
    </button>
  );
}
