// File paths in a session, on both sides of the transcript: `@file` and
// `@folder` mentions in the user's bubble, and paths an agent names in inline
// code and links, which become clickable chips wearing the icon theme. The
// negatives sit beside them (URLs, versions, globs, a path outside the
// project, a fenced block), so a regression in the shape test shows as a chip
// where there should be code. Repeated, so it doubles as a long transcript to
// scroll for performance.

import type { Scenario } from "../types";
import { text, user, t } from "../fixtures/chat";
import { setPromptHandler, setSeedTranscript, setStatus, streamText } from "../fake-agent";
import { MOCK_PROJECT } from "../project";

const userPrompt = [
  "Look at @file:src/components/button.tsx and everything under @folder:src/lib,",
  "then tidy @file:README.md.",
].join(" ");

const agentReply = [
  "The `disabled` prop is read in `src/components/button.tsx:12` and forwarded from",
  "`src/components/header.tsx#L8`. The request helper lives in `src/lib/api.ts`, and",
  `the project readme is \`${MOCK_PROJECT.path}/README.md\`. See [the badge](src/components/badge.tsx)`,
  "for the pattern, and [src/lib/utils.ts](src/lib/utils.ts) for `cn`.",
  "",
  "These stay code: `https://example.com/a.ts`, `1.2.3`, `e.g.`, `src/**/*.ts`,",
  "`/etc/hosts`, `../outside/x.ts` and `useState`.",
  "",
  "```ts",
  'import { Button } from "src/components/button.tsx";',
  "```",
].join("\n");

/** How many exchanges: enough that the transcript scrolls for a while. */
const ROUNDS = 40;

const transcript = Array.from({ length: ROUNDS }, (_, i) => [
  user(userPrompt, t(i * 20)),
  text(agentReply, t(i * 20 + 5)),
]).flat();

export const chatFileChips: Scenario = {
  name: "chat-file-chips",
  description: "File paths as chips in user and agent messages, with the negatives beside them.",
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

/** The reply three times over, so the live tail runs past the inline-parse
 *  limit and the streaming path can be measured too. */
async function streamReply(sessionId?: string): Promise<void> {
  await setStatus("running", sessionId);
  await streamText([agentReply, agentReply, agentReply].join("\n\n"), { sessionId, chunkMs: 12 });
  await setStatus("idle", sessionId);
}
