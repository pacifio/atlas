import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitCommitVertical, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useGitStore } from "@/features/git/stores/git-store";
import { CommitRowView } from "@/features/git/components/commit-node";
import { ROW_HEIGHT, type BuiltGraph } from "@/features/git/lib/git-graph";
import { resolveByok } from "../lib/byok-resolve";
import { generateCommitMessage } from "../lib/generate-commit-message";

type Phase = "idle" | "generating" | "confirm" | "committing" | "done";

/**
 * "Commit changes" affordance for the adaptive turn card. Generates a
 * Conventional-Commits message from the turn (BYOK, best-effort), shows it in an
 * EDITABLE confirm dialog with the file list, and only on confirm stages +
 * commits. After committing it renders the last-10-commits graph inline for
 * immersion. Never commits without the confirm step.
 */
export function CommitFlow({
  editedPaths,
  turnText,
}: {
  editedPaths: string[];
  turnText: string;
}) {
  const isRepo = useGitStore.use.isRepo();
  const changedFiles = useGitStore.use.files();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [graph, setGraph] = useState<BuiltGraph | null>(null);

  // Only offer "Commit changes" when the turn's edited files are actually under
  // source control — i.e. at least one shows up in `git status`. Turn paths are
  // absolute; git status paths are repo-relative, so match on a path-segment
  // suffix. Prevents the affordance appearing for edits outside the repo (e.g.
  // files in an untracked/ignored dir, or a repo with nothing staged/changed).
  const norm = (p: string) => p.replace(/\\/g, "/");
  const changed = changedFiles.map((f) => norm(f.path));
  const inSourceControl = editedPaths.some((ep) => {
    const e = norm(ep);
    return changed.some((c) => e === c || e.endsWith("/" + c));
  });

  if (!isRepo || editedPaths.length === 0 || !inSourceControl) return null;

  const open = async () => {
    setPhase("generating");
    const fallback = `chore: update ${editedPaths.length} file${editedPaths.length === 1 ? "" : "s"}`;
    const byok = resolveByok();
    let msg = "";
    if (byok) {
      msg = await generateCommitMessage({
        turnText,
        files: editedPaths,
        provider: byok.provider,
        model: byok.model,
      });
    }
    setMessage(msg || fallback);
    setPhase("confirm");
  };

  const doCommit = async () => {
    const repoPath = useGitStore.getState().repoPath;
    if (!repoPath || !message.trim()) return;
    setPhase("committing");
    try {
      const git = useGitStore.getState().actions;
      await git.stageFiles(editedPaths);
      await git.commit(message.trim());
      const built = await invoke<BuiltGraph>("git_graph_build", {
        path: repoPath,
        limit: 10,
        all: true,
      });
      setGraph(built);
      setPhase("done");
      toast.success("Committed");
    } catch (e) {
      toast.error(`Commit failed: ${e}`);
      setPhase("confirm");
    }
  };

  return (
    <>
      {phase !== "done" && (
        <button
          type="button"
          onClick={() => void open()}
          disabled={phase === "generating"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)]",
            "bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] font-medium leading-none text-[var(--text-secondary)]",
            "cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            "disabled:opacity-60",
          )}
        >
          {phase === "generating" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <GitCommitVertical size={12} />
          )}
          Commit changes
        </button>
      )}

      {graph && (
        <div className="mt-1 w-full overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            Recent commits
          </div>
          <div
            className="relative"
            style={{ height: graph.rows.length * ROW_HEIGHT }}
          >
            {graph.rows.map((row, i) => (
              <div
                key={row.sha}
                className="absolute left-0 w-full"
                style={{ transform: `translateY(${i * ROW_HEIGHT}px)` }}
              >
                <CommitRowView
                  row={row}
                  selected={i === 0}
                  compact
                  onSelect={() => {}}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog.Root
        open={phase === "confirm" || phase === "committing"}
        onOpenChange={(o) => {
          if (!o && phase !== "committing") setPhase("idle");
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-[var(--bg-elevated)]/80 p-4 shadow-[var(--shadow-overlay)] backdrop-blur-2xl">
            <Dialog.Title className="text-[13px] font-semibold text-[var(--text-primary)]">
              Commit {editedPaths.length} file
              {editedPaths.length === 1 ? "" : "s"}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              Review and edit the commit message, then commit the changed files.
            </Dialog.Description>

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="mt-3 w-full resize-none rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
            />

            <div className="mt-2 max-h-[120px] overflow-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5">
              {editedPaths.map((p) => (
                <div
                  key={p}
                  className="truncate py-0.5 text-[11px] text-[var(--text-secondary)]"
                >
                  {p}
                </div>
              ))}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPhase("idle")}
                disabled={phase === "committing"}
                className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doCommit()}
                disabled={phase === "committing" || !message.trim()}
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-[11px] font-medium text-[var(--bg-base)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {phase === "committing" && (
                  <Loader2 size={12} className="animate-spin" />
                )}
                Commit
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
