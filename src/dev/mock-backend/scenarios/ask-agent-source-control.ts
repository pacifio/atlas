// Ask agent on source control: every changed file, hunk and commit offers
// "Ask", the commit box offers "Write with agent", and every failure offers
// "Fix with agent".
//
// Opens on source control with every change staged on a new branch, and the
// next push refused by the pre-push hook: run "Commit, push & PR" and the run
// stops on Push with "Fix with agent" beside the retry. Hover a file row or a
// hunk header for "Ask"; select a file for its hunks. History's rows ask about
// a commit; a commit's tab has "Explain" and "Revert with agent". Conflicts'
// "Resolve with agent" is in `?scenario=git-conflict`. Console triggers:
//
//   __atlasMock.actions.commitHookFailed()  the op strip after a commit hook
//                                           refused, with its Fix with agent
//   __atlasMock.actions.gitErrorToast()     a git failure shown as a toast

import { handleGitError } from "@/features/git/lib/git-errors";
import { useGitStore } from "@/features/git/stores/git-store";
import { revealSourceControl } from "@/features/layout/lib/source-control";
import type { Scenario } from "../types";
import { gitFailNextPush, gitStageAll, seedCurrentBranch } from "../fixtures/git";

/** A seeded branch with no upstream yet, so the push publishes it. */
const BRANCH = "renovate/design-tokens-and-the-entire-colour-system-rewrite";

const HOOK_LINES = [
  "husky - pre-commit hook",
  "↓ lint-staged",
  "  ✔ oxfmt --write",
  "  ✖ oxlint --fix",
  "src/features/billing/plan-card.tsx",
  "  42:18  error  Unused variable `planTier`  no-unused-vars",
  "✖ 1 problem (1 error, 0 warnings)",
  "husky - pre-commit hook exited with code 1 (error)",
];

/** The op strip as a commit whose pre-commit hook refused leaves it. */
function commitHookFailed(): void {
  revealSourceControl("changes");
  useGitStore.setState({
    activeOp: {
      opId: "mock-hook",
      kind: "commit",
      running: false,
      lines: HOOK_LINES.map((text, seq) => ({ seq, stream: "stderr", text })),
      progress: null,
      error: {
        code: "hook-failed",
        message: "The pre-commit hook failed: oxlint found 1 error.",
        rawStderr: "husky - pre-commit hook exited with code 1 (error)",
        command: "git commit -F -",
        exitCode: 1,
      },
    },
  });
}

/** A failure that is not worth a dialog, so a toast. */
function gitErrorToast(): void {
  revealSourceControl("changes");
  handleGitError({
    code: "unknown-ref",
    message: "There is no branch or tag named origin/release-0.4.",
    rawStderr: "fatal: invalid reference: origin/release-0.4",
    command: "git checkout origin/release-0.4",
    exitCode: 128,
  });
}

export const askAgentSourceControl: Scenario = {
  name: "ask-agent-source-control",
  description:
    "Source control's ask-agent actions: Ask on files, hunks and commits, Write with agent, and Fix with agent on a refused push.",
  init: () => {
    seedCurrentBranch(BRANCH);
    gitStageAll();
    gitFailNextPush();
  },
  setup: () => {
    window.setTimeout(() => revealSourceControl("changes"), 400);
  },
  actions: { commitHookFailed, gitErrorToast },
};
