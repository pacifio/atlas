// A session with well over a hundred turns, for the turn rail: enough ticks
// that the rail reaches its height cap and compresses, prompts and replies of
// every length for its preview card, and markdown in the replies so the card
// has something to flatten. A tool call every few turns keeps the rows uneven.

import type { SessionMessage } from "@/types/agents";
import type { Scenario } from "../types";
import { text, tool, tools, user, t } from "../fixtures/chat";
import { setSeedTranscript } from "../fake-agent";

const TURNS = 140;

const PROMPTS = [
  "use coderabbit reviews and the associated threads to fix what is still open on the PR",
  "Why does the sidebar flicker when I switch projects?",
  "Rename `useThing` to `useSessionThing` everywhere and update the tests.",
  "Can you check the release notes for 0.4.1 and tell me what is missing from the changelog before we ship it tomorrow morning?",
  "ok",
  "Write a migration for the new settings key.",
];

const REPLIES = [
  "I've opened pull request 415 against 0.4.1. It holds the rest of this session's work: per-project settings, the menu bar, and the legacy-code removal, with the review threads answered inline.",
  "The flicker comes from the project store resetting **before** the new sessions load, so the list renders empty for one frame. I moved the reset behind the load.",
  "Done. Renamed in 14 files:\n\n- `src/features/chat/lib/use-session-thing.ts`\n- the three call sites in the panel\n- the tests, which pass",
  "Two entries are missing: the [turn rail](https://example.com) and the contrast setting. Everything else in the notes matches a merged PR.",
  "Okay.",
  "Added the migration and a test that a config without the key reads the default.",
];

function turn(i: number): SessionMessage[] {
  const at = i * 60;
  const out = [user(`${PROMPTS[i % PROMPTS.length]} (turn ${i + 1})`, t(at))];
  if (i % 4 === 1) {
    out.push(tools([tool.read(`src/features/module-${i}.ts`), tool.search(`term${i}`)], t(at + 5)));
  }
  out.push(text(REPLIES[i % REPLIES.length], t(at + 20)));
  return out;
}

const transcript = Array.from({ length: TURNS }, (_, i) => turn(i)).flat();

export const chatLongSession: Scenario = {
  name: "chat-long-session",
  description: "A 140-turn session: the turn rail at its height cap.",
  init: () => setSeedTranscript(transcript),
};
