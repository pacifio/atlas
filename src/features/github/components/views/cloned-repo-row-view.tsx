import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { HintGroup, HintItem, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { ClonedRepo } from "../../types";
import { BranchPickerView } from "./branch-picker-view";
import { RowAction } from "./row-action";
import { REPO_ROW, RepoStats } from "./search-result-row-view";

/** What a clone's row is waiting on, if anything. */
export type RowBusy = "switch" | "update" | "delete";

/** One cloned repo: name, description, counts, branch picker, fetch, open, delete. */
export function ClonedRepoRowView({
  repo,
  busy,
  loadBranches,
  onSwitch,
  onUpdate,
  onOpen,
  onDelete,
}: {
  repo: ClonedRepo;
  busy: RowBusy | null;
  loadBranches: () => Promise<string[]>;
  onSwitch: (branch: string) => void;
  onUpdate: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // Delete is armed by the first click and fired by the second; leaving the
  // button disarms it, and so does a failed delete handing the row back.
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (busy === null) setConfirmDelete(false);
  }, [busy]);
  const meta = repo.meta;

  const remove = () => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete();
  };

  const fetchLabel = repo.branch ? `Fetch origin/${repo.branch}` : "Pick a branch to fetch";
  const deleteLabel = confirmDelete ? "Click again to delete the clone" : "Delete clone";

  return (
    <div data-testid="cloned-repo" className={REPO_ROW}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{repo.display_name}</div>
        {meta?.description ? (
          <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
            {meta.description}
          </p>
        ) : null}
        <div className="mt-1 flex items-center gap-3">
          {busy === "switch" ? (
            <span className="flex h-control-xs items-center gap-1 text-2xs text-muted-foreground">
              <Spinner size="xs" label="" /> Switching…
            </span>
          ) : (
            <BranchPickerView
              branch={repo.branch}
              disabled={busy !== null}
              loadBranches={loadBranches}
              onSwitch={onSwitch}
            />
          )}
          {meta ? (
            <RepoStats language={meta.language} stars={meta.stars} forks={meta.forks} />
          ) : null}
        </div>
      </div>

      <HintGroup>
        <div className="flex shrink-0 items-center gap-0.5">
          <HintItem label={fetchLabel}>
            <RowAction
              icon={RefreshCw}
              label={fetchLabel}
              busy={busy === "update"}
              disabled={busy !== null || !repo.branch}
              onClick={() => {
                if (!busy) onUpdate();
              }}
            />
          </HintItem>
          <HintItem label="Open on GitHub">
            <RowAction icon={ExternalLink} label="Open on GitHub" onClick={onOpen} />
          </HintItem>
          <HintItem label={deleteLabel}>
            <RowAction
              icon={Trash2}
              label={deleteLabel}
              variant="ghost-destructive"
              busy={busy === "delete"}
              disabled={busy !== null}
              className={cn(confirmDelete && "bg-error-muted text-error")}
              onClick={remove}
              onBlur={() => setConfirmDelete(false)}
            />
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
}
