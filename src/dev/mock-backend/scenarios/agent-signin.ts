// The agent sign-in modal and the remove-agent confirm, on demand. Neither
// opens by itself in the mock: sign-in needs a bind to fail, and remove needs
// Settings → Agents. Each action below sets what the auth commands answer,
// then raises the surface the way the app does (`promptSignIn`, `ask`).
//
//   __atlasMock.actions.signInChoose()        three methods to pick from
//   __atlasMock.actions.signInEnv()           lands on the API-key checklist
//   __atlasMock.actions.signInFail()          the browser method is refused
//   __atlasMock.actions.signInHang()          the browser method never returns
//   __atlasMock.actions.signInTerminalOnly()  one CLI method → terminal dock
//   __atlasMock.actions.removeAgent()         the remove-agent confirm

import type { AuthEnvStatus, AuthMethodWire } from "@/features/chat/lib/agents-api";
import type { Scenario } from "../types";

type Mode = "ok" | "fail" | "hang" | "terminal-only";
let mode: Mode = "ok";

const BROWSER: AuthMethodWire = {
  id: "browser",
  name: "Sign in with your browser",
  description: "Opens the provider's sign-in page and stores the token for you.",
  kind: "agent",
  link: null,
  terminalCommand: null,
  terminalArgs: null,
  terminalLabel: null,
  apiKeyProvider: null,
};

const API_KEY: AuthMethodWire = {
  id: "api-key",
  name: "Use an API key",
  description: "Export the key in your shell profile.",
  kind: "env_var",
  envVars: [
    { name: "ATLAS_DEMO_API_KEY", label: "API key", secret: true, optional: false },
    { name: "ATLAS_DEMO_ORG", label: "Organisation", secret: false, optional: true },
  ],
  link: "https://example.invalid/keys",
  terminalCommand: null,
  terminalArgs: null,
  terminalLabel: null,
  // So a bind failure that names an OpenRouter key lands on this checklist
  // (`methodForReason`): the demo variables are not in the provider table.
  apiKeyProvider: "openrouter",
};

const CLI: AuthMethodWire = {
  id: "cli",
  name: "Sign in from the terminal",
  description: "Runs the agent's own login command.",
  kind: "terminal",
  link: null,
  terminalCommand: "/usr/local/bin/demo-agent",
  terminalArgs: ["login"],
  terminalLabel: "Run in a terminal",
  apiKeyProvider: null,
};

const ENV: AuthEnvStatus[] = [
  {
    methodId: "api-key",
    name: "ATLAS_DEMO_API_KEY",
    label: "API key",
    optional: false,
    satisfied: false,
    source: null,
  },
  {
    methodId: "api-key",
    name: "ATLAS_DEMO_ORG",
    label: "Organisation",
    optional: true,
    satisfied: true,
    source: "shell-env",
  },
];

async function prompt(next: Mode, reason?: string): Promise<void> {
  mode = next;
  const { promptSignIn } = await import("@/features/chat/lib/agent-signin");
  promptSignIn("claude-code", { reason });
}

export const agentSignin: Scenario = {
  name: "agent-signin",
  description: "The agent sign-in modal and the remove-agent confirm, raised from the console.",
  rawCommands: {
    agents_list_auth_methods: (): AuthMethodWire[] =>
      mode === "terminal-only" ? [CLI] : [BROWSER, API_KEY, CLI],
    agents_auth_env_status: (): AuthEnvStatus[] => ENV,
    agents_authenticate: () =>
      new Promise<null>((resolve, reject) => {
        if (mode === "hang") return;
        setTimeout(() => {
          if (mode === "fail") reject("Sign-in was refused by the agent.");
          else resolve(null);
        }, 2500);
      }),
    agents_logout: () => null,
  },
  actions: {
    signInChoose: () => prompt("ok"),
    signInEnv: () => prompt("ok", "OPENROUTER_API_KEY is missing"),
    signInFail: () => prompt("fail"),
    signInHang: () => prompt("hang"),
    signInTerminalOnly: () => prompt("terminal-only"),
    removeAgent: async () => {
      const { useRemoveAgentConfirmStore } =
        await import("@/features/agents/lib/remove-agent-confirm");
      const answer = await useRemoveAgentConfirmStore.getState().actions.ask({ name: "Amp" });
      console.info("[mock-backend] removeAgent answered:", answer);
    },
  },
};
