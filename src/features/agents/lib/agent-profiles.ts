// Named settings for the agents most people run, keyed by ACP registry id.
// Every field is a view onto one of the agent's environment variables — or a
// key inside one that holds JSON, like Codex's `CODEX_CONFIG` — so a profile
// never changes how Atlas talks to an agent, and an agent without one is
// configured through the same Variables list these write to. ADR-0023.
//
// Each variable is from the agent's own documentation, checked against its
// ACP adapter's source for whether it reaches the agent:
//   claude-acp  https://code.claude.com/docs/en/env-vars
//   codex-acp   https://learn.chatgpt.com/docs/config-file/config-reference
//   gemini      https://google-gemini.github.io/gemini-cli/docs/get-started/configuration
//   copilot     https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
//   opencode    https://opencode.ai/docs/cli
//   cursor      https://cursor.com/docs/cli/acp

import type { AgentVariable } from "@/types/agent-catalog";

/** Where a field's value lives: a variable, or a key in a JSON variable. */
export type FieldTarget = { env: string } | { json: string; key: string };

interface FieldBase {
  label: string;
  description: string;
  target: FieldTarget;
  /** "setup" sits with what the agent needs to sign in; "runtime" with how it runs. */
  section: "setup" | "runtime";
}

export type ProfileField = FieldBase &
  (
    | { kind: "path" | "text"; placeholder?: string }
    | { kind: "number"; placeholder?: string; min?: number; max?: number }
    | { kind: "select"; options: { value: string; label: string }[] }
    /** On writes `on`; off removes the variable — some agents read any value
     *  at all as "on". */
    | { kind: "toggle"; on: string }
    /** Kept in the OS keychain, like any variable marked sensitive. */
    | { kind: "secret"; placeholder?: string }
  );

/** The agent's own settings file, which Atlas opens rather than restates:
 *  everything a profile leaves out (effort, compaction, proxies…) lives here. */
export interface ConfigFile {
  /** What the row is called, e.g. "Claude's settings". */
  label: string;
  /** The variable that moves the agent's home, when it's set. */
  dirVar: string;
  /** The home when `dirVar` isn't set. */
  defaultDir: string;
  /** The file, relative to the home. */
  name: string;
  /** Written to a file that doesn't exist yet. */
  empty: string;
}

export interface AgentProfile {
  fields: ProfileField[];
  configFile?: ConfigFile;
  /** False when the agent's ACP entry point ignores extra arguments, so the
   *  Launch arguments field would do nothing. */
  launchArgs: boolean;
  /** An example id for Add custom model. */
  customModelPlaceholder?: string;
}

const env = (name: string): FieldTarget => ({ env: name });
const codexConfig = (key: string): FieldTarget => ({ json: "CODEX_CONFIG", key });

const PROFILES: Record<string, AgentProfile> = {
  "claude-acp": {
    // The adapter reads only `--cli` and `--version`; everything else is env.
    launchArgs: false,
    customModelPlaceholder: "claude-sonnet-5",
    // https://code.claude.com/docs/en/settings — the adapter loads user,
    // project and local settings, so this file reaches every session.
    configFile: {
      label: "Claude's settings",
      dirVar: "CLAUDE_CONFIG_DIR",
      defaultDir: "~/.claude",
      name: "settings.json",
      empty: "{}\n",
    },
    fields: [
      {
        section: "setup",
        kind: "secret",
        label: "API key",
        description: "Bills the Anthropic API instead of your Claude subscription.",
        target: env("ANTHROPIC_API_KEY"),
        placeholder: "Optional",
      },
      {
        section: "runtime",
        kind: "path",
        label: "Claude Code executable",
        description: "Run your own claude binary instead of the one the adapter bundles.",
        target: env("CLAUDE_CODE_EXECUTABLE"),
        placeholder: "Bundled",
      },
      {
        section: "runtime",
        kind: "path",
        label: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        target: env("CLAUDE_CONFIG_DIR"),
        placeholder: "~/.claude",
      },
    ],
  },
  "codex-acp": {
    // The adapter reads only `--version`, `login` and `cli`. Codex settings
    // travel as one JSON object in `CODEX_CONFIG`.
    launchArgs: false,
    customModelPlaceholder: "gpt-6-codex",
    configFile: {
      label: "Codex's config",
      dirVar: "CODEX_HOME",
      defaultDir: "~/.codex",
      name: "config.toml",
      empty: "",
    },
    fields: [
      {
        section: "setup",
        kind: "secret",
        label: "API key",
        description: "Bills the OpenAI API instead of your ChatGPT sign-in.",
        target: env("CODEX_API_KEY"),
        placeholder: "Optional",
      },
      {
        section: "runtime",
        kind: "path",
        label: "Codex executable",
        description: "Run your own codex binary instead of the one the adapter bundles.",
        target: env("CODEX_PATH"),
        placeholder: "Bundled",
      },
      {
        section: "runtime",
        kind: "path",
        label: "CODEX_HOME path",
        description: "Custom Codex home and config directory. It must already exist.",
        target: env("CODEX_HOME"),
        placeholder: "~/.codex",
      },
      {
        section: "runtime",
        kind: "select",
        label: "Reasoning effort",
        description: "How hard the model thinks by default. Not every model offers every level.",
        target: codexConfig("model_reasoning_effort"),
        options: ["low", "medium", "high", "xhigh"].map((v) => ({ value: v, label: cap(v) })),
      },
      {
        section: "runtime",
        kind: "number",
        label: "Auto-compact after",
        description: "Compact once a thread passes this many tokens. Leave empty for the default.",
        target: codexConfig("model_auto_compact_token_limit"),
        placeholder: "e.g. 200000",
        min: 1,
      },
      {
        section: "runtime",
        kind: "text",
        label: "OpenAI base URL",
        description: "Send requests through a proxy or gateway.",
        target: codexConfig("openai_base_url"),
        placeholder: "https://api.openai.com/v1",
      },
    ],
  },
  gemini: {
    launchArgs: true,
    customModelPlaceholder: "gemini-3-pro",
    configFile: {
      label: "Gemini's settings",
      dirVar: "GEMINI_CLI_HOME",
      defaultDir: "~",
      name: ".gemini/settings.json",
      empty: "{}\n",
    },
    fields: [
      {
        section: "setup",
        kind: "secret",
        label: "Gemini API key",
        description: "From Google AI Studio. Leave empty to sign in with your Google account.",
        target: env("GEMINI_API_KEY"),
        placeholder: "Optional",
      },
      {
        section: "setup",
        kind: "text",
        label: "Google Cloud project",
        description: "For Vertex AI or Gemini Code Assist.",
        target: env("GOOGLE_CLOUD_PROJECT"),
        placeholder: "my-project-id",
      },
      {
        section: "setup",
        kind: "text",
        label: "Google Cloud location",
        description: "The region Vertex AI runs in.",
        target: env("GOOGLE_CLOUD_LOCATION"),
        placeholder: "us-central1",
      },
      {
        section: "runtime",
        kind: "path",
        label: "Gemini home",
        description: "The folder Gemini keeps its .gemini directory in.",
        target: env("GEMINI_CLI_HOME"),
        placeholder: "~",
      },
      {
        section: "runtime",
        kind: "toggle",
        label: "Trust every workspace",
        description: "Skip Gemini's prompt to trust a folder before it works there.",
        target: env("GEMINI_CLI_TRUST_WORKSPACE"),
        on: "true",
      },
    ],
  },
  "github-copilot-cli": {
    launchArgs: true,
    fields: [
      {
        section: "setup",
        kind: "secret",
        label: "GitHub token",
        description: "A fine-grained token with Copilot access. Leave empty to sign in instead.",
        target: env("COPILOT_GITHUB_TOKEN"),
        placeholder: "Optional",
      },
      {
        section: "setup",
        kind: "text",
        label: "GitHub host",
        description: "For GitHub Enterprise.",
        target: env("COPILOT_GH_HOST"),
        placeholder: "github.com",
      },
      {
        section: "runtime",
        kind: "path",
        label: "COPILOT_HOME path",
        description: "Where Copilot keeps its config and state.",
        target: env("COPILOT_HOME"),
        placeholder: "~/.copilot",
      },
      {
        section: "runtime",
        kind: "toggle",
        label: "Turn off auto-update",
        description: "Keep the version Atlas installed instead of updating itself.",
        target: env("COPILOT_AUTO_UPDATE"),
        on: "false",
      },
    ],
  },
  opencode: {
    launchArgs: true,
    customModelPlaceholder: "anthropic/claude-sonnet-5",
    fields: [
      {
        section: "runtime",
        kind: "path",
        label: "Config directory",
        description: "Where opencode reads its config, agents and commands from.",
        target: env("OPENCODE_CONFIG_DIR"),
        placeholder: "~/.config/opencode",
      },
      {
        section: "runtime",
        kind: "toggle",
        label: "Turn off auto-compact",
        description: "Let a thread fill its context instead of summarizing it.",
        target: env("OPENCODE_DISABLE_AUTOCOMPACT"),
        on: "true",
      },
    ],
  },
  cursor: {
    launchArgs: true,
    fields: [
      {
        section: "setup",
        kind: "secret",
        label: "API key",
        description: "Signs in without a browser.",
        target: env("CURSOR_API_KEY"),
        placeholder: "Optional",
      },
    ],
  },
};
PROFILES["opencode-v2"] = PROFILES.opencode!;

function cap(word: string): string {
  return word === "xhigh" ? "Extra high" : word[0]!.toUpperCase() + word.slice(1);
}

/** The profile for an agent, or undefined for one Atlas has no fields for. */
export function profileFor(agentId: string): AgentProfile | undefined {
  return PROFILES[agentId];
}

/** Where an agent's settings file is, given its variables: under the home
 *  `dirVar` names, or the default one. May start with `~`. */
export function configFilePath(file: ConfigFile, variables: readonly AgentVariable[]): string {
  const dir = variables.find((v) => v.name === file.dirVar && !v.sensitive)?.value?.trim();
  return `${(dir || file.defaultDir).replace(/\/+$/, "")}/${file.name}`;
}

/** The variable a field lives in. */
export function variableOf(field: ProfileField): string {
  return "env" in field.target ? field.target.env : field.target.json;
}

/** Variables a profile shows as fields, which the Variables list leaves out. */
export function claimedVariables(profile: AgentProfile | undefined): Set<string> {
  return new Set(profile?.fields.map(variableOf));
}

function jsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A field's value: its text, `""` when unset, or `null` for a secret that
 *  is stored but, being in the keychain, never shown. */
export function readField(variables: readonly AgentVariable[], field: ProfileField): string | null {
  const variable = variables.find((v) => v.name === variableOf(field));
  if (!variable) return "";
  if ("env" in field.target) return variable.sensitive ? null : (variable.value ?? "");
  const value = jsonObject(variable.value)[field.target.key];
  return value === undefined || value === null ? "" : String(value);
}

/** `variables` with a field set to `value`; `""` clears it. A secret goes in
 *  as a sensitive variable. A number field stores a number in JSON. */
export function writeField(
  variables: readonly AgentVariable[],
  field: ProfileField,
  value: string,
): AgentVariable[] {
  const name = variableOf(field);
  const trimmed = value.trim();
  const others = variables.filter((v) => v.name !== name);
  const current = variables.find((v) => v.name === name);
  if ("env" in field.target) {
    if (!trimmed) return others;
    return [...others, { name, value: trimmed, sensitive: field.kind === "secret" }];
  }
  const object = jsonObject(current?.value);
  if (!trimmed) delete object[field.target.key];
  else object[field.target.key] = field.kind === "number" ? Number(trimmed) : trimmed;
  if (Object.keys(object).length === 0) return others;
  return [...others, { name, value: JSON.stringify(object), sensitive: false }];
}

/** Whether `value` is acceptable for a number field: empty, or a whole
 *  number in range. */
export function numberProblem(field: ProfileField, value: string): string | null {
  if (field.kind !== "number" || value.trim() === "") return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n)) return "A whole number.";
  if (field.min !== undefined && n < field.min) return `At least ${field.min.toLocaleString()}.`;
  if (field.max !== undefined && n > field.max) return `At most ${field.max.toLocaleString()}.`;
  return null;
}
