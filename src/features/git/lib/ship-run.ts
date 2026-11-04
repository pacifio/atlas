// Drives the source-control panel's "Commit, push & PR" (`ship-flow.ts`) on
// the active project's repository: the git verbs go through the git store,
// which streams their hook and push output to the op strip; the pull request
// goes through the gh-only `pr_*` commands. The run's state lives in
// `useShipStore`, keyed by repository, so a retry finds it.

import type { QueryClient } from "@tanstack/react-query";

import { gitErrorText } from "@/features/notifications/lib/outcome-notifier";
import { classifyPrError, isPrError, prErrorMessage } from "@/features/pull-requests/lib/pr-errors";
import { prCreate, prList, prProvider } from "@/features/pull-requests/lib/pull-requests-api";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";
import type { PrError } from "@/features/pull-requests/lib/pull-requests-types";

import { useGitStore, type GitSnapshotWire } from "../stores/git-store";
import { useShipStore } from "../stores/ship-store";
import { invoke } from "@tauri-apps/api/core";
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

function snapshot(repoPath: string): Promise<GitSnapshotWire> {
  return invoke<GitSnapshotWire>("git_snapshot", { path: repoPath });
}

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

export function shipDeps(repoPath: string): ShipDeps {
  const git = () => useGitStore.getState().actions;
  return {
    checkGh: async () => {
      await prProvider(repoPath);
    },
    createBranch: (name) => git().createBranch(name),
    commit: (summary, description, coAuthors) =>
      git().commit(
        summary,
        description ?? undefined,
        false,
        coAuthors.length ? coAuthors : undefined,
      ),
    push: async () => {
      const snap = await snapshot(repoPath);
      await (snap.upstream ? git().push() : git().publishBranch());
    },
    currentBranch: async () => {
      const snap = await snapshot(repoPath);
      return snap.detached || !snap.branch ? null : snap.branch;
    },
    findOpenPr: async (branch) => {
      const result = await prList(repoPath, { head: branch, state: "open", limit: 1 });
      const entry = result.entries[0];
      return entry ? { number: entry.number, url: entry.url } : null;
    },
    createPr: (input) => prCreate(repoPath, { ...input, draft: false }),
    describe: describeShipError,
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
    void useGitStore
      .getState()
      .actions.refresh(repoPath)
      .catch(() => {});
  }
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
