// Drives the source-control panel's "Commit, push & PR" (`ship-flow.ts`) on
// one repository, named on every call (`git-ship-api.ts`), so a project
// switched mid-run never takes a step; the streaming verbs feed the op strip
// under their op ids. The pull request goes through the gh-only `pr_*`
// commands. The run's state lives in `useShipStore`, keyed by repository, so
// a retry finds it.

import type { QueryClient } from "@tanstack/react-query";

import { logEvent } from "@/features/log/lib/log";
import { gitErrorText } from "@/features/notifications/lib/outcome-notifier";
import {
  classifyPrError,
  isPrError,
  noteGhOutcome,
  prErrorMessage,
} from "@/features/pull-requests/lib/pr-errors";
import { prCreate, prList, prProvider } from "@/features/pull-requests/lib/pull-requests-api";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";
import type { PrError } from "@/features/pull-requests/lib/pull-requests-types";

import { useGitStore } from "../stores/git-store";
import { opOutputText } from "./ask-git";
import { isGitError } from "./git-errors";
import { useShipStore } from "../stores/ship-store";
import { shipCommit, shipCreateBranch, shipPublish, shipPush, shipSnapshot } from "./git-ship-api";
import {
  initialShipState,
  runShip,
  type ShipDeps,
  type ShipRequest,
  type ShipState,
  type ShipStep,
} from "./ship-flow";

/** One run per repository at a time. */
const running = new Set<string>();

/** `gh`'s refusals, worded for opening a pull request rather than reading one. */
function prErrorText(error: PrError): string {
  switch (error.kind) {
    case "notInstalled":
      return "The GitHub CLI (gh) is not installed. Install it, then retry.";
    case "notAuthenticated":
      return "The GitHub CLI is signed out. Run `gh auth login`, then retry.";
    default:
      return prErrorMessage(error);
  }
}

export function describeShipError(error: unknown, step: ShipStep): string {
  if (error instanceof Error) return error.message;
  if (step === "check" || step === "pr" || isPrError(error)) {
    return prErrorText(classifyPrError(error));
  }
  return gitErrorText(error);
}

/** What each step runs, for a failure that does not name its command. */
const STEP_COMMAND: Record<ShipStep, string> = {
  check: "gh auth status",
  branch: "git checkout -b",
  commit: "git commit",
  push: "git push",
  pr: "gh pr create",
};

/** The command a failed step ran and everything it printed: git's typed
 *  failure names its command and carries its stderr, and a streamed op (the
 *  commit's hooks, the push's) printed more than that into the op strip. */
export function describeShipDetail(
  error: unknown,
  step: ShipStep,
): { command: string; output?: string } {
  if (isGitError(error)) {
    const op = useGitStore.getState().activeOp;
    const streamed =
      op && !op.running && op.error?.command === error.command ? opOutputText(op.lines) : "";
    const output = streamed.trim() ? streamed : error.rawStderr;
    return { command: error.command || STEP_COMMAND[step], ...(output ? { output } : {}) };
  }
  if (isPrError(error)) {
    return { command: STEP_COMMAND[step], ...(error.message ? { output: error.message } : {}) };
  }
  return { command: STEP_COMMAND[step] };
}

export function shipDeps(repoPath: string): ShipDeps {
  return {
    checkGh: async () => {
      // An explicit check: open a gate an earlier refusal left shut, and ask
      // gh afresh rather than trusting a cached answer from before sign-in.
      noteGhOutcome(null);
      await prProvider(repoPath, true);
    },
    createBranch: async (name) => {
      await shipCreateBranch(repoPath, name);
      logEvent({ source: "git", kind: "branch-create", summary: name, payload: { name } });
      refreshIfActive(repoPath);
    },
    commit: async (summary, description, coAuthors) => {
      await shipCommit(repoPath, summary, description, coAuthors);
      logEvent({ source: "git", kind: "commit", summary: summary.slice(0, 120), payload: {} });
      refreshIfActive(repoPath);
    },
    push: async () => {
      const snap = await shipSnapshot(repoPath);
      await (snap.upstream ? shipPush(repoPath) : shipPublish(repoPath));
    },
    currentBranch: async () => {
      const snap = await shipSnapshot(repoPath);
      return snap.detached || !snap.branch ? null : snap.branch;
    },
    findOpenPr: async (branch) => {
      const result = await prList(repoPath, { head: branch, state: "open", limit: 1 });
      const entry = result.entries[0];
      return entry ? { number: entry.number, url: entry.url } : null;
    },
    createPr: (input) => prCreate(repoPath, { ...input, draft: false }),
    describe: describeShipError,
    detail: describeShipDetail,
  };
}

async function drive(client: QueryClient, repoPath: string, state: ShipState): Promise<void> {
  if (running.has(repoPath)) return;
  running.add(repoPath);
  const { set } = useShipStore.getState().actions;
  try {
    const end = await runShip(state, shipDeps(repoPath), (next) => set(repoPath, next));
    if (end.status.push === "done") await invalidatePullRequestQueries(client, repoPath);
  } finally {
    running.delete(repoPath);
    refreshIfActive(repoPath);
  }
}

/** Refresh the git store, but only while `repoPath` is still its repository:
 *  `refresh(path)` also makes `path` the active one, and a project switched
 *  to mid-run has to stay put. */
function refreshIfActive(repoPath: string): void {
  const store = useGitStore.getState();
  if (store.repoPath === repoPath) void store.actions.refresh(repoPath).catch(() => {});
}

/** Start a run from the commit box. */
export function startShip(client: QueryClient, repoPath: string, request: ShipRequest): void {
  void drive(client, repoPath, initialShipState(request));
}

/** Run a failed run again from the step that failed. */
export function retryShip(client: QueryClient, repoPath: string): void {
  const state = useShipStore.getState().runs[repoPath];
  if (!state || state.phase !== "failed") return;
  void drive(client, repoPath, state);
}

export function dismissShip(repoPath: string): void {
  if (running.has(repoPath)) return;
  useShipStore.getState().actions.clear(repoPath);
}
