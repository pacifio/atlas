import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileCode2, Check } from "lucide-react";
import { SectionHeader } from "./section-header";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { Button, IconButton, HintGroup, HintItem } from "@tryatlas/design";

export interface ConflictFile {
  path: string;
  markerCount: number;
  xy: string;
}

export interface ConflictState {
  files: ConflictFile[];
  message: string;
}

/**
 * Conflicted-files section for an in-progress merge/rebase/cherry-pick:
 * per-file "N conflicts" counts (from `git diff --check`, so an editor-side
 * fix shows up as 0 without re-marking), ours/theirs one-click resolution
 * (side-aware — a deleted side resolves via `git rm`), open-in-editor, and
 * mark-resolved. GitHub Desktop's conflict dialog, inlined.
 */
export function ConflictsView({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const repoPath = useGitStore.use.repoPath();
  const files = useGitStore.use.files();
  const actions = useGitStore.use.actions();
  const [state, setState] = useState<ConflictState | null>(null);

  const load = useCallback(() => {
    if (!repoPath) return;
    invoke<ConflictState>("git_conflict_state", { path: repoPath })
      .then(setState)
      .catch(() => setState(null));
  }, [repoPath]);

  // Refresh whenever the file list changes (any resolution or external edit
  // lands back here via the snapshot refresh).
  useEffect(() => {
    load();
  }, [load, files]);

  const resolve = async (file: string, resolution: "ours" | "theirs" | "manual") => {
    if (!repoPath) return;
    try {
      await invoke("git_resolve_file", { path: repoPath, file, resolution });
      await actions.refresh(repoPath);
      load();
    } catch (e) {
      handleGitError(e);
    }
  };

  if (!state || state.files.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border-subtle">
      <SectionHeader title={`Conflicts (${state.files.length})`}>
        <span className="caption pr-1">resolve each file, then Continue</span>
      </SectionHeader>
      {state.files.map((f) => {
        const resolvedLabel =
          f.markerCount > 0 ? "Mark resolved (conflict markers still present!)" : "Mark resolved";
        return (
          // Keyboard focus on any of the row's actions lights the whole row,
          // the way the pointer does, so the file they act on stays clear.
          <div
            key={f.path}
            className="group flex items-center gap-1.5 h-control-md pl-2 pr-1 text-xs transition-colors duration-fast hover:bg-element-hover focus-within:bg-element-hover"
          >
            <span className="shrink-0 w-3 text-center font-mono text-2xs font-semibold text-error">
              !
            </span>
            <span className="truncate flex-1 min-w-0 font-mono text-secondary-foreground group-hover:text-foreground group-focus-within:text-foreground">
              {f.path}
            </span>
            {f.markerCount > 0 ? (
              <span className="shrink-0 font-mono text-2xs tabular-nums text-warning">
                {f.markerCount} marker{f.markerCount === 1 ? "" : "s"}
              </span>
            ) : (
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">no markers</span>
            )}
            <HintGroup>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void resolve(f.path, "ours")}
                  title="Keep your version"
                >
                  Ours
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void resolve(f.path, "theirs")}
                  title="Take their version"
                >
                  Theirs
                </Button>
                <HintItem label="Open in editor">
                  <IconButton
                    size="xs"
                    icon={FileCode2}
                    label="Open in editor"
                    onClick={() => onOpenFile(f.path)}
                  />
                </HintItem>
                <HintItem label={resolvedLabel}>
                  <IconButton
                    size="xs"
                    icon={Check}
                    label={resolvedLabel}
                    onClick={() => void resolve(f.path, "manual")}
                  />
                </HintItem>
              </div>
            </HintGroup>
          </div>
        );
      })}
    </div>
  );
}
