// A session whose agent advertises a long slash list, so the `/` picker can be
// reviewed at its worst: 60 commands, ten with an argument hint, names past 40
// characters, descriptions past 200, and a `login` the host must still drop
// (Atlas synthesizes its own `/login`).

import type { Scenario } from "../types";
import { setAgentCommands } from "../fake-agent";

interface AcpCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

const LONG_DESCRIPTION =
  "Walks every file the current change touches, checks each one against the repository's own conventions and the open review comments, and writes a summary of what still needs attention, grouped by severity so the most important findings are read first.";

const NAMED: AcpCommand[] = [
  { name: "review", description: "Review the current branch's changes." },
  { name: "init", description: "Create an AGENTS.md describing this repository." },
  { name: "compact", description: "Summarize the session so far to free context." },
  { name: "login", description: "Sign in (dropped by the host, which adds its own)." },
  { name: "checkout", description: "Switch to a branch.", input: { hint: "branch" } },
  { name: "rebase", description: "Rebase onto another branch.", input: { hint: "branch" } },
  { name: "diff", description: "Show the diff against a branch.", input: { hint: "branch" } },
  { name: "open", description: "Open a file in the editor.", input: { hint: "file path" } },
  { name: "explain", description: "Explain what a file does.", input: { hint: "file path" } },
  { name: "test-file", description: "Run one test file.", input: { hint: "file path" } },
  { name: "blame", description: "Who last touched each line.", input: { hint: "file path" } },
  { name: "commit", description: "Commit staged changes.", input: { hint: "message" } },
  { name: "amend", description: "Amend the last commit message.", input: { hint: "message" } },
  { name: "note", description: "Leave a note on the session.", input: { hint: "message" } },
  {
    name: "frontend-design:generate-component-from-figma",
    description: "Generate a component from a Figma frame.",
  },
  {
    name: "release-tools:prepare-changelog-from-merged-prs",
    description: "Draft the changelog from merged pull requests.",
  },
  {
    name: "observability:summarize-last-24h-error-spikes",
    description: "Summarize error spikes from the last day.",
  },
  { name: "audit", description: LONG_DESCRIPTION },
  { name: "security-review", description: LONG_DESCRIPTION },
  { name: "deep-review", description: LONG_DESCRIPTION },
];

const FILLER = [
  "agents",
  "bug",
  "clear",
  "config",
  "context",
  "cost",
  "doctor",
  "export",
  "format",
  "help",
  "hooks",
  "ide",
  "install",
  "lint",
  "logs",
  "mcp",
  "memory",
  "migrate",
  "model",
  "permissions",
  "plan",
  "pr-comments",
  "queue",
  "release",
  "resume",
  "rewind",
  "skills",
  "status",
  "statusline",
  "sync",
  "terminal-setup",
  "todos",
  "upgrade",
  "usage",
  "vim",
  "watch",
  "whoami",
  "workflows",
  "worktree",
  "zen",
];

const COMMANDS: AcpCommand[] = [
  ...NAMED,
  ...FILLER.map((name) => ({ name, description: `Run ${name.replace(/-/g, " ")}.` })),
];

export const chatSlashCommands: Scenario = {
  name: "chat-slash-commands",
  description: "Composer with a large advertised slash list: hints, long names, long descriptions.",
  init: () => setAgentCommands(() => COMMANDS),
};
