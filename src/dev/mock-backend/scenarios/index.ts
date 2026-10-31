// Scenario registry. Add a file next to this one and list it here; it is then
// reachable at `localhost:1420/?scenario=<name>`.

import type { Scenario } from "../types";
import { commsIncomingMessage } from "../fixtures/comms";
import {
  gitPullAsks,
  gitPullPrefersMerge,
  gitPullPrefersRebase,
  gitRewritePushedCommits,
} from "../fixtures/git";
import {
  requestPermission,
  requestPermissionLongArgs,
  requestPermissionPlan,
  requestPermissionQuestion,
  requestPermissionQuestionMulti,
  sleepMidTurn,
  sleepMidTurnFailed,
} from "../fake-agent";
import {
  chatComments,
  chatCommentsSelection,
  chatCommentsError,
  chatCommentsMany,
  chatCommentsOrphan,
  chatCommentsRepliesOnly,
  chatCommentsUnshared,
  chatCommentsTools,
} from "./chat-comments";
import { chatFileChips } from "./chat-file-chips";
import { chatLinkIcons } from "./chat-link-icons";
import { chatLongPrompt } from "./chat-long-prompt";
import { chatLongSession } from "./chat-long-session";
import { chatMarkdown } from "./chat-markdown";
import { chatTools } from "./chat-tools";
import { chatTurnChanges, chatTurnChangesLong, chatTurnChangesNative } from "./chat-turn-changes";
import { collab } from "./collab";
import { designSystem } from "./design-system";
import { diffComments, diffLarge } from "./diff-large";
import { filesLarge } from "./files-large";
import { gitConflict } from "./git-conflict";
import { keymapFirstRun } from "./keymap-first-run";
import { knowledge } from "./knowledge";
import { memorySetup } from "./memory-setup";
import { northwind } from "./northwind";
import { pullRequestScenarios } from "./pull-request";
import { sessionContext } from "./session-context";
import { sessionProjects } from "./session-projects";
import { sidebar } from "./sidebar";
import { timelineEmpty } from "./timeline-empty";

/** Every variant `permission-modal.tsx` renders, callable from any chat
 *  scenario once a session is bound: a plain command, a long/multi-line one,
 *  the ExitPlanMode review, and Claude's AskUserQuestion bridge (single- and
 *  multi-question). See `fake-agent.ts` for how each raises a real
 *  `permission_request` delta. */
const permissionActions = {
  requestPermission,
  requestPermissionLongArgs,
  requestPermissionPlan,
  requestPermissionQuestion,
  requestPermissionQuestionMulti,
};

const all: Scenario[] = [
  {
    name: "default",
    description: "Every surface, populated. The one to review a theme against.",
    // What the default scenario cannot show by sitting still: a message
    // arriving while you are looking at something else, and git state only a
    // terminal or git config could produce.
    actions: {
      commsIncomingMessage,
      ...permissionActions,
      // The computer sleeping under a running turn (`sleep_watch.rs`).
      sleepMidTurn,
      sleepMidTurnFailed,
      gitPullPrefersRebase,
      gitPullPrefersMerge,
      gitPullAsks,
      gitRewritePushedCommits,
    },
  },
  chatTools,
  chatComments,
  chatCommentsSelection,
  chatCommentsOrphan,
  chatCommentsMany,
  chatCommentsRepliesOnly,
  chatCommentsTools,
  chatCommentsUnshared,
  chatCommentsError,
  chatLongPrompt,
  chatLongSession,
  chatMarkdown,
  chatFileChips,
  chatLinkIcons,
  chatTurnChanges,
  chatTurnChangesLong,
  chatTurnChangesNative,
  gitConflict,
  diffLarge,
  diffComments,
  filesLarge,
  knowledge,
  collab,
  northwind,
  memorySetup,
  sessionContext,
  ...pullRequestScenarios,
  sessionProjects,
  sidebar,
  timelineEmpty,
  keymapFirstRun,
  designSystem,
];

export const scenarios: Record<string, Scenario> = Object.fromEntries(all.map((s) => [s.name, s]));
