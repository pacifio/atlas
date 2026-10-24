// A chat with every tool-call state the transcript renders: a finished turn
// (folded tool block, a delegated sub-agent, edits, a failed command) followed
// by a live turn with a command still streaming output.

import type { Scenario } from "../types";
import { ended, lines, text, thinking, tool, tools, user, t } from "../fixtures/chat";
import {
  appendToolOutput,
  finishTurn,
  playTranscript,
  requestPermission,
  requestPermissionLongArgs,
  requestPermissionPlan,
  requestPermissionQuestion,
  requestPermissionQuestionMulti,
  setSeedTranscript,
  setStatus,
  upsertSubagent,
  upsertToolCall,
} from "../fake-agent";

const buttonBefore = `export function Button({ label }: { label: string }) {
  return <button className="btn">{label}</button>;
}
`;
const buttonAfter = `export function Button({ label, disabled }: { label: string; disabled?: boolean }) {
  return (
    <button className="btn" disabled={disabled} aria-disabled={disabled}>
      {label}
    </button>
  );
}
`;

const settledTurn = [
  user("Add a disabled state to the Button component and make sure the tests pass.", t(0)),
  thinking(
    "I should look at the Button component and where it is used before changing its props.",
    t(2),
  ),
  tools(
    [
      tool.delegate("Find every Button call site"),
      tool.search("Button", { took: 1.4 }),
      tool.read("src/components/button.tsx"),
      tool.read("src/components/header.tsx"),
      tool.run("ls src/components", { result: "button.tsx\nheader.tsx\n", took: 0.6 }),
    ],
    t(4),
  ),
  text("The Button has no `disabled` prop yet. I'll add one and forward it to the element.", t(9)),
  tools(
    [
      tool.edit("src/components/button.tsx", buttonBefore, buttonAfter),
      tool.edit("src/components/button.test.tsx", undefined, lines(24, "// test")),
    ],
    t(11),
  ),
  tools(
    [
      tool.run("bun run test src/components", {
        took: 6,
        status: "failed",
        result:
          "FAIL src/components/button.test.tsx\n  ✕ renders disabled (4 ms)\n\n  Expected: true\n  Received: undefined\n\nTests: 1 failed, 3 passed",
      }),
      tool.edit("src/components/button.test.tsx", lines(24, "// test"), lines(26, "// test")),
      tool.run("bun run test src/components", {
        took: 5.2,
        result: "PASS src/components/button.test.tsx\n\nTests: 4 passed",
      }),
    ],
    t(20),
  ),
  ended(
    text(
      "Done. `Button` now accepts `disabled`, sets `aria-disabled` to match, and the four component tests pass.",
      t(41),
    ),
    41,
  ),
];

/**
 * A delegating turn: two children, one that reports its work to this session
 * and one that does not.
 *
 * Both shapes have to be on screen at once, because they render differently
 * and only one of them is obvious. `counter` is a STREAMING child — its calls
 * carry `parent_tool_call_id`, so the panel lists them. `greeter` is a MAIL
 * child, like the native engine's: it runs on its own thread and reports once,
 * so its work count stays 0 and the panel says so rather than showing an
 * empty list.
 */
async function delegatingTurn(): Promise<void> {
  await playTranscript([
    user("Count the files in src/commands and compose a one-line greeting.", t(70)),
    text("Launching both subagents now to work in parallel.", t(71)),
  ]);
  await setStatus("running");

  const launches = tools(
    [
      tool.delegate("Count the files in src/commands", { id: "sa-counter" }),
      tool.delegate("Compose a one-line greeting", { id: "sa-greeter" }),
    ],
    t(72),
  );
  await playTranscript([launches]);

  const startedAt = Date.now();
  await upsertSubagent({
    toolCallId: "sa-counter",
    messageId: launches.id,
    name: "counter",
    role: "explore",
    status: "running",
    prompt: "Count the files in src/commands. Reply with the number only.",
    toolCallCount: 0,
    startedAtMs: startedAt,
  });
  await upsertSubagent({
    toolCallId: "sa-greeter",
    messageId: launches.id,
    name: "greeter",
    status: "running",
    prompt: "Compose exactly one one-line greeting.",
    toolCallCount: 0,
    startedAtMs: startedAt,
  });

  // The streaming child's own calls, stamped with the launch that owns them.
  await new Promise((r) => setTimeout(r, 1200));
  await playTranscript([
    tools(
      [
        tool.search("src/commands", { parent_tool_call_id: "sa-counter" }),
        tool.read("src/commands/mod.rs", { parent_tool_call_id: "sa-counter" }),
      ],
      t(74),
    ),
  ]);
  await upsertSubagent({
    toolCallId: "sa-counter",
    messageId: launches.id,
    name: "counter",
    role: "explore",
    status: "running",
    prompt: "Count the files in src/commands. Reply with the number only.",
    toolCallCount: 2,
    startedAtMs: startedAt,
  });

  // The mail child finishes first and reports in one go — no attributed work,
  // ever. Left with `counter` still running, which is the state worth seeing.
  await new Promise((r) => setTimeout(r, 2000));
  await upsertSubagent({
    toolCallId: "sa-greeter",
    messageId: launches.id,
    name: "greeter",
    status: "completed",
    prompt: "Compose exactly one one-line greeting.",
    result: "Hello! Great to see you here — what would you like to work on today?",
    toolCallCount: 0,
    startedAtMs: startedAt,
    endedAtMs: Date.now(),
  });
}

async function liveTurn(): Promise<void> {
  await playTranscript([
    user("Now run the full test suite.", t(60)),
    text("Running the whole suite.", t(62)),
  ]);
  await setStatus("running");

  const running = tool.run("bun run test", { id: "tc-live", status: "running" });
  // Stamped against the real clock, as Rust stamps a call at first sight.
  running.started_at_ms = Date.now();
  const message = tools([running], t(63));
  await playTranscript([message]);

  const output = [
    "RUN  v3.2.4 /Users/dev/acme-app\n",
    " ✓ src/lib/api.test.ts (12 tests) 41ms\n",
    " ✓ src/lib/utils.test.ts (8 tests) 9ms\n",
    " ✓ src/components/button.test.tsx (4 tests) 22ms\n",
  ];
  for (const delta of output) {
    await new Promise((r) => setTimeout(r, 700));
    await appendToolOutput(message.id, running.id, delta);
  }
  // Left running on purpose — that is the state worth looking at.
  finishLive = async () => {
    await upsertToolCall(message.id, {
      ...running,
      ended_at_ms: Date.now(),
      status: "completed",
      result: output.join("") + "\nTests: 24 passed",
    });
    await finishTurn();
  };
}

let finishLive = async () => {};

export const chatTools: Scenario = {
  name: "chat-tools",
  description:
    "Finished turn with folded tools, edits and a failed run; then a live running command.",
  init: () => setSeedTranscript(settledTurn),
  setup: async () => {
    // The chat tab binds its session shortly after mount; the seed plays then.
    await new Promise((r) => setTimeout(r, 1500));
    await delegatingTurn();
    await new Promise((r) => setTimeout(r, 1500));
    await liveTurn();
    // A scripted beat: the agent wants to run something next, so a reviewer
    // walking this scenario meets the permission modal without needing to
    // know `__atlasMock.actions` exists. Left pending like the live command
    // above — nothing auto-resolves it.
    await new Promise((r) => setTimeout(r, 3500));
    await requestPermission();
  },
  actions: {
    /** Complete the running command: `__atlasMock.actions.finishLive()`. */
    finishLive: () => finishLive(),
    // Every `permission-modal.tsx` variant, on demand.
    requestPermission,
    requestPermissionLongArgs,
    requestPermissionPlan,
    requestPermissionQuestion,
    requestPermissionQuestionMulti,
  },
};
