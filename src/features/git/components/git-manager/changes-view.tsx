import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  Minus,
  Undo2,
  AlertTriangle,
  GitCompare,
  FileCode2,
  ChevronRight,
  CircleCheck,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./section-header";
import { useGitStore, type GitFileStatus, type StashEntry } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { openGitDiff } from "../../lib/git-diff-api";
import { hunkWireLines, type DiffHunk } from "../../lib/diff";
import { GitOpOutput } from "./git-op-output";
import { ConflictsView } from "./conflicts-view";
import { CommitComposer } from "./commit-composer";
import { openFile as openFileTab } from "@/lib/open-file";
import { useAppStore } from "@/features/app/stores/app-store";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { DiffView } from "../diff-view";
import { classifyFile } from "@/lib/file-types";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { Button, EmptyState, IconButton, HintGroup, HintItem } from "@tryatlas/design";

/** An added/untracked file has no HEAD version, so "revert" = delete it (a plain
 *  `git restore` errors). Mirrors the loose detection in `statusBadge`. */
function isAddedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("add") || s.includes("new") || s.includes("untrack");
}

function statusBadge(status: string): { letter: string; cls: string; word: string } {
  const s = status.toLowerCase();
  if (s.includes("delet")) return { letter: "D", cls: "text-error", word: "Deleted" };
  if (s.includes("add") || s.includes("new") || s.includes("untrack"))
    return { letter: "A", cls: "text-success", word: "Added" };
  if (s.includes("renam")) return { letter: "R", cls: "text-info", word: "Renamed" };
  if (s.includes("conflict") || s.includes("unmerg"))
    return { letter: "!", cls: "text-error", word: "Conflicted" };
  return { letter: "M", cls: "text-warning", word: "Modified" };
}

/** One changed file: its icon, its name with the folder dimmed before it,
 *  the status letter last, and the row's actions on hover or focus. Memoised,
 *  with callbacks that take the file rather than closing over it, so the
 *  list's parent re-rendering (a keystroke in the summary, a refresh that
 *  changed nothing) re-renders no rows: a big change set is thousands. */
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
      aria-selected={selected}
      className={cn(
        "group flex h-control-sm cursor-pointer items-center gap-1.5 pr-1 pl-2.5 text-xs transition-colors duration-fast",
        selected ? "bg-element-selected" : "hover:bg-element-hover focus-within:bg-element-hover",
      )}
    >
      <FileIcon path={file.path} size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span
          className={cn(
            "text-secondary-foreground group-hover:text-foreground",
            selected && "text-foreground",
          )}
        >
          {name}
        </span>
        {dir && <span className="ml-1.5 text-muted-foreground">{dir.replace(/\/$/, "")}</span>}
      </span>
      <HintGroup>
        <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {onOpenDiff && (
            <HintItem label="Open in review diff">
              <IconButton
                size="xs"
                icon={GitCompare}
                label="Open in review diff"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDiff(file);
                }}
              />
            </HintItem>
          )}
          {onOpenInEditor && (
            <HintItem label="Open in code editor">
              <IconButton
                size="xs"
                icon={FileCode2}
                label="Open in code editor"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInEditor(file.path);
                }}
              />
            </HintItem>
          )}
          {onDiscard && (
            <HintItem label="Discard changes">
              <IconButton
                size="xs"
                variant="ghost-destructive"
                icon={Undo2}
                label="Discard changes"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard(file);
                }}
              />
            </HintItem>
          )}
          <HintItem label={action === "stage" ? "Stage" : "Unstage"}>
            <IconButton
              size="xs"
              icon={action === "stage" ? Plus : Minus}
              label={action === "stage" ? "Stage" : "Unstage"}
              onClick={(e) => {
                e.stopPropagation();
                onAction(file);
              }}
            />
          </HintItem>
        </div>
      </HintGroup>
      <span
        title={badge.word}
        className={cn("w-3 shrink-0 text-center font-mono text-2xs font-semibold", badge.cls)}
      >
        {badge.letter}
      </span>
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

/** Stashes, at the end of the file list: folded until opened, and absent
 *  when there are none. Stashing itself is in the branch bar's menu. */
function StashesGroup({ stashes }: { stashes: StashEntry[] }) {
  const actions = useGitStore.use.actions();
  const [open, setOpen] = useState(false);
  if (stashes.length === 0) return null;
  return (
    <div>
      <SectionHeader title={`Stashes (${stashes.length})`}>
        <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
          <ChevronRight
            size={10}
            aria-hidden
            className={cn(
              "transition-transform duration-fast ease-out-strong motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </Button>
      </SectionHeader>
      {open &&
        stashes.map((s) => (
          <div
            key={s.index}
            className="group flex h-control-md items-center gap-1.5 pr-1 pl-2.5 text-xs transition-colors duration-fast hover:bg-element-hover focus-within:bg-element-hover"
          >
            <span
              title={s.branch ? `${s.message}\nstash@{${s.index}} · ${s.branch}` : s.message}
              className="min-w-0 flex-1 truncate text-secondary-foreground group-hover:text-foreground"
            >
              {s.message}
            </span>
            <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => run(() => actions.stashApply(s.index))}
              >
                Apply
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => run(() => actions.stashPop(s.index))}
              >
                Pop
              </Button>
              <Button
                variant="ghost-destructive"
                size="xs"
                onClick={() => run(() => actions.stashDrop(s.index))}
              >
                Drop
              </Button>
            </span>
          </div>
        ))}
    </div>
  );
}

/**
 * The Changes view: the in-progress banner and conflicts when there are any,
 * the changed files at full height, the selected file's diff with hunk and
 * line staging, and the commit box.
 *
 * The whole working tree's diff is the review diff tab's job ("Review all
 * changes"); this panel shows one file's at a time, because only here can a
 * hunk or a few lines be staged or discarded.
 */
export function ChangesView() {
  const files = useGitStore.use.files();
  const stashes = useGitStore.use.stashes();
  const inProgress = useGitStore.use.inProgress();
  const repoPath = useGitStore.use.repoPath();
  const actions = useGitStore.use.actions();
  const currentProject = useAppStore.use.currentProject();

  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  // Bumped after a hunk op: discarding one hunk of several leaves the file
  // list as it was, so `files` alone would not reload the diff.
  const [diffEpoch, setDiffEpoch] = useState(0);

  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstaged = useMemo(() => files.filter((f) => !f.staged), [files]);

  // A selection whose file is gone (committed, discarded) closes its diff.
  useEffect(() => {
    if (selected && !files.some((f) => f.path === selected)) setSelected(null);
  }, [files, selected]);

  // Load the selected file's diff.
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
  }, [selected, repoPath, files, diffEpoch]);

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
      setDiffEpoch((n) => n + 1);
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

  const opKind: "merge" | "rebase" | "cherry-pick" | "revert" | null = !inProgress
    ? null
    : inProgress.merge
      ? "merge"
      : inProgress.rebase
        ? "rebase"
        : inProgress.cherryPick
          ? "cherry-pick"
          : "revert";

  const hasConflicts = useMemo(() => files.some((f) => f.status === "conflicted"), [files]);
  const selectedStaged = staged.some((f) => f.path === selected);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {opKind && (
        <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border-subtle bg-warning-muted pr-1.5 pl-3 text-xs">
          <AlertTriangle size={12} className="shrink-0 text-warning" />
          <span className="flex-1 text-secondary-foreground">
            Resolving <span className="font-semibold text-foreground">{opKind}</span>
          </span>
          <Button
            size="sm"
            onClick={() => run(() => actions.opControl(opKind, "continue"))}
            disabled={hasConflicts}
            title={hasConflicts ? "Resolve all conflicts first" : undefined}
          >
            Continue
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run(() => actions.opControl(opKind, "abort"))}
          >
            Abort
          </Button>
        </div>
      )}

      {/* Conflicted files (in-progress merge/rebase/cherry-pick only). */}
      {opKind && <ConflictsView onOpenFile={openFile} />}

      {/* The file list takes the height; a selected file's diff shares it. */}
      <div
        className={cn(
          "min-h-0 overflow-y-auto hide-scrollbar",
          selected ? "max-h-[40%] shrink-0 border-b border-border-subtle" : "flex-1",
        )}
      >
        {files.length === 0 ? (
          <div className="flex h-full flex-col">
            <EmptyState
              className="min-h-0 flex-1"
              icon={CircleCheck}
              title="Working tree clean"
              description="Changes the agent or you make show up here."
            />
            <StashesGroup stashes={stashes} />
          </div>
        ) : (
          <>
            {staged.length > 0 && (
              <div>
                <SectionHeader title={`Staged (${staged.length})`}>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => run(() => actions.unstageFiles(staged.map((f) => f.path)))}
                  >
                    Unstage all
                  </Button>
                </SectionHeader>
                {staged.map((f) => (
                  <FileRow
                    key={`s:${f.path}`}
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

            {unstaged.length > 0 && (
              <div>
                <SectionHeader title={`Changes (${unstaged.length})`}>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => run(() => actions.stageFiles(unstaged.map((f) => f.path)))}
                  >
                    Stage all
                  </Button>
                  <Button
                    variant="ghost-destructive"
                    size="xs"
                    onClick={() => setConfirmRevertAll(true)}
                    title="Discard all unstaged changes"
                  >
                    Discard all
                  </Button>
                </SectionHeader>
                {unstaged.map((f) => (
                  <FileRow
                    key={`u:${f.path}`}
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
              </div>
            )}

            <StashesGroup stashes={stashes} />

            {files.length > 0 && repoPath && (
              <div className="px-1.5 py-1.5">
                <Button variant="ghost" size="xs" onClick={() => openGitDiff(repoPath, "", false)}>
                  <GitCompare size={12} />
                  Review all changes
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* The selected file's diff, with hunk and line staging. */}
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-control-md shrink-0 items-center gap-1.5 border-b border-border-subtle pr-1 pl-2.5">
            <FileIcon path={selected} size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={selected}>
              {selected}
            </span>
            {repoPath && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => openGitDiff(repoPath, selected, selectedStaged)}
              >
                Open in review
              </Button>
            )}
            <IconButton size="xs" icon={X} label="Close diff" onClick={() => setSelected(null)} />
          </div>
          <DiffView
            diff={fileDiff ?? ""}
            onOpenFile={openFile}
            onOpenDiff={repoPath ? (p) => openGitDiff(repoPath, p, false) : undefined}
            emptyLabel="No diff for this file"
            className="flex-1"
            hunkActions={["stage", "discard"]}
            onHunkAction={onHunkAction}
          />
        </div>
      )}

      {/* Live output from a streaming git op (hooks etc.) */}
      <GitOpOutput />

      <CommitComposer stagedCount={staged.length} />

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
        title="Discard all changes?"
        confirmLabel="Discard all"
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
