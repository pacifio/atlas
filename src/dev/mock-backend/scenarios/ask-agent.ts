// Ask agent, every way in (`src/features/ask-agent/`).
//
// Opens on source control with a git push rejected, so the error dialog's
// "Fix with agent" can be clicked straight away: the dialog closes, the ask
// box grows from where the button was with "Fix this:" and the error chip,
// and ⌘↵ sends it to the session beside it (the fake agent echoes what it
// received, context blocks included). ⌘K → "Ask agent about…" asks about
// whatever was focused or selected. The console triggers open the box with
// each kind of context:
//
//   __atlasMock.actions.askAboutEverything()  one chip of every kind
//   __atlasMock.actions.askAboutFile()        a file range
//   __atlasMock.actions.askEmpty()            nothing, as ⌘K with no focus
//   __atlasMock.actions.showGitError()        the git error dialog again

import { openAskAgent } from "@/features/ask-agent/lib/ask-agent";
import type { AgentContext } from "@/features/ask-agent/lib/agent-context";
import { revealSourceControl } from "@/features/layout/lib/source-control";
import { useGitStore } from "@/features/git/stores/git-store";
import type { Scenario } from "../types";

const FILE: AgentContext = {
  kind: "file_range",
  path: "src/lib/api.ts",
  startLine: 2,
  endLine: 5,
  excerpt:
    'export async function getUser(id: string) {\n  const res = await fetch(`/api/users/${id}`);\n  if (!res.ok) throw new Error("request failed");\n  return res.json();',
};

const EVERYTHING: AgentContext[] = [
  FILE,
  {
    kind: "diff_hunk",
    path: "src/components/header.tsx",
    hunk: '@@ -12,3 +12,3 @@\n-  <header className="px-4 py-3">\n+  <header className="px-3 py-2">',
    staged: false,
  },
  {
    kind: "memory_entry",
    id: "mem-sessions",
    memoryKind: "decision",
    text: "Agent conversations are sessions; chat means team chat.",
    project: "shop",
  },
  { kind: "commit", sha: "a1b2c3d4e5f6", subject: "Tighten header spacing" },
  {
    kind: "error",
    source: "CI: typecheck",
    message: "src/lib/api.ts(3,9): error TS2339: Property 'json' does not exist on type 'never'.",
    command: "bun run typecheck",
  },
  {
    kind: "quote",
    text: "Retry the request once before surfacing the error.",
    source: "PR review",
  },
];

function showGitError(): void {
  revealSourceControl();
  useGitStore.getState().actions.showErrorDialog({
    code: "history-rewritten",
    message:
      "Your commits were rewritten (rebased or amended) after they were pushed, so the remote still has the old copies. Pulling would bring those back; force-push to replace them.",
    rawStderr:
      " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'git@github.com:northwind/shop.git'\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart.",
    command: "git push --progress",
    exitCode: 1,
  });
}

export const askAgent: Scenario = {
  name: "ask-agent",
  description: "A rejected git push with Fix with agent, plus console triggers for the ask box.",
  setup: () => {
    // After the first layout settles, so source control is there to hold it.
    window.setTimeout(showGitError, 600);
  },
  actions: {
    showGitError,
    askAboutEverything: () => openAskAgent({ context: EVERYTHING }),
    askAboutFile: () => openAskAgent({ context: [FILE], prompt: "Why can this throw? " }),
    askEmpty: () => openAskAgent({}),
  },
};
