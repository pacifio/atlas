import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { DialogOverlay } from "@/ui/dialog";
import { AlertTriangle, Check, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { importCandidates, importThreads, type ImportCandidate } from "../lib/history-api";

/**
 * Pull sessions an agent kept for itself into Atlas's history.
 *
 * The only route external history has into Atlas, and it goes through the
 * protocol: each installed agent is asked for its own session list
 * (ADR-0001). An agent that cannot answer is listed anyway, disabled, with the
 * capability it is missing named — a user who cannot find their agent has no
 * way to tell a missing feature from a missing agent.
 *
 * Composed from the same Dialog shell, tokens and type scale as the other
 * modals; no new visual pattern.
 */
export function ImportThreadsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  // Probing starts every installed agent, so it only runs while the modal is
  // actually open.
  useEffect(() => {
    if (!open) {
      setCandidates(null);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    void importCandidates()
      .then((found) => {
        if (cancelled) return;
        setCandidates(found);
        // Pre-select everything with something to offer: the common case is
        // "yes, all of it".
        setSelected(
          new Set(
            found
              .filter((c) => c.status.kind === "ready" && c.status.importable > 0)
              .map((c) => c.pluginId),
          ),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCandidates([]);
        toast.error(`Couldn't check for importable sessions: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggle = useCallback((pluginId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(pluginId)) next.add(pluginId);
      return next;
    });
  }, []);

  const runImport = useCallback(async () => {
    setImporting(true);
    try {
      const count = await importThreads([...selected]);
      toast.success(
        count === 0
          ? "Nothing new to import"
          : `Imported ${count} ${count === 1 ? "session" : "sessions"} into your history`,
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(`Import failed: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  }, [selected, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-md animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Import sessions
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>

          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            Bring in sessions your agents kept for themselves — started in a terminal, or in another
            client. Imported sessions land in your history rather than the active list.
          </p>

          <div className="flex-1 overflow-auto hide-scrollbar px-2 py-2">
            {candidates === null ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                Asking your agents…
              </div>
            ) : candidates.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                No agents installed. Install one from the Marketplace first.
              </div>
            ) : (
              candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.pluginId}
                  candidate={candidate}
                  checked={selected.has(candidate.pluginId)}
                  onToggle={() => toggle(candidate.pluginId)}
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
              disabled={importing || selected.size === 0}
              onClick={() => void runImport()}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ImportCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const selectable = candidate.status.kind === "ready" && candidate.status.importable > 0;
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={!selectable}
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 w-full rounded px-2 py-1.5 text-left transition-colors",
        !selectable && "cursor-not-allowed opacity-60",
        selectable && (checked ? "bg-element-selected" : "cursor-pointer hover:bg-element-hover"),
      )}
    >
      <span className="flex-1 min-w-0 truncate text-xs text-foreground">
        {candidate.displayName}
      </span>
      <CandidateStatus status={candidate.status} />
      {checked && <Check size={12} className="text-secondary-foreground shrink-0" />}
    </button>
  );
}

function CandidateStatus({ status }: { status: ImportCandidate["status"] }) {
  if (status.kind === "ready") {
    return (
      <span className="shrink-0 text-2xs font-mono tabular-nums text-muted-foreground">
        {status.importable === 0
          ? "nothing new"
          : `${status.importable} ${status.importable === 1 ? "session" : "sessions"}`}
      </span>
    );
  }
  // Named and *visible*: a `title` on a disabled control shows no tooltip, so
  // the one thing the user needs — which capability their agent is missing —
  // would never appear.
  const reason = status.kind === "unsupported" ? "no session/list support" : status.message;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground">
      <AlertTriangle size={10} className="shrink-0" />
      <span className="truncate" title={reason}>
        {reason}
      </span>
    </span>
  );
}
