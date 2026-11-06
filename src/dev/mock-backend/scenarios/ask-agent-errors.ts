// Ask agent on errors and reviews.
//
// `ask-agent-review` opens the large review diff on its own (no session
// beside it), with two line comments already held as a review: the header's
// "Send review to agent" opens the ask box with both, each a hunk chip. A
// comment left on any line joins them.
//
// `ask-agent-toasts` raises two error toasts: one with a cause, which offers
// "Fix with agent", and a bare one, which does not.
//
// The pull request's actions live on the existing scenarios: `pull-request-
// review` (number 412) for "Address with agent" on its threads and "Address all
// feedback"; `pull-request-conflict` (number 401) for "Fix with agent" on a failing
// check, in its row and in its log. Agent sign-in's "Fix with agent" is
// `agent-signin`'s `signInFail()`.
//
//   __atlasMock.actions.toastErrors()   the two error toasts again
//   __atlasMock.actions.seedReview()    the two held comments again

import { toast } from "sonner";

import type { MentionReviewComment } from "@/features/chat/lib/mentions";
import { diffTabId } from "@/features/git/lib/git-diff-api";
import { useReviewDraftStore } from "@/features/git/stores/review-draft-store";
import type { Scenario } from "../types";
import { MOCK_PROJECT } from "../project";
import { diffLarge } from "./diff-large";

/** The standalone diff's scope key on the working tree (`diff-panel.tsx`). */
const SECTION = `${MOCK_PROJECT.path}\0working-tree\0\0`;

function held(id: string, file: string, line: number, added: string, text: string) {
  const comment: MentionReviewComment = {
    kind: "review_comment",
    id,
    displayName: `${file}:${line}`,
    sectionId: SECTION,
    sectionTitle: "Uncommitted",
    filePath: file,
    rangeLabel: `+${line}`,
    diff: `@@ -${line},1 +${line},1 @@\n+${added}`,
    fenceLanguage: "diff",
    text,
    start: line,
    end: line,
    side: "additions",
    endSide: "additions",
  };
  return comment;
}

function seedReview(): string {
  const tabId = diffTabId(MOCK_PROJECT.path);
  const { clear, add } = useReviewDraftStore.getState().actions;
  clear(tabId);
  add(
    tabId,
    held(
      "rv1",
      "src/modules/group-0/module-00.ts",
      4,
      'export const value0_0 = compute(0, "edited-0") ?? fallback(0); // updated',
      "Why the fallback here? compute never returns undefined.",
    ),
  );
  add(
    tabId,
    held(
      "rv2",
      "src/modules/group-0/module-01.ts",
      7,
      'export const value1_3 = compute(3, "edited-1") ?? fallback(6); // updated',
      "Drop the `// updated` comments before this lands.",
    ),
  );
  return "two comments held on the diff tab";
}

function toastErrors(): void {
  toast.error("Couldn't install Claude Code", {
    description: "npm ERR! code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
  });
  toast.error("Couldn't copy");
}

export const askAgentReview: Scenario = {
  name: "ask-agent-review",
  description: "The review diff with no session beside it and two held comments to send.",
  commands: diffLarge.commands,
  actions: { seedReview, toastErrors },
  setup: async () => {
    const { openGitDiff } = await import("@/features/git/lib/git-diff-api");
    openGitDiff(MOCK_PROJECT.path, "", false);
    seedReview();
  },
};

export const askAgentToasts: Scenario = {
  name: "ask-agent-toasts",
  description: "Two error toasts: one with a cause offers Fix with agent, one bare does not.",
  actions: { toastErrors },
  setup: () => {
    window.setTimeout(toastErrors, 600);
  },
};
