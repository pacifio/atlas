// The Commit row: the one git action worth a click, as a split.
//
// The main button is whatever the checkout calls for (`resolveQuickAction`):
// "Commit, push & PR", "Push", "Pull", "Create PR" … or a disabled "Commit"
// whose tooltip says why there is nothing to do. The ⌄ lists Commit, Push and
// Create PR, each disabled with its reason; opening it reads the checkout
// again.
//
// While an action runs the row shows its phase, the last line of output (a
// hook's, a push's) and, in place of the ⌄, how long it has run. When it
// lands, a check and what happened replace the row for a few seconds. In the
// compact card the row shows only then.

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CloudDownload,
  CloudUpload,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Info,
  Loader2,
  type LucideIcon,
} from "lucide-react";

import { DropdownMenuItem } from "@/ui/dropdown-menu";

import {
  buildMenuItems,
  resolveQuickAction,
  type GitActionInput,
  type QuickActionIcon,
} from "../lib/git-quick-action";
import { continueGitAction, requestGitAction, runPull } from "../lib/run-git-action";
import { refreshSessionGit, type SessionGit } from "../lib/use-session-git";
import { useGitActionStore } from "../stores/git-action-store";
import { DetailsRow, DetailsSplit, RowIcon, RowLabel, RowMeta } from "./details-rows";

const ICON: Record<QuickActionIcon, LucideIcon> = {
  commit: GitCommitHorizontal,
  push: CloudUpload,
  pull: CloudDownload,
  pr: GitPullRequestArrow,
  info: Info,
};

const MENU_ICON = {
  commit: GitCommitHorizontal,
  push: CloudUpload,
  create_pr: GitPullRequestArrow,
};

/** How long the confirmation stays. */
const SUCCESS_MS = 10_000;

/** The Commit row's input, from the checkout's git state. */
export function gitActionInput(git: SessionGit, hasOpenPr: boolean, busy: boolean): GitActionInput {
  const { snapshot, compare } = git;
  return {
    busy,
    branch: snapshot.detached || !snapshot.branch ? null : snapshot.branch,
    dirty: snapshot.files.length > 0,
    hasUpstream: !!snapshot.upstream,
    hasRemote: compare?.hasRemote ?? !!snapshot.upstream,
    isDefault: compare?.isDefault ?? false,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    aheadOfDefault: compare?.aheadOfDefault ?? null,
    hasOpenPr,
  };
}

export function CommitRow({
  path,
  git,
  hasOpenPr,
  sessionId,
  compact,
}: {
  path: string;
  git: SessionGit;
  hasOpenPr: boolean;
  sessionId: string | null;
  /** The card is short of height: show the row only while it has news. */
  compact: boolean;
}) {
  const client = useQueryClient();
  const run = useGitActionStore((s) => s.runs[path] ?? null);
  const success = useGitActionStore((s) => s.success[path] ?? null);
  const { clearSuccess } = useGitActionStore.use.actions();

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => clearSuccess(path), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [success, path, clearSuccess]);

  if (run) {
    return (
      <DetailsSplit
        onClick={() => {}}
        disabled
        multiline={!!run.line}
        menuLabel="Git actions"
        menu={null}
        trailing={<Elapsed since={run.startedAt} />}
      >
        <RowIcon icon={Loader2} className="animate-spin" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{run.label}</span>
          {run.line && (
            <span
              title={run.line}
              className="truncate font-mono text-2xs font-normal text-muted-foreground"
            >
              {run.line}
            </span>
          )}
        </span>
      </DetailsSplit>
    );
  }
  if (success) {
    return (
      <DetailsRow multiline={!!success.description}>
        <RowIcon icon={Check} className="text-success" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{success.title}</span>
          {success.description && (
            <span className="truncate text-2xs font-normal text-muted-foreground">
              {success.description}
            </span>
          )}
        </span>
      </DetailsRow>
    );
  }
  if (compact) return null;

  const input = gitActionInput(git, hasOpenPr, false);
  const quick = resolveQuickAction(input);
  const items = buildMenuItems(input);
  const start = (action: Parameters<typeof requestGitAction>[1]["action"]) =>
    requestGitAction(client, { path, action, sessionId, isDefault: input.isDefault });

  return (
    <DetailsSplit
      onClick={() => {
        if (quick.kind === "pull") void runPull(client, path);
        else if (quick.kind === "run") start(quick.action);
      }}
      disabled={quick.kind === "hint"}
      title={quick.kind === "hint" ? quick.hint : undefined}
      menuLabel="Git actions"
      onMenuOpen={() => void refreshSessionGit(client, path)}
      menu={items.map((item) => {
        const Icon = MENU_ICON[item.action];
        return (
          <DropdownMenuItem
            key={item.action}
            disabled={item.disabledReason !== null}
            title={item.disabledReason ?? undefined}
            onClick={() =>
              item.action === "commit"
                ? continueGitAction(client, {
                    path,
                    action: "commit",
                    sessionId,
                    featureBranch: false,
                  })
                : start(item.action)
            }
          >
            <Icon />
            {item.label}
          </DropdownMenuItem>
        );
      })}
    >
      <RowIcon icon={ICON[quick.icon]} />
      <RowLabel>{quick.label}</RowLabel>
      {quick.kind === "pull" && <RowMeta>{input.behind} ↓</RowMeta>}
      {quick.kind === "run" && quick.action === "push" && input.hasUpstream && (
        <RowMeta>{input.ahead} ↑</RowMeta>
      )}
    </DetailsSplit>
  );
}

/** `12s`, `1m 3s`: how long the action has run, ticking each second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="flex h-8 w-12 shrink-0 items-center justify-center text-2xs text-muted-foreground tabular-nums">
      {formatElapsed(now - since)}
    </span>
  );
}
