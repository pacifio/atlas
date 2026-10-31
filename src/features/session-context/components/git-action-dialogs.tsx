// The two questions a Commit-row action can stop on, mounted once at the app
// root (`session-details-dialogs.tsx`) and open while the store holds one:
//
//  - Default branch: the action would push to the default branch, or open a
//    pull request from it. Push there anyway, move the work onto a new
//    branch first, or stop.
//  - Commit: the message, and which of the changed files go in. "Commit on
//    new branch" moves the work onto a new branch named from the message.
//    Atlas does not write commit messages with a model, so the message is
//    the user's.

import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch, TriangleAlert } from "lucide-react";

import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

import {
  defaultBranchCopy,
  featureBranchUnavailableReason,
  type GitAction,
} from "../lib/git-quick-action";
import { continueGitAction, runGitAction } from "../lib/run-git-action";
import { useSessionGit } from "../lib/use-session-git";
import { useSessionDetailsStore, type GitActionPrompt } from "../stores/session-details-store";

export function GitActionDialogHost() {
  const prompt = useSessionDetailsStore.use.gitPrompt();
  if (!prompt) return null;
  const key = `${prompt.kind}:${prompt.path}:${prompt.action}`;
  return prompt.kind === "commit" ? (
    <CommitDialog key={key} prompt={prompt} />
  ) : (
    <DefaultBranchDialog key={key} prompt={prompt} />
  );
}

const close = () => useSessionDetailsStore.getState().actions.promptGitAction(null);

function DefaultBranchDialog({ prompt }: { prompt: GitActionPrompt }) {
  const client = useQueryClient();
  const git = useSessionGit(prompt.path).data;
  const branch = git?.snapshot.branch ?? "the default branch";
  const copy = defaultBranchCopy(prompt.action, branch);
  const unavailable = featureBranchUnavailableReason((git?.snapshot.files.length ?? 0) > 0);
  const go = (featureBranch: boolean) => {
    close();
    continueGitAction(client, { ...prompt, featureBranch });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {copy.continueLabel && (
            <Button variant="outline" onClick={() => go(false)}>
              {copy.continueLabel}
            </Button>
          )}
          <Button
            autoFocus
            disabled={unavailable !== null}
            title={unavailable ?? undefined}
            onClick={() => go(true)}
          >
            New branch & continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SUBMIT_LABEL: Record<GitAction, string> = {
  commit: "Commit",
  commit_push: "Commit & push",
  commit_push_pr: "Commit, push & PR",
  push: "Push",
  create_pr: "Create PR",
};

/** `M`, `A`, `D` … for a changed file's status word. */
const STATUS_LETTER: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  modified: "M",
  untracked: "U",
  conflicted: "!",
};

function CommitDialog({ prompt }: { prompt: GitActionPrompt }) {
  const id = useId();
  const client = useQueryClient();
  const git = useSessionGit(prompt.path).data;
  // A file changed in the index and the tree is two snapshot rows; one here.
  const files = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of git?.snapshot.files ?? []) if (!seen.has(f.path)) seen.set(f.path, f.status);
    return [...seen].map(([path, status]) => ({ path, status }));
  }, [git?.snapshot.files]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const chosen = files.filter((f) => !excluded.has(f.path));
  const [summary, ...rest] = message.split("\n");
  const ready = !!summary?.trim() && chosen.length > 0;
  const onDefault = !!git?.compare?.isDefault && !prompt.featureBranch;

  const submit = (featureBranch: boolean) => {
    if (!ready) return;
    close();
    void runGitAction(client, {
      path: prompt.path,
      action: prompt.action,
      sessionId: prompt.sessionId,
      featureBranch: prompt.featureBranch || featureBranch,
      summary: summary!.trim(),
      description: rest.join("\n").trim() || null,
      files: excluded.size > 0 ? chosen.map((f) => f.path) : undefined,
    });
  };
  const toggle = (path: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-lg">
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{SUBMIT_LABEL[prompt.action]}</DialogTitle>
            <DialogDescription>
              <span className="flex min-w-0 items-center gap-1.5">
                <GitBranch size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate font-mono">
                  {prompt.featureBranch ? "a new branch" : (git?.snapshot.branch ?? "")}
                </span>
                {onDefault && (
                  <span className="flex shrink-0 items-center gap-1 text-warning">
                    <TriangleAlert size={12} aria-hidden />
                    Default branch
                  </span>
                )}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-secondary-foreground">
              <span>Files</span>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {chosen.length} of {files.length}
              </span>
            </div>
            <ul className="m-0 max-h-48 list-none overflow-y-auto overscroll-contain rounded border border-border p-1">
              {files.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-muted-foreground">No changes</li>
              )}
              {files.map((f) => (
                <li key={f.path}>
                  <label className="flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-xs text-secondary-foreground hover:bg-element-hover">
                    <input
                      type="checkbox"
                      checked={!excluded.has(f.path)}
                      onChange={() => toggle(f.path)}
                      className="size-3.5 cursor-pointer accent-primary"
                    />
                    <span className="w-3 shrink-0 font-mono text-2xs text-muted-foreground">
                      {STATUS_LETTER[f.status] ?? "M"}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={f.path}>
                      {f.path}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <label
            className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
            htmlFor={`${id}-message`}
          >
            Message
            <textarea
              id={`${id}-message`}
              autoFocus
              rows={4}
              value={message}
              placeholder="Summary on the first line, details below"
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit(false);
                }
              }}
              className="w-full resize-y rounded border border-border bg-panel-input p-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
            />
          </label>

          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            {!prompt.featureBranch && (
              <Button variant="outline" disabled={!ready} onClick={() => submit(true)}>
                Commit on new branch
              </Button>
            )}
            <Button type="submit" disabled={!ready}>
              {SUBMIT_LABEL[prompt.action]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
