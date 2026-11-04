// The source-control panel's "Commit, push & PR", one scenario per ending.
// Every change starts staged on a branch with no upstream yet, so the run
// commits (through the pre-commit hook), publishes the branch and opens a pull
// request. The git ops run slowly so each step can be watched.
//
//   ?scenario=source-control             every step lands; ends on a new PR
//   ?scenario=source-control-push-fails  the pre-push hook refuses the push;
//                                        Retry pushes again (and lands) without
//                                        committing twice
//   ?scenario=source-control-pr-exists   the branch already has an open PR;
//                                        the run links it instead
//   ?scenario=source-control-no-gh       `gh` is not installed: the run stops
//                                        at its first step, before committing
//   ?scenario=source-control-default-branch
//                                        on `main`: the action asks for a new
//                                        branch and creates it first
//   ?scenario=source-control-clean       nothing to commit

import type { PrError } from "@/features/pull-requests/lib/pull-requests-types";
import type { Scenario } from "../types";
import {
  gitCleanTree,
  gitFailNextPush,
  gitOpPace,
  gitStageAll,
  seedCurrentBranch,
} from "../fixtures/git";
import { pullRequestsHandlers } from "../fixtures/pull-requests";

/** No upstream yet, so the push publishes it. */
const NEW_BRANCH = "renovate/design-tokens-and-the-entire-colour-system-rewrite";
/** Has an upstream, and in `-pr-exists` an open pull request. */
const PR_BRANCH = "fix/pdf-annotations";
/** The default branch: a pull request from it needs a branch of its own. */
const DEFAULT_BRANCH = "main";

const ship = (branch: string, extra?: () => void) => () => {
  seedCurrentBranch(branch);
  gitStageAll();
  gitOpPace(6);
  extra?.();
};

const NOT_INSTALLED: PrError = { kind: "notInstalled" };

export const sourceControlScenarios: Scenario[] = [
  {
    name: "source-control",
    description: "Commit, push & PR from a new branch: every step lands, ending on a new PR.",
    init: ship(NEW_BRANCH),
    actions: { gitFailNextPush, gitCleanTree },
  },
  {
    name: "source-control-push-fails",
    description: "Commit, push & PR where the pre-push hook refuses the push; Retry lands.",
    init: ship(NEW_BRANCH, gitFailNextPush),
  },
  {
    name: "source-control-pr-exists",
    description: "Commit, push & PR on a branch that already has an open pull request.",
    init: ship(PR_BRANCH),
    commands: {
      pr_list: async (args) => {
        const base = await pullRequestsHandlers.pr_list(args);
        const query = (args.query ?? {}) as { head?: string | null };
        if (query.head !== PR_BRANCH) return base;
        const all = await pullRequestsHandlers.pr_list({ ...args, query: {} });
        const open = all.entries.find((e) => e.state === "open");
        return {
          ...base,
          entries: open ? [{ ...open, number: 431, headBranch: PR_BRANCH }] : [],
          nextCursor: null,
        };
      },
    },
  },
  {
    name: "source-control-no-gh",
    description: "Commit, push & PR without the GitHub CLI: stops before committing.",
    init: ship(NEW_BRANCH),
    commands: {
      pr_provider: () => {
        throw NOT_INSTALLED;
      },
    },
  },
  {
    name: "source-control-default-branch",
    description: "Commit, push & PR from main: asks for a new branch and creates it first.",
    init: ship(DEFAULT_BRANCH),
  },
  {
    name: "source-control-clean",
    description: "Source control with nothing to commit.",
    init: () => {
      seedCurrentBranch(PR_BRANCH);
      gitCleanTree();
    },
  },
];
