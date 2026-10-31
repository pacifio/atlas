// The agent actions a pull request offers, each handing work to a session on
// the user's default agent (named on every action):
//
// - "Ask a question" and "Explain this PR" — the session beside the tab when
//   it is in the same project, else a new session there, with the pull
//   request in its composer (and for Explain, the task, description and
//   changed files). Nothing is checked out: the task says to read the diff
//   with `gh pr diff`.
// - "Fix" on a failing check, a review thread or a remark, and "Fix findings"
//   for all of them — a new session on the pull request's head branch: where
//   that branch is already checked out, or in a worktree of its own
//   (`pr_prepare_checkout`). The main checkout is never switched. The task is
//   in the composer, not sent; once the session has done the work, the user
//   pushes it from the session context overlay. Nothing is pushed for them.
//   When the session beside the tab already works on the pull request's
//   branch, the task goes into its composer instead ("in this session").
// - "Resolve conflicts" — as Fix, with the task of bringing the branch up to
//   date with its base.
// - "Check out" — the head in its own worktree with a fresh session there,
//   or the project's checkout switched to it (refused while the tree has
//   changes or an agent works in it, as "New session on branch" is).
// - "Write guide" — the Guide tab's background run (`guide-run-store.ts`) on
//   the guide's own agent (`guideAgentFor`); on a pull request from a fork,
//   only after the reader confirms, since the run's agent works in a checkout
//   of the fork author's code. Off entirely while `pullRequestGuideEnabled`
//   is off for the project.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { agentMeta } from "@/features/agents/lib/agent-meta";
import { checkoutState } from "@/features/git/lib/git-remote-api";
import { useGitStore } from "@/features/git/stores/git-store";
import { busySessions } from "@/features/projects/lib/stop-agents-confirm";
import { agentWorkingElsewhere } from "@/features/sidebar/lib/sidebar-actions";
import { useProjectSetting } from "@/features/settings/lib/use-scoped-setting";

import {
  actionAgent,
  currentSessionTab,
  openHandoffSession,
  sessionCwd,
  useCurrentSessionTab,
} from "./pr-agent-session";
import { classifyPrError, prErrorMessage } from "./pr-errors";
import { fetchCheckLogForHandoff } from "./pull-request-check-log";
import { findingKey, type Finding } from "./pull-request-logic";
import {
  buildAskAboutGuideStopHandoff,
  buildAskAboutLinesHandoff,
  buildAskAboutPullRequestHandoff,
  buildExplainHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  buildResolveConflictsHandoff,
  hasFindings,
  type Handoff,
  type PickedLines,
} from "./pull-request-handoff";
import { guideQueryKey, usePrGuide } from "./pull-request-guide-queries";
import type { GuideStop, PullRequestGuide } from "./pull-request-guide-types";
import { pullRequestKeys } from "./pull-requests-queries";
import { prDiff, prPrepareCheckout } from "./pull-requests-api";
import type { PrActivity, PrDetail, PrDiffFile, PrDiffResult } from "./pull-requests-types";
import {
  guideAgentFor,
  guideRunKey,
  useGuideRunStore,
  writeGuide,
  type GuideRun,
} from "../stores/guide-run-store";

export interface PullRequestGuideState {
  /** `pullRequestGuideEnabled` for the project: off hides the Guide. */
  enabled: boolean;
  /** The agent that writes the guide (`pullRequestGuideAgent`). */
  agentLabel: string;
  guide: PullRequestGuide | null;
  loading: boolean;
  run: GuideRun | null;
  running: boolean;
  /** The guide was written for an older head. */
  stale: boolean;
  /** Whether a guide can be written here (an open or closed pull request
   *  with a known head). */
  canWrite: boolean;
  /** Starts a run, or for a pull request from a fork asks first
   *  (`forkConfirm`). */
  write: () => void;
  /** Set while "Write guide" on a fork's pull request waits for the reader's
   *  yes: its checkout is the fork author's code. */
  forkConfirm: { confirm: () => void; cancel: () => void } | null;
}

export type CheckoutMode = "worktree" | "local";

export interface PullRequestAgentActions {
  /** The agent every action uses: the project's default. */
  agentLabel: string;
  /** "Ask a question": the pull request into a session's composer. */
  ask: () => void;
  /** Ask and Explain write into the session beside the tab, not a new one. */
  attachesToComposer: boolean;
  /** The session beside the tab works on the pull request's branch, so the
   *  Fix actions hand their task to it. */
  fixesInSession: boolean;
  /** "Fix findings"'s label, which says where the work goes. */
  fixFindingsLabel: string;
  /** "Resolve conflicts": `null` unless the pull request conflicts. */
  resolveConflicts: (() => void) | null;
  /** "Check out": its own worktree and session, or the project's checkout. */
  checkout: (mode: CheckoutMode) => void;
  /** `null` while agent actions are unavailable; the Summary hides "Fix". */
  fixFinding: ((finding: Finding) => void) | null;
  /** "Fix findings": `null` when there is nothing to fix. */
  fixFindings: (() => void) | null;
  /** `auto`: the session beside the tab when it is in the project. */
  explain: (where?: "new" | "current" | "auto") => void;
  /** A question about one guide stop, in a session (the current one when it
   *  is in the project, as "Explain"). */
  askAboutStop: (stop: GuideStop, index: number, question: string) => void;
  /** "Ask about these lines": a question about lines picked in the diff, in
   *  a session as `askAboutStop`. */
  askAboutLines: (lines: PickedLines, question: string) => void;
  /** The session beside the tab can take "Explain" instead of a new one. */
  canExplainInCurrent: () => boolean;
  /** The action being handed off: a `findingKey`, "findings", "explain",
   *  "ask", "conflicts" or "checkout:<mode>". */
  pending: string | null;
  /** The Fix button's label. */
  fixLabel: string;
  guide: PullRequestGuideState;
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function usePullRequestAgentActions(target: {
  repoPath: string;
  number: number;
  detail: PrDetail | null;
  activity: PrActivity | null;
}): PullRequestAgentActions {
  const { repoPath, number, detail, activity } = target;
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  // "Write guide" on a pull request from a fork waits for a yes first.
  const [confirmingFork, setConfirmingFork] = useState(false);
  const agent = actionAgent(repoPath);
  // The session beside the tab, and the branch its checkout is on: when that
  // is the pull request's, the Fix actions work there instead of preparing
  // another checkout.
  const sessionTab = useCurrentSessionTab(repoPath);
  const sessionDir = sessionTab ? sessionCwd(sessionTab, repoPath) : null;
  const sessionBranch = useQuery({
    queryKey: ["pull-request-session-branch", sessionDir],
    queryFn: async () => (await checkoutState(sessionDir!))?.branch ?? null,
    enabled: sessionDir !== null && detail?.state === "open",
    staleTime: 10_000,
  }).data;
  const prBranch = detail
    ? detail.isCrossRepository
      ? `atlas/pr-${detail.number}/${detail.headBranch}`
      : detail.headBranch
    : null;
  const fixesInSession =
    sessionTab !== null && prBranch !== null && sessionBranch != null && sessionBranch === prBranch;

  const guideEnabled = useProjectSetting(repoPath, "pullRequestGuideEnabled");
  // Read each render: it follows the setting and the installed agents.
  const guideAgent = guideAgentFor(repoPath);
  const guideAgentLabel = agentMeta(guideAgent).label;
  const guideRepository = guideEnabled ? (detail?.repository ?? null) : null;
  const guideQuery = usePrGuide(repoPath, guideRepository, number);
  const run = useGuideRunStore((s) => s.runs[guideRunKey(repoPath, number)] ?? null);
  const guide = guideQuery.data ?? null;

  /** The first page of changed files, for the task's context. Best-effort. */
  const changedFiles = async (): Promise<PrDiffFile[]> => {
    try {
      const page = await client.fetchQuery<PrDiffResult>({
        queryKey: pullRequestKeys.diff(repoPath, number, null, null),
        queryFn: () => prDiff(repoPath, number, null, null),
        staleTime: 60_000,
      });
      return page.files;
    } catch {
      return [];
    }
  };

  const fixWith = async (
    kind: string,
    build: (files: PrDiffFile[]) => Handoff | Promise<Handoff>,
  ) => {
    if (!detail || pending !== null) return;
    setPending(kind);
    if (fixesInSession && sessionTab && sessionDir) {
      try {
        await openHandoffSession({
          projectPath: repoPath,
          cwd: sessionDir,
          agent: agent.agent,
          handoff: await build(await changedFiles()),
          into: sessionTab,
        });
        toast.success("Added to this session", {
          description: "It is on the pull request's branch. Read the task over, then send.",
        });
      } catch (err) {
        toast.error("Couldn't add it to this session", { description: errorMessage(err) });
      } finally {
        setPending(null);
      }
      return;
    }
    const toastId = toast.loading("Preparing the pull request checkout…");
    try {
      const [checkout, files] = await Promise.all([
        prPrepareCheckout(repoPath, detail),
        changedFiles(),
      ]);
      await openHandoffSession({
        projectPath: repoPath,
        cwd: checkout.cwd,
        agent: agent.agent,
        handoff: await build(files),
      });
      const where = checkout.worktreePath
        ? `${checkout.reused ? "Its existing worktree" : "A new worktree"} on ${checkout.branch}`
        : `The project, already on ${checkout.branch}`;
      toast.success(
        checkout.isOnPullRequestHead ? "Checkout ready" : "Checked out, not at the latest push",
        {
          id: toastId,
          description: checkout.isOnPullRequestHead
            ? `${where}. The task is in the composer for ${agent.label}: read it over, then send.`
            : `${where} holds commits of its own or could not move to the pull request's head. Check it before sending the task.`,
        },
      );
    } catch (err) {
      toast.error("Couldn't prepare the pull request checkout", {
        id: toastId,
        description: errorMessage(err),
      });
    } finally {
      setPending(null);
    }
  };

  const canFix = detail?.state === "open";
  const fixFinding = canFix
    ? (finding: Finding) => {
        // A failing check's log is read alongside the checkout, and rides in
        // the handoff marked untrusted; one that cannot be read is left out.
        const log =
          finding.kind === "check"
            ? fetchCheckLogForHandoff(client, repoPath, number, finding.check)
            : Promise.resolve(null);
        void fixWith(findingKey(finding), async (files) =>
          buildFixFindingHandoff(detail, finding, files, detail.changedFiles, await log),
        );
      }
    : null;

  const fixFindings =
    canFix && hasFindings(activity, detail.checks)
      ? () => {
          void fixWith("findings", () =>
            buildFixFindingsHandoff(detail, {
              reviewThreads: activity?.reviewThreads ?? [],
              comments: activity?.comments ?? [],
              checks: detail.checks,
              commentsTruncated: activity?.commentsTruncated ?? false,
            }),
          );
        }
      : null;

  const explain = (where: "new" | "current" | "auto" = "auto") => {
    if (!detail || pending !== null) return;
    setPending("explain");
    void (async () => {
      try {
        const files = await changedFiles();
        const into = where === "new" ? null : currentSessionTab(repoPath);
        await openHandoffSession({
          projectPath: repoPath,
          cwd: repoPath,
          agent: agent.agent,
          handoff: buildExplainHandoff(detail, files),
          into,
        });
        toast.success(into ? "Added to this session" : `Asked in a new ${agent.label} session`, {
          description: "The question is in the composer: read it over, then send.",
        });
      } catch (err) {
        toast.error("Couldn't open a session", { description: errorMessage(err) });
      } finally {
        setPending(null);
      }
    })();
  };

  const askQuestion = () => {
    if (!detail || pending !== null) return;
    setPending("ask");
    const into = currentSessionTab(repoPath);
    void openHandoffSession({
      projectPath: repoPath,
      cwd: repoPath,
      agent: agent.agent,
      handoff: buildAskAboutPullRequestHandoff(detail),
      into,
    })
      .then(() =>
        toast.success(into ? "Added to this session" : `Opened a ${agent.label} session`, {
          description: "The pull request is in the composer: type your question, then send.",
        }),
      )
      .catch((err: unknown) =>
        toast.error("Couldn't open a session", { description: errorMessage(err) }),
      )
      .finally(() => setPending(null));
  };

  const resolveConflicts =
    detail?.state === "open" && detail.mergeability === "conflicting"
      ? () => void fixWith("conflicts", () => buildResolveConflictsHandoff(detail))
      : null;

  const checkoutHere = async (pr: PrDetail) => {
    // As "New session on branch": never under uncommitted changes, never
    // under an agent working in the checkout. Rust reads the tree again
    // right before it switches, so a change made since cannot slip through.
    const target = prBranch ?? pr.headBranch;
    const state = await checkoutState(repoPath);
    if (state && state.branch !== target) {
      const leaveAlone = (blocker: string) =>
        toast.error(`Didn't switch to ${target}`, {
          description: `The project is on ${state.branch} and ${blocker}, so Atlas left it alone. Check it out in a separate worktree instead.`,
        });
      if (state.dirty) return leaveAlone("it has uncommitted changes");
      if (busySessions(repoPath).length > 0 || (await agentWorkingElsewhere(repoPath))) {
        return leaveAlone("an agent is working in it");
      }
    }
    const checkout = await prPrepareCheckout(repoPath, pr, true);
    void useGitStore.getState().actions.refreshStatusNow(repoPath);
    await openHandoffSession({
      projectPath: repoPath,
      cwd: repoPath,
      agent: agent.agent,
      handoff: { prompt: "", context: "" },
    });
    toast.success(
      checkout.reused ? `Already on ${checkout.branch}` : `Switched to ${checkout.branch}`,
      {
        description: checkout.isOnPullRequestHead
          ? `The project is on the pull request's branch, with a new ${agent.label} session.`
          : "The branch holds commits of its own or could not move to the pull request's head.",
      },
    );
  };

  const checkoutWorktree = async (pr: PrDetail) => {
    const checkout = await prPrepareCheckout(repoPath, pr);
    await openHandoffSession({
      projectPath: repoPath,
      cwd: checkout.cwd,
      agent: agent.agent,
      handoff: { prompt: "", context: "" },
    });
    const where = checkout.worktreePath
      ? `${checkout.reused ? "Its existing worktree" : "A new worktree"} on ${checkout.branch}`
      : `The project, already on ${checkout.branch}`;
    toast.success("Checked out", {
      description: `${where}, with a new ${agent.label} session there.`,
    });
  };

  const checkout = (mode: CheckoutMode) => {
    if (!detail || pending !== null) return;
    setPending(`checkout:${mode}`);
    void (mode === "local" ? checkoutHere(detail) : checkoutWorktree(detail))
      .catch((err: unknown) =>
        toast.error("Couldn't check out the pull request", {
          description: prErrorMessage(classifyPrError(err)),
        }),
      )
      .finally(() => setPending(null));
  };

  /** A question in a session: the current one when it is in the project. */
  const ask = (handoff: Handoff) => {
    const into = currentSessionTab(repoPath);
    void openHandoffSession({
      projectPath: repoPath,
      cwd: repoPath,
      agent: agent.agent,
      handoff,
      into,
    })
      .then(() =>
        toast.success(into ? "Added to this session" : `Asked in a new ${agent.label} session`, {
          description: "The question is in the composer: read it over, then send.",
        }),
      )
      .catch((err: unknown) =>
        toast.error("Couldn't open a session", { description: errorMessage(err) }),
      );
  };

  const askAboutStop = (stop: GuideStop, index: number, question: string) => {
    if (!detail || pending !== null) return;
    ask(
      buildAskAboutGuideStopHandoff(
        detail,
        {
          index,
          title: stop.title,
          summary: stop.summary,
          attention: stop.attention?.note ?? null,
          excerpts: stop.excerpts,
        },
        question,
      ),
    );
  };

  const askAboutLines = (lines: PickedLines, question: string) => {
    if (!detail || pending !== null) return;
    ask(buildAskAboutLinesHandoff(detail, lines, question));
  };

  const headSha = detail?.headSha ?? null;
  const running = run?.status === "running";
  const fromFork = detail?.isCrossRepository === true;
  const startGuide = () => {
    if (!detail || running) return;
    setConfirmingFork(false);
    // Ready or failed, the run says so itself (`notifyGuideRun`).
    void writeGuide({
      repoPath,
      detail,
      activity,
      agent: guideAgent,
      agentLabel: guideAgentLabel,
      onSaved: () => {
        void client.invalidateQueries({ queryKey: guideQueryKey(repoPath, number) });
      },
    });
  };
  const guideState: PullRequestGuideState = {
    enabled: guideEnabled,
    agentLabel: guideAgentLabel,
    guide,
    loading: guideQuery.isPending && !!guideRepository,
    run,
    running,
    stale: guide !== null && headSha !== null && guide.headSha !== headSha,
    canWrite: guideEnabled && !!detail && headSha !== null,
    // A fork's head is code its author controls, agent configuration
    // included (`AGENTS.md`, hooks, `.mcp.json`), and the guide's agent runs
    // in a checkout of it: the reader says yes to that first.
    write: () => {
      if (!guideEnabled || !detail || running) return;
      if (fromFork) setConfirmingFork(true);
      else startGuide();
    },
    forkConfirm:
      confirmingFork && fromFork && !running
        ? {
            confirm: startGuide,
            cancel: () => setConfirmingFork(false),
          }
        : null,
  };

  return {
    agentLabel: agent.label,
    ask: askQuestion,
    attachesToComposer: sessionTab !== null,
    fixesInSession,
    fixFindingsLabel: fixesInSession ? "Fix findings in this session" : "Fix findings in a session",
    resolveConflicts,
    checkout,
    fixFinding,
    fixFindings,
    explain,
    askAboutStop,
    askAboutLines,
    canExplainInCurrent: () => currentSessionTab(repoPath) !== null,
    pending,
    fixLabel: fixesInSession ? "Fix in this session" : "Fix",
    guide: guideState,
  };
}
