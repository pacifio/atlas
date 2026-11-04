// "Commit, push & PR" as one run of steps, pure so the order, the stop on
// failure and the retry are table tests (`ship-flow.test.ts`).
//
//   [check gh] → [new branch] → commit → push → [open pull request]
//
// `check` runs first so a missing or signed-out `gh` stops the run before
// anything is committed. `branch` runs only on the default branch, which a
// pull request merges into. The run walks the steps in order and stops on the
// first that throws; a retry starts again at the step that failed, so a step
// that finished (the commit, above all) is never run twice.
//
// The side effects are `ShipDeps`, wired to the git store and the pull-request
// commands in `ship-run.ts`.

export type ShipVariant = "commit_push" | "commit_push_pr";

export type ShipStep = "check" | "branch" | "commit" | "push" | "pr";

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface ShipRequest {
  variant: ShipVariant;
  summary: string;
  description: string | null;
  coAuthors: string[];
  /** Create and switch to this branch before committing (default branch only). */
  newBranch: string | null;
  /** The pull request to open; ignored without the PR step. */
  pr: { title: string; base: string | null };
}

/** The pull request the run ended on. */
export interface ShipPr {
  number: number;
  url: string;
  /** It was already open for the branch, so none was created. */
  existing: boolean;
}

export interface ShipState {
  request: ShipRequest;
  steps: ShipStep[];
  status: Record<ShipStep, StepStatus>;
  phase: "running" | "failed" | "done";
  /** The step that failed and why, in words. */
  error: { step: ShipStep; message: string } | null;
  pr: ShipPr | null;
  /** Where the work was pushed: the branch name, once known. */
  branch: string | null;
}

export interface ShipDeps {
  /** Rejects when `gh` cannot open a pull request (missing, signed out). */
  checkGh: () => Promise<void>;
  createBranch: (name: string) => Promise<void>;
  commit: (summary: string, description: string | null, coAuthors: string[]) => Promise<void>;
  /** Push the current branch, publishing it (with upstream) when it has none. */
  push: () => Promise<void>;
  /** The checked-out branch, `null` on a detached HEAD. */
  currentBranch: () => Promise<string | null>;
  findOpenPr: (branch: string) => Promise<{ number: number; url: string } | null>;
  createPr: (input: {
    title: string;
    body: string;
    base: string | null;
  }) => Promise<{ number: number; url: string }>;
  /** A rejection in words. */
  describe: (error: unknown, step: ShipStep) => string;
}

export function planSteps(request: ShipRequest): ShipStep[] {
  const pr = request.variant === "commit_push_pr";
  return [
    ...(pr ? (["check"] as const) : []),
    ...(request.newBranch ? (["branch"] as const) : []),
    "commit",
    "push",
    ...(pr ? (["pr"] as const) : []),
  ];
}

export function initialShipState(request: ShipRequest): ShipState {
  const steps = planSteps(request);
  const status = {} as Record<ShipStep, StepStatus>;
  for (const step of ["check", "branch", "commit", "push", "pr"] as const) status[step] = "pending";
  return {
    request,
    steps,
    status,
    phase: "running",
    error: null,
    pr: null,
    branch: request.newBranch,
  };
}

/** The step a retry starts at: the failed one, else the first not done. */
export function resumeStep(state: ShipState): ShipStep | null {
  return state.steps.find((step) => state.status[step] !== "done") ?? null;
}

/**
 * Run `state`'s remaining steps in order. Every change is reported through
 * `onChange` as a new state object; the final state is also returned. Steps
 * already `done` are skipped, so passing a failed run back in retries it from
 * the step that failed.
 */
export async function runShip(
  state: ShipState,
  deps: ShipDeps,
  onChange: (next: ShipState) => void,
): Promise<ShipState> {
  let current: ShipState = { ...state, phase: "running", error: null };
  const set = (patch: Partial<ShipState>, step?: ShipStep, status?: StepStatus) => {
    current = {
      ...current,
      ...patch,
      status: step && status ? { ...current.status, [step]: status } : current.status,
    };
    onChange(current);
  };
  set({});

  for (const step of current.steps) {
    if (current.status[step] === "done") continue;
    set({}, step, "running");
    try {
      const patch = await runStep(step, current, deps);
      set(patch, step, "done");
    } catch (error) {
      set(
        { phase: "failed", error: { step, message: deps.describe(error, step) } },
        step,
        "failed",
      );
      return current;
    }
  }
  set({ phase: "done" });
  return current;
}

async function runStep(
  step: ShipStep,
  state: ShipState,
  deps: ShipDeps,
): Promise<Partial<ShipState>> {
  const { request } = state;
  switch (step) {
    case "check":
      await deps.checkGh();
      return {};
    case "branch":
      if (request.newBranch) await deps.createBranch(request.newBranch);
      return {};
    case "commit":
      await deps.commit(request.summary, request.description, request.coAuthors);
      return {};
    case "push": {
      await deps.push();
      return { branch: (await deps.currentBranch()) ?? state.branch };
    }
    case "pr": {
      const branch = state.branch ?? (await deps.currentBranch());
      if (!branch) throw new Error("A pull request cannot be opened from a detached HEAD.");
      const open = await deps.findOpenPr(branch);
      if (open) return { pr: { ...open, existing: true }, branch };
      const created = await deps.createPr({
        title: request.pr.title.trim() || request.summary,
        body: request.description ?? "",
        base: request.pr.base?.trim() || null,
      });
      return { pr: { ...created, existing: false }, branch };
    }
  }
}

// ── what the button offers ─────────────────────────────────────────────

export interface ShipContext {
  /** Something is staged (or the commit amends). */
  canCommit: boolean;
  amend: boolean;
  /** `null` on a detached HEAD. */
  branch: string | null;
  hasRemote: boolean;
  isDefault: boolean;
  busy: boolean;
}

/** Why the push variants cannot run now, or `null` when they can. Plain
 *  Commit is gated by `canCommit` alone, as it always was. */
export function shipBlockedReason(ctx: ShipContext): string | null {
  if (ctx.busy) return "A git action is in progress.";
  if (!ctx.canCommit) return "Stage changes to commit.";
  if (ctx.amend) return "An amend needs a force push. Push it from the branch bar.";
  if (!ctx.branch) return "HEAD is detached. Check out a branch to push.";
  if (!ctx.hasRemote) return "This repository has no remote to push to.";
  return null;
}

/** Whether `variant` has to move the work onto a new branch first: a pull
 *  request needs a branch of its own, so one from the default branch does. */
export function needsNewBranch(ctx: ShipContext, variant: ShipVariant): boolean {
  return variant === "commit_push_pr" && ctx.isDefault;
}

export const STEP_LABEL: Record<ShipStep, string> = {
  check: "Check GitHub sign-in",
  branch: "Create branch",
  commit: "Commit",
  push: "Push",
  pr: "Open pull request",
};

/** The retry button, by the step it starts again at. */
export const RETRY_LABEL: Record<ShipStep, string> = {
  check: "Check again",
  branch: "Retry the branch",
  commit: "Retry the commit",
  push: "Retry the push",
  pr: "Retry the pull request",
};
