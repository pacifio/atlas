import { Download, ExternalLink, GitFork, Star } from "lucide-react";
import { HintGroup, HintItem, Icon } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { GithubRepo } from "../../types";
import { RowAction } from "./row-action";

/** A search hit's clone button: null when there is no project to clone into. */
export type CloneState = "idle" | "cloning" | "cloned" | null;

/** Language, stars and forks — the meta line both kinds of row end with. */
export function RepoStats({
  language,
  stars,
  forks,
}: {
  language: string;
  stars: number;
  forks: number;
}) {
  return (
    <>
      {language ? <span className="text-3xs text-muted-foreground">{language}</span> : null}
      <span className="flex items-center gap-0.5 text-3xs text-muted-foreground tabular-nums">
        <Icon icon={Star} size="xs" /> {stars.toLocaleString()}
      </span>
      <span className="flex items-center gap-0.5 text-3xs text-muted-foreground tabular-nums">
        <Icon icon={GitFork} size="xs" /> {forks.toLocaleString()}
      </span>
    </>
  );
}

/** The shared frame of a repo row: a hairline-ruled band with a hover wash. */
export const REPO_ROW =
  "group flex items-start justify-between gap-2 border-b border-border-subtle px-3 py-2.5 transition-colors duration-fast hover:bg-element-hover";

export function SearchResultRowView({
  repo,
  cloneState,
  cloneDir,
  onOpen,
  onClone,
}: {
  repo: GithubRepo;
  cloneState: CloneState;
  /** Where clones land, for the clone button's label (`.atlas/repos/`). */
  cloneDir: string;
  onOpen: () => void;
  onClone: () => void;
}) {
  const cloneLabel =
    cloneState === "cloned"
      ? "Cloned"
      : cloneState === "cloning"
        ? "Cloning..."
        : `Clone to ${cloneDir}`;
  return (
    <div className={REPO_ROW}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{repo.full_name}</div>
        {repo.description ? (
          <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
            {repo.description}
          </p>
        ) : null}
        <div className="mt-1.5 flex items-center gap-3">
          <RepoStats language={repo.language} stars={repo.stars} forks={repo.forks} />
        </div>
      </div>

      <HintGroup>
        <div className="flex shrink-0 items-center gap-0.5">
          <HintItem label="Open on GitHub">
            <RowAction icon={ExternalLink} label="Open on GitHub" onClick={onOpen} />
          </HintItem>
          {cloneState !== null ? (
            <HintItem label={cloneLabel}>
              <RowAction
                icon={Download}
                label={cloneLabel}
                busy={cloneState === "cloning"}
                disabled={cloneState !== "idle"}
                className={cn(cloneState === "cloned" && "text-success data-disabled:opacity-100")}
                onClick={onClone}
              />
            </HintItem>
          ) : null}
        </div>
      </HintGroup>
    </div>
  );
}
