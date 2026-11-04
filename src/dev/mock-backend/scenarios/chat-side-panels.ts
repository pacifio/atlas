// The composer's live side panels: the plan pill mid-turn, the usage pill in
// its warning tint with every popup section filled, and a few commands for the
// bash history (one multi-line, one carrying an agent-written description).
//
// No other scenario emits `plan_updated`, `context_usage`, `usage_updated` or
// `rate_limits`, so without this one those pills never draw in `bun run dev`.

import type { Scenario } from "../types";
import { t, text, tool, tools, user } from "../fixtures/chat";
import { emitForLatest, finishTurn, setSeedTranscript, setStatus } from "../fake-agent";

const install = tool.run("bun install", { result: "1203 packages installed [2.41s]\n", took: 2.4 });

const seed = [
  user("Migrate the settings page to the new form components and keep the tests green.", t(0)),
  tools(
    [
      tool.run("git status --short", { result: " M src/settings/page.tsx\n", took: 0.3 }),
      {
        ...install,
        arguments: {
          ...(install.arguments as Record<string, unknown>),
          description: "Install dependencies",
        },
      },
      tool.run(
        "bun run test src/settings \\\n  --reporter=verbose \\\n  --coverage --coverage.include='src/settings/**'",
        { result: "Tests: 18 passed\n", took: 7.1 },
      ),
    ],
    t(3),
  ),
  text("Dependencies are installed and the settings tests pass. Starting the migration.", t(14)),
];

const PLAN = [
  { content: "Inventory the settings page's form fields", status: "completed" },
  { content: "Swap the text inputs for the new Field components", status: "completed" },
  { content: "Move validation onto the shared schema", status: "in_progress" },
  { content: "Update the snapshot tests", status: "pending" },
  { content: "Remove the old form helpers", status: "pending" },
];

let compacting = false;

export const chatSidePanels: Scenario = {
  name: "chat-side-panels",
  description: "Live plan pill, usage numbers, quota, and a bash history with a long command.",
  init: () => setSeedTranscript(seed),
  setup: async () => {
    // The chat tab binds its session shortly after mount (as `chat-tools`).
    await new Promise((r) => setTimeout(r, 1500));
    await setStatus("running");
    await emitForLatest((ids) => ({ kind: "plan_updated", ...ids, plan: PLAN }));
    await emitForLatest((ids) => ({
      kind: "context_usage",
      ...ids,
      used: 168_000,
      size: 200_000,
      cost: 0,
    }));
    await emitForLatest((ids) => ({
      kind: "usage_updated",
      ...ids,
      usage: {
        input_tokens: 412_000,
        output_tokens: 18_400,
        cache_read_tokens: 1_920_000,
        cache_creation_tokens: 96_000,
      },
    }));
    const now = Math.floor(Date.now() / 1000);
    await emitForLatest((ids) => ({
      kind: "rate_limits",
      ...ids,
      primary: { used_percent: 72, window_minutes: 300, resets_at: now + 2 * 3600 },
      secondary: { used_percent: 35, window_minutes: 10_080, resets_at: now + 3 * 86_400 },
      plan_type: "pro",
    }));
  },
  actions: {
    /** End the turn; the plan pill hides: `__atlasMock.actions.finish()`. */
    finish: () => finishTurn(),
    /** Toggle the context compaction notice: `__atlasMock.actions.compact()`. */
    compact: async () => {
      compacting = !compacting;
      await emitForLatest((ids) => ({ kind: "compaction", ...ids, active: compacting }));
    },
  },
};
