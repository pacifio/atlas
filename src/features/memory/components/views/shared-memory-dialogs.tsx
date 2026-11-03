// The Shared view's three dialogs, props-only. Their containers (state, IPC,
// toasts) live in `../shared-memory-modals.tsx`. Composed from the Import
// sessions modal's Dialog shell, tokens and type scale.

import { X, Check } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { DialogOverlay } from "@/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  ClaudeImportLine,
  ClaudeImportPreview,
  ExportPreview,
  RepoImportLine,
} from "../../lib/shared-memory-format";
import { KindChip } from "./shared-memory-primitives";

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[620px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-lg animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Export to AGENTS.md
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            {preview
              ? `${preview.path}: only the block between the atlas-memory markers changes.`
              : error
                ? error
                : "Preparing the preview…"}
          </p>
          <div className="flex-1 overflow-auto px-4 py-2">
            {preview && (
              <pre className="whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-2xs text-secondary-foreground">
                {preview.after}
              </pre>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Dialog.Close className="rounded px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={writing || preview === null}
              onClick={onWrite}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {writing ? "Writing…" : "Write"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-lg animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Import memory repo
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            Bring in an Agent Memory Repo (a folder with a MEMORY.md). Lines land as unconfirmed
            candidates: no agent is briefed on them until you approve them in Review.
          </p>
          <div className="flex items-center gap-2 px-4 pt-2 text-xs">
            <button
              type="button"
              onClick={onChoose}
              className="h-6 rounded-md border border-border px-2 text-secondary-foreground hover:bg-element-hover"
            >
              Choose folder…
            </button>
            <span className="min-w-0 truncate text-muted-foreground">{dir ?? ""}</span>
          </div>
          <div className="flex-1 overflow-auto px-4 py-2">
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
                  />
                  <span className="w-20 shrink-0 text-2xs text-muted-foreground">{l.kind}</span>
                  <span className={cn("min-w-0 flex-1", !l.isNew && "text-muted-foreground")}>
                    {l.content}
                    {l.meta && (
                      <span className="block text-2xs text-muted-foreground">{l.meta}</span>
                    )}
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Dialog.Close className="rounded px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={onImport}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {busy ? "Importing…" : selected.size > 0 ? `Import ${selected.size}` : "Import"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-lg animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Import Claude memory
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>

          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            {preview?.alreadyImported
              ? "Already imported: Claude's memory for this project was brought in before, so there is nothing new to import."
              : "Bring the memories Claude Code kept for this project into shared memory, so every agent sees them. Imported lines are marked as from Claude, at 70% confidence."}
          </p>

          <div className="flex-1 overflow-auto hide-scrollbar px-2 py-2">
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

          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Dialog.Close className="rounded px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={importing || fresh === 0 || selected.size === 0}
              onClick={onImport}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {importing ? "Importing…" : selected.size > 0 ? `Import ${selected.size}` : "Import"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
        "flex items-center gap-1.5 w-full rounded px-2 py-1.5 text-left transition-colors",
        !line.isNew && "cursor-not-allowed opacity-60",
        line.isNew && (checked ? "bg-element-selected" : "cursor-pointer hover:bg-element-hover"),
      )}
    >
      <span className="w-[64px] shrink-0">
        <KindChip kind={line.kind} />
      </span>
      <span className="flex-1 min-w-0 truncate text-xs text-foreground">{line.content}</span>
      {!line.isNew && (
        <span className="shrink-0 text-2xs text-muted-foreground">already in memory</span>
      )}
      {checked && <Check size={12} className="text-secondary-foreground shrink-0" />}
    </button>
  );
}
