import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { Button, Checkbox, Icon, Input, Textarea, type StepListStep } from "@tryatlas/design";

import { openAskAgent } from "@/features/ask-agent/lib/ask-agent";

import { gitBranchCompare } from "@/features/session-context/lib/session-git-api";
import { featureBranchName } from "@/features/session-context/lib/git-quick-action";
import { openPullRequestTab } from "@/features/pull-requests/lib/open-pull-request-tab";

import { useGitStore } from "../../stores/git-store";
import { useShipStore } from "../../stores/ship-store";
import { handleGitError } from "../../lib/git-errors";
import { blockedByOperation, inProgressLabel } from "../../lib/in-progress";
import { openPullRequest } from "../../lib/git-pr-api";
import { shipErrorContext, stagedFilesContext, WRITE_COMMIT_PROMPT } from "../../lib/ask-git";
import {
  RETRY_LABEL,
  STEP_LABEL,
  needsNewBranch,
  resumeStep,
  shipBlockedReason,
  type ShipContext,
  type ShipState,
  type ShipStep,
} from "../../lib/ship-flow";
import { dismissShip, retryShip, startShip } from "../../lib/ship-run";
import { ShipButtonView, type ShipChoice, type ShipChoiceItem } from "../views/ship-button-view";
import { ShipProgressView } from "../views/ship-progress-view";

/** Expand/collapse toggle for an optional commit-form field. A collapsed field
 *  that still holds text shows a dot, so its content can't be committed
 *  invisibly by surprise. */
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
    <Button
      variant="ghost"
      size="xs"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
    >
      {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      {label}
      {!open && hasContent && <span className="inline-block size-1 rounded-full bg-primary" />}
    </Button>
  );
}

function splitAuthors(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * The commit box: the message, its optional body and co-authors, amend, the
 * last commit with Undo, and the action — Commit, Commit & push, or
 * "Commit, push & PR" (`ship-flow.ts`), whose steps show in place above the
 * box while they run, and stay there on a failure with a retry from the step
 * that failed.
 */
export function CommitComposer({ stagedCount }: { stagedCount: number }) {
  const client = useQueryClient();
  const repoPath = useGitStore.use.repoPath();
  const branch = useGitStore.use.branch();
  const branchesFull = useGitStore.use.branchesFull();
  const ahead = useGitStore.use.ahead();
  const log = useGitStore.use.log();
  const actions = useGitStore.use.actions();
  const run = useShipStore((s) => (repoPath ? (s.runs[repoPath] ?? null) : null));

  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [showDesc, setShowDesc] = useState(false);
  const [showCoAuthors, setShowCoAuthors] = useState(false);
  const [coAuthors, setCoAuthors] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBase, setPrBase] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);

  useEffect(() => {
    if (repoPath) void actions.loadLog(repoPath).catch(() => {});
  }, [repoPath, actions]);

  // Where the branch stands: the default branch, whether there is a remote.
  // Keyed on what moves it, so a checkout or a push reads it again.
  const current = branchesFull.find((b) => b.isCurrent);
  const compare = useQuery({
    queryKey: ["git-branch-compare", repoPath, branch, current?.upstream ?? null, ahead],
    queryFn: () => gitBranchCompare(repoPath!),
    enabled: !!repoPath,
    staleTime: 30_000,
  });
  const detached = useGitStore.use.detached();
  const opInProgress = inProgressLabel(useGitStore.use.inProgress());

  // Busy while OUR streaming commit runs — a slow pre-commit hook used to
  // look like a hung app. A boolean, not the op: the op changes on every
  // output batch the hook prints.
  const committing = useGitStore((s) => s.activeOp?.kind === "commit" && s.activeOp.running);
  const shipping = run?.phase === "running";
  const busy = committing || shipping;

  // Amending never requires a new summary (empty = keep the original
  // message, like `git commit --amend --no-edit`).
  const canCommit = (stagedCount > 0 || amend) && (summary.trim().length > 0 || amend);

  const ctx: ShipContext = {
    canCommit,
    amend,
    branch: detached ? null : branch || null,
    hasRemote: compare.data?.hasRemote ?? !!current?.upstream,
    isDefault: compare.data?.isDefault ?? false,
    busy,
  };
  const commitBlocked = busy
    ? "A git action is in progress."
    : canCommit
      ? null
      : stagedCount === 0 && !amend
        ? "Stage changes to commit."
        : "Write a summary to commit.";
  // Why the push variants are off for a reason Commit isn't: the one to
  // say out loud, since it is about the repository rather than the form.
  const shipOnlyBlocked = commitBlocked ? null : shipBlockedReason(ctx);
  const blocked = commitBlocked ?? shipOnlyBlocked;
  // A pull request also has to know whether this is the default branch; until
  // that answer is in, it would open one from `main` without asking.
  const prBlocked =
    blocked ??
    (compare.data
      ? null
      : compare.isError
        ? "Could not tell whether this is the default branch."
        : "Reading the branch…");

  const branchNeeded = needsNewBranch(ctx, "commit_push_pr");
  const suggestedBranch = useMemo(
    () =>
      featureBranchName(
        summary,
        // `origin/atlas/x` takes `atlas/x` too: the push would land on it.
        branchesFull.map((b) => (b.isRemote ? b.name.slice(b.name.indexOf("/") + 1) : b.name)),
      ),
    [summary, branchesFull],
  );

  const resetForm = () => {
    setSummary("");
    setDescription("");
    setAmend(false);
    setShowDesc(false);
    setCoAuthors("");
    setShowCoAuthors(false);
    setPrTitle("");
    setPrBase(null);
    setNewBranch(null);
  };

  const commit = async () => {
    if (commitBlocked) return;
    try {
      const authors = splitAuthors(coAuthors);
      await actions.commit(
        summary.trim(),
        description.trim() || undefined,
        amend,
        authors.length > 0 ? authors : undefined,
      );
      resetForm();
    } catch (e) {
      handleGitError(e);
    }
  };

  const branchName = (newBranch ?? suggestedBranch).trim();

  /** Start a run from the form; false when the form or repository rules it out. */
  const ship = (variant: "commit_push" | "commit_push_pr"): boolean => {
    if (!repoPath || !branch || (variant === "commit_push_pr" ? prBlocked : blocked)) return false;
    const pr = variant === "commit_push_pr";
    // Never on to the default branch without its new branch named.
    if (pr && branchNeeded && !branchName) {
      setDraftOpen(true);
      return true;
    }
    startShip(client, repoPath, {
      variant,
      summary: summary.trim(),
      description: description.trim() || null,
      coAuthors: splitAuthors(coAuthors),
      startBranch: branch,
      newBranch: pr && branchNeeded ? branchName : null,
      pr: { title: prTitle, base: prBase ?? compare.data?.defaultBranch ?? null },
    });
    return true;
  };

  // A run stopped before its commit retries from the form as it is now, so a
  // message a hook rejected, then edited, is the one committed. Once the
  // commit is in, the retry resumes the run and never commits again.
  const retry = () => {
    if (!repoPath || !run) return;
    if (run.status.commit !== "done" && ship(run.request.variant)) return;
    retryShip(client, repoPath);
  };

  // The box empties once the run has committed, not when it starts: a run
  // stopped before its commit (no `gh`, a branch name taken) keeps the
  // message for the next try. Once per run: a run that had already committed
  // when the box mounted (back from History) counts as cleared, so what was
  // typed since is kept.
  const committedRun = run && run.status.commit === "done" ? run.request : null;
  const [clearedFor, setClearedFor] = useState<object | null>(() => committedRun);
  if (committedRun && committedRun !== clearedFor) {
    setClearedFor(committedRun);
    resetForm();
  }

  const onRun = (choice: ShipChoice) => {
    if (choice === "commit") void commit();
    // A pull request from the default branch names its new branch first.
    else if (choice === "commit_push_pr" && branchNeeded && !draftOpen && newBranch === null) {
      setDraftOpen(true);
    } else ship(choice);
  };

  const items: ShipChoiceItem[] = [
    {
      choice: "commit",
      label: amend ? "Amend" : "Commit",
      disabledReason: commitBlocked,
      shortcut: "⌘↵",
    },
    { choice: "commit_push", label: "Commit & push", disabledReason: blocked },
    { choice: "commit_push_pr", label: "Commit, push & PR", disabledReason: prBlocked },
  ];
  // The pull request is the primary action unless the repository rules it
  // out (no remote, detached, an amend), where plain Commit is. An unready
  // form (nothing staged, no summary) keeps the pull request in place,
  // disabled, so the button doesn't change shape under the pointer as the
  // summary is typed.
  const primary = shipOnlyBlocked === null ? items[2] : items[0];

  const last = log[0];

  return (
    <>
      {run && repoPath && (
        <ShipProgress
          run={run}
          onRetry={retry}
          onDismiss={() => dismissShip(repoPath)}
          repoPath={repoPath}
        />
      )}
      <div className="shrink-0 space-y-1.5 border-t border-border-subtle p-2">
        <Input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          aria-label="Commit summary"
          placeholder={amend ? "Amend message (empty = keep original)" : "Summary"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
          }}
        />
        {showDesc && (
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Commit description"
            placeholder="Description — also the pull request's body"
            rows={3}
            className="resize-none"
          />
        )}
        {showCoAuthors && (
          <Input
            value={coAuthors}
            onChange={(e) => setCoAuthors(e.target.value)}
            aria-label="Co-authors"
            placeholder="Co-authors: Name <email>, Name <email>"
            className="font-mono"
            title="Added as Co-authored-by trailers"
          />
        )}
        <div className="flex flex-wrap items-center gap-1">
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
          <label className="ml-1 flex cursor-pointer items-center gap-1.5 caption select-none">
            <Checkbox checked={amend} onCheckedChange={setAmend} />
            Amend
          </label>
          {/* The agent answers in its session; the box here stays the
              user's, so nothing is committed that they did not put in it. */}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={stagedCount === 0}
            title={
              stagedCount === 0
                ? "Stage changes for the agent to describe"
                : "Ask the agent for a message from the staged diff"
            }
            onClick={(e) =>
              openAskAgent({
                context: [
                  stagedFilesContext(
                    useGitStore
                      .getState()
                      .files.filter((f) => f.staged)
                      .map((f) => f.path),
                  ),
                ],
                prompt: WRITE_COMMIT_PROMPT,
                anchor: e.currentTarget,
              })
            }
          >
            <Icon icon={Sparkles} size="xs" />
            Write with agent
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {last ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 caption">
              <span className="shrink-0">Last:</span>
              <span className="truncate" title={last.message}>
                {last.message}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy || opInProgress !== null}
                title={
                  opInProgress
                    ? blockedByOperation(opInProgress)
                    : "Undo this commit — its changes return to Staged (blocked once pushed)"
                }
                onClick={() => void actions.undoCommit().catch(handleGitError)}
              >
                Undo
              </Button>
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <ShipButtonView
            primary={primary}
            items={items}
            busy={busy}
            busyLabel={committing ? "Committing…" : "Shipping…"}
            onRun={onRun}
            draftOpen={draftOpen}
            onDraftOpenChange={(open) => {
              setDraftOpen(open);
              if (open && branchNeeded && newBranch === null) setNewBranch(suggestedBranch);
            }}
            draft={{
              title: prTitle,
              titlePlaceholder: summary.trim(),
              base: prBase ?? compare.data?.defaultBranch ?? "",
              newBranch: branchNeeded ? (newBranch ?? suggestedBranch) : null,
              currentBranch: branch || null,
            }}
            onDraftChange={(patch) => {
              if (patch.title !== undefined) setPrTitle(patch.title);
              if (patch.base !== undefined) setPrBase(patch.base);
              if (patch.newBranch !== undefined) setNewBranch(patch.newBranch);
            }}
            prDisabledReason={
              prBlocked ?? (branchNeeded && !branchName ? "Name the new branch." : null)
            }
          />
        </div>
        {/* Why only Commit is offered, in words: a disabled control's
            tooltip never reaches a keyboard. */}
        {shipOnlyBlocked && <p className="caption">Commit only. {shipOnlyBlocked}</p>}
      </div>
    </>
  );
}

/** The run's state, as the progress view's rows. */
function ShipProgress({
  run,
  repoPath,
  onRetry,
  onDismiss,
}: {
  run: ShipState;
  repoPath: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { request } = run;
  const detail: Record<ShipStep, string | null> = {
    check: null,
    branch: request.newBranch,
    commit: request.summary,
    push: run.branch,
    pr: run.pr ? `#${run.pr.number}` : request.pr.base ? `into ${request.pr.base}` : null,
  };
  const rows: StepListStep[] = run.steps.map((step) => ({
    id: step,
    label: STEP_LABEL[step],
    detail: detail[step],
    status: run.status[step],
  }));
  const resume = run.phase === "failed" ? resumeStep(run) : null;
  const fix =
    run.phase === "failed" && run.error
      ? shipErrorContext({ ...run.error, step: STEP_LABEL[run.error.step] }, repoPath)
      : null;
  const title =
    run.phase === "done"
      ? request.variant === "commit_push_pr"
        ? "Shipped"
        : "Committed and pushed"
      : run.phase === "failed"
        ? "Stopped"
        : request.variant === "commit_push_pr"
          ? "Commit, push & PR"
          : "Commit & push";
  return (
    <ShipProgressView
      title={title}
      steps={rows}
      phase={run.phase}
      error={run.error?.message ?? null}
      retryLabel={resume ? RETRY_LABEL[resume] : null}
      fix={fix}
      pr={run.pr}
      onRetry={onRetry}
      onDismiss={onDismiss}
      onOpenPr={() => {
        if (run.pr) openPullRequestTab({ repoPath, number: run.pr.number });
      }}
      onOpenPrOnHost={() => {
        if (run.pr) openPullRequest(run.pr.url);
      }}
    />
  );
}
