import { useMemo, useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { Check, Search, Loader2, GitMerge, AlertTriangle, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore, type MergePreview } from "../../stores/git-store";

/**
 * GitHub-Desktop-style "Choose a branch to merge into <current>" dialog.
 * Pick a branch, see a live pre-merge preview (commits brought in / conflict
 * count / up-to-date / unrelated histories), then merge. The actual merge
 * reuses the existing `mergeBranch` action (`git merge --no-edit`).
 */
export function MergeBranchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const branch = useGitStore.use.branch();
  const branchesFull = useGitStore.use.branchesFull();
  const actions = useGitStore.use.actions();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [merging, setMerging] = useState(false);

  // Everything except the branch we're merging *into*.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branchesFull.filter((b) => !b.isCurrent && (!q || b.name.toLowerCase().includes(q)));
  }, [branchesFull, query]);

  // Reset all transient state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected(null);
      setPreview(null);
      setPreviewing(false);
    }
  }, [open]);

  // Recompute the preview whenever the chosen branch changes.
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreview(null);
    actions
      .mergePreview(selected)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, actions]);

  const canMerge =
    !!selected &&
    !merging &&
    !previewing &&
    preview != null &&
    preview.kind !== "uptodate" &&
    preview.kind !== "invalid";

  const doMerge = async () => {
    if (!selected) return;
    setMerging(true);
    const wasConflicts = preview?.kind === "conflicts";
    try {
      await actions.mergeBranch(selected);
      toast.success(`Merged ${selected} into ${branch}`);
      onOpenChange(false);
    } catch (e) {
      // `git merge` exits non-zero on conflicts (the merge is still started —
      // MERGE_HEAD is set), so an error here usually means "conflicts to
      // resolve" rather than an outright failure.
      if (wasConflicts) {
        toast.warning(`Merged ${selected} with conflicts — resolve them to finish`);
      } else {
        toast.error(String(e));
      }
      onOpenChange(false);
    } finally {
      // `git_merge_branch` skips its change-event when git exits non-zero, so
      // force a refresh — this surfaces the in-progress/conflict banner.
      void actions.refreshStatusNow();
      void actions.loadInProgress();
      setMerging(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          className="fixed left-1/2 top-[22%] -translate-x-1/2 z-[var(--z-modal)] w-[420px] rounded-xl overflow-hidden bg-[var(--bg-elevated)] border border-border-default shadow-[var(--shadow-overlay)] flex flex-col"
          onOpenAutoFocus={(e) => {
            // Keep focus on the filter input (rendered below), not the list.
            e.preventDefault();
          }}
        >
          <div className="px-4 pt-3.5 pb-3 border-b border-border-default">
            <Dialog.Title className="text-[13px] font-semibold text-text-primary flex items-center gap-1.5">
              <GitMerge size={13} className="text-text-secondary shrink-0" />
              <span>
                Merge into <span className="font-mono text-accent">{branch || "—"}</span>
              </span>
            </Dialog.Title>
            <Dialog.Description className="text-[11px] text-text-tertiary mt-1">
              Choose a branch to merge into{" "}
              <span className="font-mono">{branch || "the current branch"}</span>.
            </Dialog.Description>
          </div>

          {/* Filter */}
          <div className="flex items-center gap-1.5 px-3 h-[32px] border-b border-border-default shrink-0">
            <Search size={11} className="text-text-tertiary shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter branches…"
              autoFocus
              className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
            />
          </div>

          {/* Branch list */}
          <div className="max-h-[260px] overflow-y-auto hide-scrollbar py-1">
            {filtered.map((b) => {
              const isSel = b.name === selected;
              return (
                <div
                  key={b.name}
                  role="option"
                  aria-selected={isSel}
                  onClick={() => setSelected(b.name)}
                  className={cn(
                    "group flex items-center gap-2 px-3 h-[28px] text-[11px] cursor-pointer",
                    isSel
                      ? "bg-bg-selected text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  )}
                >
                  <Check
                    size={12}
                    className={cn("shrink-0", isSel ? "text-accent" : "opacity-0")}
                  />
                  <span className="truncate flex-1 font-mono">{b.name}</span>
                  {b.isRemote && (
                    <span className="shrink-0 text-[8px] font-mono uppercase tracking-wide text-text-tertiary border border-border-default rounded px-1">
                      remote
                    </span>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-text-tertiary text-center">
                No other branches
              </div>
            )}
          </div>

          {/* Preview + actions */}
          <div className="border-t border-border-default px-3 py-2.5 flex flex-col gap-2.5">
            <MergePreviewLine
              selected={selected}
              current={branch}
              previewing={previewing}
              preview={preview}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => onOpenChange(false)}
                className="px-3 h-7 rounded text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void doMerge()}
                disabled={!canMerge}
                className={cn(
                  "flex items-center gap-1.5 px-3 h-7 rounded text-[11px] font-medium transition-colors",
                  canMerge
                    ? "text-white bg-accent hover:opacity-90"
                    : "text-text-tertiary bg-bg-hover cursor-not-allowed",
                )}
              >
                {merging ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />}
                {selected ? `Merge ${selected}` : "Merge"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MergePreviewLine({
  selected,
  current,
  previewing,
  preview,
}: {
  selected: string | null;
  current: string;
  previewing: boolean;
  preview: MergePreview | null;
}) {
  if (!selected) {
    return (
      <p className="text-[11px] text-text-tertiary">
        Select a branch to see what merging it would do.
      </p>
    );
  }
  if (previewing || !preview) {
    return (
      <p className="text-[11px] text-text-tertiary flex items-center gap-1.5">
        <Loader2 size={11} className="animate-spin shrink-0" />
        Checking for ability to merge automatically…
      </p>
    );
  }

  const src = <span className="font-mono">{selected}</span>;
  const dst = <span className="font-mono">{current}</span>;
  const n = preview.commitCount;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

  switch (preview.kind) {
    case "uptodate":
      return (
        <p className="text-[11px] text-text-tertiary">
          {dst} is already up to date with {src}.
        </p>
      );
    case "invalid":
      return (
        <p className="text-[11px] text-[var(--status-error)] flex items-center gap-1.5">
          <Ban size={11} className="shrink-0" />
          Unable to merge unrelated histories.
        </p>
      );
    case "conflicts":
      return (
        <p className="text-[11px] text-[var(--status-warning)] flex items-center gap-1.5">
          <AlertTriangle size={11} className="shrink-0" />
          <span>
            {plural(preview.conflictedFiles, "file")} will conflict when merging {src} into {dst}.
            You can still merge and resolve them.
          </span>
        </p>
      );
    case "unsupported":
      return (
        <p className="text-[11px] text-text-secondary">
          This will merge {plural(n, "commit")} from {src} into {dst}.
        </p>
      );
    case "clean":
    default:
      return (
        <p className="text-[11px] text-text-secondary">
          This will merge {plural(n, "commit")} from {src} into {dst}.
        </p>
      );
  }
}
