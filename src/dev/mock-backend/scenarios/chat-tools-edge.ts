// The tool-call edges `chat-tools` leaves out: one call of every kind
// (an MCP tool among them), a command with 50,000 lines of output, a turn the
// user stopped mid-command and a turn that failed mid-command. For checking
// how the transcript draws each, and what the session-view adapter
// (`session-view-adapter.ts`) makes of them.

import type { Scenario } from "../types";
import { ended, lines, text, tool, tools, user, t } from "../fixtures/chat";
import { cancelTurn, failTurn, playTranscript, setSeedTranscript, setStatus } from "../fake-agent";

const before = "export const limit = 5;\n";
const after = "export const limit = 10;\n";

const everyKind = [
  user("Raise the cart limit, file an issue for it and check the docs.", t(0)),
  tools(
    [
      tool.edit("src/cart/limits.ts", before, after),
      tool.edit("src/cart/limits.test.ts", undefined, lines(12, "// test")),
      tool.run("bun run test src/cart", { result: "Tests: 6 passed\n", took: 3.1 }),
      tool.read("src/cart/cart.ts"),
      tool.search("limit", { took: 0.8 }),
      tool.other("mcp__github__create_issue", { title: "Raise the cart limit to 10" }),
      tool.delegate("Check every caller of the cart limit"),
      tool.fetch("https://docs.example.com/cart"),
    ],
    t(2),
  ),
  ended(text("The limit is 10 now, the tests pass and the issue is filed.", t(20)), 20),
];

const hugeOutput = [
  user("Run the production build.", t(30)),
  tools([tool.run("bun run build", { result: lines(50_000, "out"), took: 48 })], t(31)),
  ended(text("The build finished; the log is long.", t(80)), 50),
];

/** A command still running when the user stops the turn. */
async function cancelledTurn(): Promise<void> {
  await playTranscript([
    user("Run the end-to-end suite.", t(90)),
    tools([tool.run("bun run e2e", { id: "tc-cancelled", status: "running" })], t(91)),
  ]);
  await setStatus("running");
  await new Promise((r) => setTimeout(r, 1500));
  await cancelTurn();
}

/** A command still running when the turn fails upstream. */
async function failedTurn(): Promise<void> {
  await playTranscript([
    user("Deploy the preview.", t(100)),
    tools([tool.run("bun run deploy:preview", { id: "tc-failed", status: "running" })], t(101)),
  ]);
  await setStatus("running");
  await new Promise((r) => setTimeout(r, 1500));
  await failTurn("upstream 503", "transient");
}

export const chatToolsEdge: Scenario = {
  name: "chat-tools-edge",
  description:
    "Every tool kind incl. MCP, a 50,000-line output, a cancelled turn and a failed turn.",
  init: () => setSeedTranscript([...everyKind, ...hugeOutput]),
  setup: async () => {
    // The chat tab binds its session shortly after mount; the seed plays then.
    await new Promise((r) => setTimeout(r, 1500));
    await cancelledTurn();
    await new Promise((r) => setTimeout(r, 500));
    await failedTurn();
  },
};
