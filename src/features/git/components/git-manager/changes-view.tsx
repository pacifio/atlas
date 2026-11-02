import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  Minus,
  Undo2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  GitCompare,
  FileCode2,
  GitCommitHorizontal,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useGitStore, retainGitDiff, type GitFileStatus } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { openGitDiff } from "../../lib/git-diff-api";
import { hunkWireLines, type DiffHunk } from "../../lib/diff";
import { GitOpOutput } from "./git-op-output";
import { ConflictsView } from "./conflicts-view";
import { openFile as openFileTab } from "@/lib/open-file";
import { useAppStore } from "@/features/app/stores/app-store";
import { DiffView } from "../diff-view";
import { classifyFile } from "@/lib/file-types";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";

/** Expand/collapse toggle for an optional commit-form field. The chevron
 *  flips with state; a collapsed field that still holds text shows a dot so
 *  its content can't be committed invisibly by surprise. */
function FieldToggle({
  open,
  hasContent,
  label,
  onToggle,
}: {
  open: boolean;
  hasContent: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-secondary-foreground"
      title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
    >
      {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      {label}
      {!open && hasContent && (
        <span className="inline-block w-1 h-1 rounded-full bg-[var(--primary)]" />
      )}
    </button>
  );
}

/** An added/untracked file has no HEAD version, so "revert" = delete it (a plain
 *  `git restore` errors). Mirrors the loose detection in `statusBadge`. */
function isAddedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("add") || s.includes("new") || s.includes("untrack");
}

function statusBadge(status: string): { letter: string; cls: string } {
  const s = status.toLowerCase();
  if (s.includes("delet")) return { letter: "D", cls: "text-error" };
  if (s.includes("add") || s.includes("new") || s.includes("untrack"))
    return { letter: "A", cls: "text-success" };
  if (s.includes("renam"))
    return { letter: "R", cls: "text-[var(--atlas-status-info-foreground)]" };
  if (s.includes("conflict") || s.includes("unmerg")) return { letter: "!", cls: "text-error" };
  return { letter: "M", cls: "text-[var(--atlas-status-warning-foreground)]" };
}

/** One changed file. Memoised, with callbacks that take the file rather than
 *  closing over it, so the list's parent re-rendering (a keystroke in the
 *  summary, a refresh that changed nothing) re-renders no rows: a big change
 *  set is thousands of them. */
const FileRow = memo(function FileRow({
  file,
  selected,
  onSelect,
  action,
  onAction,
  onDiscard,
  onOpenDiff,
  onOpenInEditor,
}: {
  file: GitFileStatus;
  selected: boolean;
  onSelect: (path: string) => void;
  action: "stage" | "unstage";
  onAction: (file: GitFileStatus) => void;
  onDiscard?: (file: GitFileStatus) => void;
  onOpenDiff?: (file: GitFileStatus) => void;
  onOpenInEditor?: (path: string) => void;
}) {
  const badge = statusBadge(file.status);
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <div
      onClick={() => onSelect(file.path)}
      className={cn(
        "group flex items-center gap-1.5 h-control-sm px-2 cursor-pointer text-xs",
        selected ? "bg-element-selected" : "hover:bg-element-hover",
      )}
    >
      <span className={cn("shrink-0 w-3 text-center font-mono text-2xs font-semibold", badge.cls)}>
        {badge.letter}
      </span>
      <span className="truncate flex-1 min-w-0 font-mono">
        {dir && <span className="text-muted-foreground">{dir}</span>}
        <span className="text-secondary-foreground group-hover:text-foreground">{name}</span>
      </span>
      <HintGroup>
        <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
          {onOpenDiff && (
            <HintItem label="Open in diff view">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDiff(file);
                }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground"
              >
                <GitCompare size={11} />
              </button>
            </HintItem>
          )}
          {onOpenInEditor && (
            <HintItem label="Open in code editor">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInEditor(file.path);
                }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground"
              >
                <FileCode2 size={11} />
              </button>
            </HintItem>
          )}
          {onDiscard && (
            <HintItem label="Discard changes">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard(file);
                }}
                className="p-0.5 rounded text-muted-foreground hover:text-[var(--atlas-status-error-foreground)]"
              >
                <Undo2 size={11} />
              </button>
            </HintItem>
          )}
          <HintItem label={action === "stage" ? "Stage" : "Unstage"}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAction(file);
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground"
            >
              {action === "stage" ? <Plus size={12} /> : <Minus size={12} />}
            </button>
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
});

async function run(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    handleGitError(e);
  }
}

export function ChangesView() {
  const files = useGitStore.use.files();
  const diff = useGitStore.use.diff();
  const inProgress = useGitStore.use.inProgress();
  const repoPath = useGitStore.use.repoPath();
  const actions = useGitStore.use.actions();
  const currentProject = useAppStore.use.currentProject();

  // This is the only reader of the whole-working-tree `diff` — the store
  // skips refreshing it while nothing is retaining (see retainGitDiff).
  useEffect(() => retainGitDiff(), []);

  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [showDesc, setShowDesc] = useState(false);
  const [showCoAuthors, setShowCoAuthors] = useState(false);
  const [coAuthors, setCoAuthors] = useState("");

  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstaged = useMemo(() => files.filter((f) => !f.staged), [files]);

  // Load the selected file's diff (falls back to the full working diff).
  useEffect(() => {
    if (!selected || !repoPath) {
      setFileDiff(null);
      return;
    }
    let cancelled = false;
    void invoke<string>("git_diff_file", { path: repoPath, file: selected })
      .then((d) => {
        if (!cancelled) setFileDiff(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, repoPath, files]);

  // Revert button. Tracked changes → `git restore` (back to HEAD). Added/
  // untracked files have no HEAD to restore to, so reverting deletes them:
  // text additions delete directly; binary additions (e.g. `.png`, no diff to
  // review) ask for confirmation first since the bytes can't be recovered.
  const [confirmDelete, setConfirmDelete] = useState<GitFileStatus | null>(null);
  // Bulk revert of every unstaged change — discards tracked edits AND deletes
  // added files, so it always confirms first (unlike "Stage all").
  const [confirmRevertAll, setConfirmRevertAll] = useState(false);
  const revertAll = () =>
    run(async () => {
      const tracked = unstaged.filter((f) => !isAddedStatus(f.status)).map((f) => f.path);
      const added = unstaged.filter((f) => isAddedStatus(f.status)).map((f) => f.path);
      if (tracked.length) await actions.discard(tracked);
      if (added.length) await actions.discardAdded(added);
    });
  const handleRevert = useCallback(
    (f: GitFileStatus) => {
      if (!isAddedStatus(f.status)) {
        void run(() => actions.discard([f.path]));
        return;
      }
      const kind = classifyFile(f.path);
      const isText = kind === "text" || kind === "svg";
      if (isText) void run(() => actions.discardAdded([f.path]));
      else setConfirmDelete(f);
    },
    [actions],
  );

  // Hunk / line-level staging: send the hunk exactly as displayed; Rust
  // re-diffs fresh, matches it by content, synthesizes the patch and runs
  // `git apply`. Discards confirm first (destructive).
  const [confirmHunkDiscard, setConfirmHunkDiscard] = useState<{
    file: string;
    hunk: DiffHunk;
    selected?: number[];
  } | null>(null);

  const runHunkOp = (cmd: string, file: string, hunk: DiffHunk, selected?: number[]) =>
    run(async () => {
      if (!repoPath) return;
      await invoke(cmd, {
        path: repoPath,
        file,
        lines: hunkWireLines(hunk),
        selected: selected ?? null,
      });
      await actions.refresh(repoPath);
      void actions.loadDiff();
    });

  const onHunkAction = (
    action: "stage" | "unstage" | "discard",
    file: string,
    hunk: DiffHunk,
    selected?: number[],
  ) => {
    if (action === "discard") {
      setConfirmHunkDiscard({ file, hunk, selected });
      return;
    }
    void runHunkOp(
      action === "stage" ? "git_stage_hunk" : "git_unstage_hunk",
      file,
      hunk,
      selected,
    );
  };

  // Busy while OUR streaming commit runs — a slow pre-commit hook
  // (lint-staged & co.) used to look like a hung app because the button
  // gave no feedback. The live output strip below the form shows what the
  // hook is doing meanwhile.
  // A boolean, not the op: the op changes on every output batch the hook
  // prints, and re-rendering this view per batch re-rendered every file row
  // (see `GitManagerPanel`).
  const committing = useGitStore((s) => s.activeOp?.kind === "commit" && s.activeOp.running);

  const doCommit = () =>
    run(async () => {
      // Amend with an empty summary keeps the original message.
      if ((!summary.trim() && !amend) || committing) return;
      const authors = coAuthors
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      await actions.commit(
        summary.trim(),
        description.trim() || undefined,
        amend,
        authors.length > 0 ? authors : undefined,
      );
      setSummary("");
      setDescription("");
      setAmend(false);
      setShowDesc(false);
      setCoAuthors("");
      setShowCoAuthors(false);
    });

  const openFile = useCallback(
    (p: string) => {
      if (!currentProject) return;
      void openFileTab(`${currentProject.path}/${p}`);
    },
    [currentProject],
  );

  // Row callbacks, stable so the memoised rows skip re-rendering.
  const toggleSelected = useCallback(
    (p: string) => setSelected((cur) => (cur === p ? null : p)),
    [],
  );
  const stageOne = useCallback(
    (f: GitFileStatus) => void run(() => actions.stageFiles([f.path])),
    [actions],
  );
  const unstageOne = useCallback(
    (f: GitFileStatus) => void run(() => actions.unstageFiles([f.path])),
    [actions],
  );
  const openDiff = useCallback(
    (f: GitFileStatus) => {
      if (repoPath) openGitDiff(repoPath, f.path, f.staged);
    },
    [repoPath],
  );

  const inProgressLabel = inProgress
    ? inProgress.merge
      ? "merge"
      : inProgress.rebase
        ? "rebase"
        : inProgress.cherryPick
          ? "cherry-pick"
          : "revert"
    : null;
  const opKind: "merge" | "rebase" | "cherry-pick" | "revert" = inProgress?.merge
    ? "merge"
    : inProgress?.rebase
      ? "rebase"
      : inProgress?.cherryPick
        ? "cherry-pick"
        : "revert";

  const hasConflicts = useMemo(() => files.some((f) => f.status === "conflicted"), [files]);

  // Amending never requires a new summary (empty = keep the original
  // message, like `git commit --amend --no-edit`).
  const canCommit =
    (staged.length > 0 || amend) && (summary.trim().length > 0 || amend) && !committing;

  return (
    <div className="h-full flex flex-col min-w-0">
      {inProgressLabel && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--atlas-status-warning-foreground)]/30 bg-[var(--atlas-status-warning-foreground)]/10 text-xs">
          <AlertTriangle
            size={12}
            className="text-[var(--atlas-status-warning-foreground)] shrink-0"
          />
          <span className="flex-1 text-secondary-foreground">
            Resolving <span className="font-medium text-foreground">{inProgressLabel}</span>
          </span>
          <button
            onClick={() => run(() => actions.opControl(opKind, "continue"))}
            disabled={hasConflicts}
            title={hasConflicts ? "Resolve all conflicts first" : undefined}
            className="px-2 h-6 rounded text-2xs font-medium bg-[var(--primary)] text-[var(--background)] hover:bg-[var(--atlas-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
          <button
            onClick={() => run(() => actions.opControl(opKind, "abort"))}
            className="px-2 h-6 rounded text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground"
          >
            Abort
          </button>
        </div>
      )}

      {/* Conflicted files (in-progress merge/rebase/cherry-pick only). */}
      {inProgressLabel && <ConflictsView onOpenFile={openFile} />}

      {/* File lists — bounded so the diff region below gets room. */}
      <div className="shrink-0 max-h-[45%] overflow-y-auto hide-scrollbar border-b border-border">
        {/* Staged */}
        {staged.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-2 h-control-sm sticky top-0 bg-[var(--sidebar)] border-b border-border-subtle">
              <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
                Staged ({staged.length})
              </span>
              <button
                onClick={() => run(() => actions.unstageFiles(staged.map((f) => f.path)))}
                className="text-2xs text-muted-foreground hover:text-foreground"
              >
                Unstage all
              </button>
            </div>
            {staged.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                selected={selected === f.path}
                onSelect={toggleSelected}
                action="unstage"
                onAction={unstageOne}
                onOpenDiff={repoPath ? openDiff : undefined}
                onOpenInEditor={openFile}
              />
            ))}
          </div>
        )}

        {/* Unstaged */}
        <div>
          <div className="flex items-center justify-between px-2 h-control-sm sticky top-0 bg-[var(--sidebar)] border-b border-border-subtle">
            <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
              Changes ({unstaged.length})
            </span>
            {unstaged.length > 0 && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => run(() => actions.stageFiles(unstaged.map((f) => f.path)))}
                  className="text-2xs text-muted-foreground hover:text-foreground"
                >
                  Stage all
                </button>
                <span className="w-px h-3 bg-border" />
                <button
                  onClick={() => setConfirmRevertAll(true)}
                  className="text-2xs text-muted-foreground hover:text-[var(--atlas-status-error-foreground)]"
                  title="Discard all unstaged changes"
                >
                  Revert all
                </button>
              </div>
            )}
          </div>
          {unstaged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              selected={selected === f.path}
              onSelect={toggleSelected}
              action="stage"
              onAction={stageOne}
              onDiscard={handleRevert}
              onOpenDiff={repoPath ? openDiff : undefined}
              onOpenInEditor={openFile}
            />
          ))}
          {files.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No changes — working tree clean
            </div>
          )}
        </div>
      </div>

      {/* Diff of the selected file (or the full working diff, with the
          changed-file filter/sort/language header). */}
      <DiffView
        diff={fileDiff ?? diff}
        onOpenFile={openFile}
        onOpenDiff={repoPath ? (p) => openGitDiff(repoPath, p, false) : undefined}
        onRefresh={() => run(() => actions.loadDiff())}
        filters={!selected}
        emptyLabel={selected ? "No diff for this file" : "No changes"}
        className="flex-1"
        hunkActions={["stage", "discard"]}
        onHunkAction={onHunkAction}
      />

      {/* Live output from a streaming git op (hooks etc.) */}
      <GitOpOutput />

      {/* Commit form */}
      <div className="shrink-0 border-t border-border p-2 space-y-1.5">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={amend ? "Amend message (empty = keep original)" : "Summary (required)"}
          className="w-full h-7 rounded-md border border-border bg-panel-input px-2 text-xs text-foreground outline-none focus:border-border-strong"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit();
          }}
        />
        {/* Optional-field toggles — always visible, so an opened field can be
            collapsed again. Hidden text is kept (and still committed); the dot
            marks a collapsed field that has content. */}
        <div className="flex items-center gap-2.5">
          <FieldToggle
            open={showDesc}
            hasContent={description.trim().length > 0}
            label="Description"
            onToggle={() => setShowDesc((v) => !v)}
          />
          <FieldToggle
            open={showCoAuthors}
            hasContent={coAuthors.trim().length > 0}
            label="Co-authors"
            onToggle={() => setShowCoAuthors((v) => !v)}
          />
        </div>
        {showDesc && (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="w-full rounded-md border border-border bg-panel-input px-2 py-1.5 text-xs text-foreground outline-none focus:border-border-strong resize-none"
          />
        )}
        {showCoAuthors && (
          <input
            value={coAuthors}
            onChange={(e) => setCoAuthors(e.target.value)}
            placeholder="Co-authors: Name <email>, Name <email>"
            className="w-full h-7 rounded-md border border-border bg-panel-input px-2 text-xs font-mono text-foreground outline-none focus:border-border-strong"
            title="Added as Co-authored-by trailers"
          />
        )}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Amend last commit
          </label>
          {/* The house pill, same as the session-capture footer's actions and
              the create-organisation modal's. The old style was a filled white
              rectangle when enabled and a flat grey slab when not — two shapes
              for one button, neither of them the app's own language. The pill
              keeps its outline in both states and dims rather than changing
              colour, so the control stays the same object while it waits for a
              summary. */}
          <button
            onClick={doCommit}
            disabled={!canCommit}
            className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--card)]"
          >
            {committing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <GitCommitHorizontal size={11} />
            )}
            {committing ? "Committing…" : amend ? "Amend" : "Commit"}
          </button>
        </div>
      </div>

      <FileTreeConfirmDelete
        open={confirmDelete !== null}
        name={confirmDelete?.path.split("/").pop() ?? ""}
        isDir={false}
        onConfirm={() => {
          if (confirmDelete) void run(() => actions.discardAdded([confirmDelete.path]));
          setConfirmDelete(null);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      />

      <FileTreeConfirmDelete
        open={confirmHunkDiscard !== null}
        name=""
        isDir={false}
        title="Discard these changes?"
        confirmLabel="Discard"
        body={
          <>
            {confirmHunkDiscard?.selected
              ? `${confirmHunkDiscard.selected.length} selected line${
                  confirmHunkDiscard.selected.length === 1 ? "" : "s"
                }`
              : "This hunk"}{" "}
            in <span className="font-mono text-foreground">{confirmHunkDiscard?.file}</span> will be
            reverted in your working tree. This can't be undone.
          </>
        }
        onConfirm={() => {
          if (confirmHunkDiscard) {
            void runHunkOp(
              "git_discard_hunk",
              confirmHunkDiscard.file,
              confirmHunkDiscard.hunk,
              confirmHunkDiscard.selected,
            );
          }
          setConfirmHunkDiscard(null);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmHunkDiscard(null);
        }}
      />

      <FileTreeConfirmDelete
        open={confirmRevertAll}
        name=""
        isDir={false}
        title="Revert all changes?"
        confirmLabel="Revert all"
        body={
          <>
            All{" "}
            <span className="font-mono text-foreground">
              {unstaged.length} unstaged change{unstaged.length === 1 ? "" : "s"}
            </span>{" "}
            will be discarded and any newly added files deleted. This can't be undone.
          </>
        }
        onConfirm={() => {
          void revertAll();
          setConfirmRevertAll(false);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmRevertAll(false);
        }}
      />
    </div>
  );
}
