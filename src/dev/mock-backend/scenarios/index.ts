// Scenario registry. Add a file next to this one and list it here; it is then
// reachable at `localhost:1420/?scenario=<name>`.

import type { Scenario } from "../types";
import {
  openFeedback,
  openLogTab,
  openNotifications,
  seedNotifications,
  showWelcome,
  updateError,
  updateReady,
} from "../fixtures/app-chrome";
import { commsDraftPeers, commsIncomingMessage } from "../fixtures/comms";
import {
  gitPullAsks,
  gitPullPrefersMerge,
  gitPullPrefersRebase,
  gitRewritePushedCommits,
} from "../fixtures/git";
import { sleepMidTurn, sleepMidTurnFailed } from "../fake-agent";
import { agentSignin } from "./agent-signin";
import {
  chatComments,
  chatCommentsSelection,
  chatCommentsError,
  chatCommentsMany,
  chatCommentsOrphan,
  chatCommentsRepliesOnly,
  chatCommentsUnshared,
  chatCommentsTools,
  chatCommentsLong,
} from "./chat-comments";
import { chatFileChips } from "./chat-file-chips";
import { chatLinkIcons } from "./chat-link-icons";
import { chatLongPrompt } from "./chat-long-prompt";
import { chatLongSession } from "./chat-long-session";
import { chatMarkdown } from "./chat-markdown";
import { chatSidePanels } from "./chat-side-panels";
import { chatSlashCommands } from "./chat-slash-commands";
import { chatTools } from "./chat-tools";
import { chatTurnChanges, chatTurnChangesLong, chatTurnChangesNative } from "./chat-turn-changes";
import { askAgent } from "./ask-agent";
import { askFiles } from "./ask-files";
import { askAgentSourceControl } from "./ask-agent-source-control";
import { askAgentReview, askAgentToasts } from "./ask-agent-errors";
import { captureHealthy } from "./capture-healthy";
import { collab } from "./collab";
import { designSystem } from "./design-system";
import { diffComments, diffLarge } from "./diff-large";
import { filesLarge } from "./files-large";
import { freshInstall } from "./fresh-install";
import { gitConflict } from "./git-conflict";
import { inboxLong } from "./inbox-long";
import { knowledge } from "./knowledge";
import {
  memoryAskAgent,
  memoryEmpty,
  memoryError,
  memoryHistoryEdited,
  memoryLoading,
  memoryPopulated,
  memorySetup,
} from "./memory-setup";
import { northwind } from "./northwind";
import {
  commsConnecting,
  commsNotConnected,
  commsUnavailable,
  openTeamChat,
} from "./northwind-comms";
import { paletteActions } from "./palette-actions";
import { pullRequestScenarios } from "./pull-request";
import { sourceControlScenarios } from "./source-control";
import { sessionContext } from "./session-context";
import { sessionProjects } from "./session-projects";
import { sidebar } from "./sidebar";
import { timelineEmpty } from "./timeline-empty";
import { timelineLong } from "./timeline-long";
// Every blocking prompt a session raises (permission cards, plan review,
// elicitations, the AI grant strip) lives in `permission-actions.ts`, shared
// with `chat-tools`.
import { permissionActions } from "./permission-actions";

const all: Scenario[] = [
  {
    name: "default",
    description: "Every surface, populated. The one to review a theme against.",
    // What the default scenario cannot show by sitting still: a message
    // arriving while you are looking at something else, and git state only a
    // terminal or git config could produce.
    actions: {
      commsIncomingMessage,
      commsDraftPeers,
      openTeamChat,
      ...permissionActions,
      // The computer sleeping under a running turn (`sleep_watch.rs`).
      sleepMidTurn,
      sleepMidTurnFailed,
      gitPullPrefersRebase,
      gitPullPrefersMerge,
      gitPullAsks,
      gitRewritePushedCommits,
      ...paletteActions,
      // The app chrome that only shows when something happens (ATL-935).
      seedNotifications,
      openNotifications,
      openLogTab,
      openFeedback,
      updateReady,
      updateError,
      showWelcome,
    },
  },
  chatTools,
  chatSidePanels,
  chatSlashCommands,
  agentSignin,
  chatComments,
  chatCommentsSelection,
  chatCommentsOrphan,
  chatCommentsMany,
  chatCommentsRepliesOnly,
  chatCommentsTools,
  chatCommentsLong,
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
  askAgent,
  askFiles,
  askAgentSourceControl,
  askAgentReview,
  askAgentToasts,
  diffLarge,
  diffComments,
  filesLarge,
  knowledge,
  collab,
  captureHealthy,
  northwind,
  memorySetup,
  memoryHistoryEdited,
  memoryPopulated,
  memoryAskAgent,
  memoryEmpty,
  memoryError,
  memoryLoading,
  sessionContext,
  ...pullRequestScenarios,
  ...sourceControlScenarios,
  sessionProjects,
  sidebar,
  timelineEmpty,
  timelineLong,
  inboxLong,
  freshInstall,
  commsNotConnected,
  commsConnecting,
  commsUnavailable,
  designSystem,
];

export const scenarios: Record<string, Scenario> = Object.fromEntries(all.map((s) => [s.name, s]));
