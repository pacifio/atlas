import { describe, expect, it, vi } from "vitest";

import {
  initialShipState,
  needsNewBranch,
  planSteps,
  resumeStep,
  runShip,
  shipBlockedReason,
  type ShipContext,
  type ShipDeps,
  type ShipRequest,
} from "./ship-flow";

const request = (over: Partial<ShipRequest> = {}): ShipRequest => ({
  variant: "commit_push_pr",
  summary: "fix(pdf): keep highlight rects on rotate",
  description: "Rects were computed before the rotation.",
  coAuthors: [],
  newBranch: null,
  pr: { title: "", base: "main" },
  ...over,
});

/** Deps that record every call in order; `fail` names a step to reject once. */
function deps(opts: { fail?: string; failTimes?: number; openPr?: boolean } = {}) {
  const calls: string[] = [];
  let failures = opts.failTimes ?? 1;
  const step = (name: string) => async () => {
    calls.push(name);
    if (opts.fail === name && failures > 0) {
      failures -= 1;
      throw new Error(`${name} broke`);
    }
  };
  const d: ShipDeps = {
    checkGh: step("check"),
    createBranch: vi.fn(async (name: string) => {
      await step("branch")();
      calls.push(`branch:${name}`);
    }),
    commit: vi.fn(async () => step("commit")()),
    push: step("push"),
    currentBranch: async () => "fix/pdf",
    findOpenPr: async () => {
      calls.push("find");
      return opts.openPr ? { number: 7, url: "https://github.com/a/b/pull/7" } : null;
    },
    createPr: vi.fn(async () => {
      await step("pr")();
      return { number: 12, url: "https://github.com/a/b/pull/12" };
    }),
    describe: (error) => (error instanceof Error ? error.message : String(error)),
  };
  return { d, calls };
}

describe("planSteps", () => {
  it("checks gh first and opens the pull request last", () => {
    expect(planSteps(request())).toEqual(["check", "commit", "push", "pr"]);
  });
  it("adds the new branch before the commit", () => {
    expect(planSteps(request({ newBranch: "atlas/fix" }))).toEqual([
      "check",
      "branch",
      "commit",
      "push",
      "pr",
    ]);
  });
  it("commit & push has no gh check and no pull request", () => {
    expect(planSteps(request({ variant: "commit_push" }))).toEqual(["commit", "push"]);
  });
});

describe("runShip", () => {
  it("runs every step in order and ends on the new pull request", async () => {
    const { d, calls } = deps();
    const seen: string[] = [];
    const end = await runShip(initialShipState(request()), d, (s) => {
      const running = s.steps.find((step) => s.status[step] === "running");
      if (running && seen[seen.length - 1] !== running) seen.push(running);
    });
    expect(calls).toEqual(["check", "commit", "push", "find", "pr"]);
    expect(seen).toEqual(["check", "commit", "push", "pr"]);
    expect(end.phase).toBe("done");
    expect(end.pr).toEqual({ number: 12, url: "https://github.com/a/b/pull/12", existing: false });
    expect(end.branch).toBe("fix/pdf");
  });

  it("titles the pull request from the commit summary and bodies it from the description", async () => {
    const { d } = deps();
    await runShip(initialShipState(request()), d, () => {});
    expect(d.createPr).toHaveBeenCalledWith({
      title: "fix(pdf): keep highlight rects on rotate",
      body: "Rects were computed before the rotation.",
      base: "main",
    });
  });

  it("keeps an edited title and an empty base for the host's default", async () => {
    const { d } = deps();
    await runShip(
      initialShipState(request({ pr: { title: "  Fix rotate  ", base: " " } })),
      d,
      () => {},
    );
    expect(d.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix rotate", base: null }),
    );
  });

  it("stops on the first failure and runs nothing after it", async () => {
    const { d, calls } = deps({ fail: "push" });
    const end = await runShip(initialShipState(request()), d, () => {});
    expect(calls).toEqual(["check", "commit", "push"]);
    expect(end.phase).toBe("failed");
    expect(end.error).toEqual({ step: "push", message: "push broke" });
    expect(end.status).toMatchObject({
      check: "done",
      commit: "done",
      push: "failed",
      pr: "pending",
    });
  });

  it("a gh failure stops the run before anything is committed", async () => {
    const { d, calls } = deps({ fail: "check" });
    const end = await runShip(initialShipState(request()), d, () => {});
    expect(calls).toEqual(["check"]);
    expect(d.commit).not.toHaveBeenCalled();
    expect(end.error?.step).toBe("check");
  });

  it("retries from the failed step without committing again", async () => {
    const { d, calls } = deps({ fail: "push" });
    const failed = await runShip(initialShipState(request()), d, () => {});
    expect(resumeStep(failed)).toBe("push");
    calls.length = 0;
    const end = await runShip(failed, d, () => {});
    expect(calls).toEqual(["push", "find", "pr"]);
    expect(d.commit).toHaveBeenCalledTimes(1);
    expect(end.phase).toBe("done");
    expect(end.error).toBeNull();
  });

  it("a retry that fails again stays on that step", async () => {
    const { d } = deps({ fail: "pr", failTimes: 2 });
    const first = await runShip(initialShipState(request()), d, () => {});
    const second = await runShip(first, d, () => {});
    expect(second.error?.step).toBe("pr");
    expect(second.status.push).toBe("done");
  });

  it("links the pull request already open for the branch instead of opening another", async () => {
    const { d, calls } = deps({ openPr: true });
    const end = await runShip(initialShipState(request()), d, () => {});
    expect(calls).toEqual(["check", "commit", "push", "find"]);
    expect(d.createPr).not.toHaveBeenCalled();
    expect(end.pr).toEqual({ number: 7, url: "https://github.com/a/b/pull/7", existing: true });
    expect(end.phase).toBe("done");
  });

  it("creates the new branch before committing", async () => {
    const { d, calls } = deps();
    await runShip(initialShipState(request({ newBranch: "atlas/fix-pdf" })), d, () => {});
    expect(calls.slice(0, 4)).toEqual(["check", "branch", "branch:atlas/fix-pdf", "commit"]);
  });
});

describe("shipBlockedReason", () => {
  const ctx = (over: Partial<ShipContext> = {}): ShipContext => ({
    canCommit: true,
    amend: false,
    branch: "fix/pdf",
    hasRemote: true,
    isDefault: false,
    busy: false,
    ...over,
  });

  it.each([
    [{ canCommit: false }, "Stage changes to commit."],
    [{ amend: true }, "An amend needs a force push. Push it from the branch bar."],
    [{ branch: null }, "HEAD is detached. Check out a branch to push."],
    [{ hasRemote: false }, "This repository has no remote to push to."],
    [{ busy: true }, "A git action is in progress."],
  ])("%o → %s", (over, reason) => {
    expect(shipBlockedReason(ctx(over))).toBe(reason);
  });

  it("is free on a branch with a remote", () => {
    expect(shipBlockedReason(ctx())).toBeNull();
  });

  it("a pull request from the default branch needs a new branch first", () => {
    expect(needsNewBranch(ctx({ isDefault: true }), "commit_push_pr")).toBe(true);
    expect(needsNewBranch(ctx({ isDefault: true }), "commit_push")).toBe(false);
    expect(needsNewBranch(ctx(), "commit_push_pr")).toBe(false);
  });
});
