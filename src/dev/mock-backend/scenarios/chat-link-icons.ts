// Web links in a session, each wearing its service's mark: GitHub pull
// requests, issues, commits and repositories, Linear issues, and the other
// services with a bundled icon. A link written bare is shown short ("PR #42",
// "ATL-978"); a link with its own words keeps them. The negatives sit beside
// them (a project link, an unknown host, a link in code, a bare issue key), so
// a regression shows as an icon or a short label where there should be none.
// Repeated, so it doubles as a long transcript to scroll for performance.

import type { Scenario } from "../types";
import { text, user, t } from "../fixtures/chat";
import { setPromptHandler, setSeedTranscript, setStatus, streamText } from "../fake-agent";

const userPrompt = [
  "Can you pick up https://linear.app/atlas/issue/ATL-978/browser-goes-agent-driven",
  "and look at https://github.com/acme/web/pull/42 before you start?",
].join(" ");

const agentReply = [
  "I moved the browser work into Linear as https://linear.app/atlas/issue/ATL-978/browser-goes-agent-driven,",
  "and the settings stay in https://github.com/acme/web/pull/42. It also closes",
  "https://github.com/acme/web/issues/17, and the fix landed in",
  "https://github.com/acme/web/commit/3f9c2d1e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d on",
  "https://github.com/acme/web.",
  "",
  "Written links keep their words: [the review thread](https://github.com/acme/web/pull/42#discussion_r1),",
  "[ATL-981](https://linear.app/atlas/issue/ATL-981) and [the roadmap](https://linear.app/atlas/project/browser-2f1c).",
  "",
  "The other services:",
  "",
  "- GitLab: https://gitlab.com/acme/api/-/merge_requests/7",
  "- Bitbucket: https://bitbucket.org/acme/infra/pull-requests/3",
  "- Codeberg: https://codeberg.org/acme/tools/pulls/5",
  "- Slack: https://acme.slack.com/archives/C024BE91L/p1700000000000100",
  "- Notion: https://www.notion.so/acme/Browser-plan-0123456789abcdef",
  "- Figma: https://www.figma.com/design/AbC123/Session-links",
  "- Vercel: https://vercel.com/acme/web/deployments",
  "- npm: https://www.npmjs.com/package/react-markdown",
  "- Azure DevOps: https://dev.azure.com/acme/shop/_git/web/pullrequest/42,",
  "  https://acme.visualstudio.com/shop/_workitems/edit/17 and https://dev.azure.com/acme/shop/_git/web",
  "",
  "These get the plain globe or nothing: https://example.com/docs, http://localhost:5173/,",
  "[the readme](README.md), `https://github.com/acme/web/pull/42` in code, and the bare key ATL-978.",
  "",
  "```sh",
  "gh pr view https://github.com/acme/web/pull/42",
  "```",
].join("\n");

/** How many exchanges: enough that the transcript scrolls for a while. */
const ROUNDS = 30;

const transcript = Array.from({ length: ROUNDS }, (_, i) => [
  user(userPrompt, t(i * 20)),
  text(agentReply, t(i * 20 + 5)),
]).flat();

export const chatLinkIcons: Scenario = {
  name: "chat-link-icons",
  description:
    "Web links with their service's icon and a short label, with the negatives beside them.",
  init: () => {
    setSeedTranscript(transcript);
    setPromptHandler(({ sessionId }) => {
      void streamReply(sessionId);
      return true;
    });
  },
  // `__atlasMock.actions.streamReply()` streams one into the open session.
  actions: { streamReply: () => void streamReply() },
};

async function streamReply(sessionId?: string): Promise<void> {
  await setStatus("running", sessionId);
  await streamText([agentReply, agentReply].join("\n\n"), { sessionId, chunkMs: 12 });
  await setStatus("idle", sessionId);
}
