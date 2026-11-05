// Settings → General, and the BYOK provider editor.
//
// `models_pricing_get` is load-bearing beyond the row it renders: the pricing
// store writes whatever it gets straight into `prices`, and General then does
// `Object.keys(prices)` — so an unmocked `null` takes the whole tab down.
//
// The BYOK fakes keep real state for the session: setting a key adds it to the
// list and the profile file it would have been written to, unsetting removes
// it, and `reveal` is the only call that ever returns a full value (Rust holds
// the secret and ships `last4` in the list, so the fake does the same).

import type { EnvEntry, EnvKeyMeta, ProfileInfo } from "@/features/settings/lib/byok-api";
import type { ModelPrice } from "@/features/settings/stores/model-pricing-store";
import type { KeybindingsLoadResult } from "@/features/keybindings/lib/keybindings-api";
import { DEFAULT_KEYBINDINGS_FILE, type KeybindingsFile } from "@/features/keybindings/lib/types";
import type { TipsState } from "@/features/tips/lib/tips-api";
import type { TypedHandlers, Unit, Unread } from "../types";

const price = (input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

/**
 * USD per 1M tokens, in the `provider/model` shape models.dev publishes.
 * General counts the keys containing "/" for its "N models priced" line, so
 * the bare-id aliases below are there on purpose: the real cache carries both.
 */
const PRICING: Record<string, ModelPrice> = {
  "anthropic/claude-opus-4": price(15, 75, 1.5, 18.75),
  "anthropic/claude-sonnet-4": price(3, 15, 0.3, 3.75),
  "anthropic/claude-haiku-4": price(0.8, 4, 0.08, 1),
  "anthropic/claude-3-5-haiku": price(0.8, 4, 0.08, 1),
  "openai/gpt-5": price(1.25, 10, 0.125, 0),
  "openai/gpt-5-mini": price(0.25, 2, 0.025, 0),
  "openai/gpt-5-nano": price(0.05, 0.4, 0.005, 0),
  "openai/o3": price(2, 8, 0.5, 0),
  "openai/gpt-4.1": price(2, 8, 0.5, 0),
  "google/gemini-2.5-pro": price(1.25, 10, 0.31, 0),
  "google/gemini-2.5-flash": price(0.3, 2.5, 0.075, 0),
  "google/gemini-2.0-flash": price(0.1, 0.4, 0.025, 0),
  "mistral/mistral-large-latest": price(2, 6),
  "mistral/codestral-latest": price(0.3, 0.9),
  "deepseek/deepseek-chat": price(0.27, 1.1, 0.07, 0),
  "deepseek/deepseek-reasoner": price(0.55, 2.19, 0.14, 0),
  "xai/grok-4": price(3, 15),
  "groq/llama-3.3-70b-versatile": price(0.59, 0.79),
  "meta/llama-4-maverick": price(0.27, 0.85),
  "cohere/command-r-plus": price(2.5, 10),
  "perplexity/sonar-pro": price(3, 15),
  "together/qwen3-235b": price(0.2, 0.6),
  // Bare ids: what a recorded session's model field usually looks like.
  "claude-opus-4": price(15, 75, 1.5, 18.75),
  "claude-sonnet-4": price(3, 15, 0.3, 3.75),
  "gpt-5": price(1.25, 10, 0.125, 0),
  "gemini-2.5-pro": price(1.25, 10, 0.31, 0),
};

const ZSHRC = "/Users/dev/.zshrc";
const ZPROFILE = "/Users/dev/.zprofile";

/** Full values, kept apart from the list exactly as Rust keeps them in Rust. */
const secrets = new Map<string, string>([
  ["ANTHROPIC_API_KEY", "sk-ant-api03-Wb2fQ7t0xLq9Jm4nR8vK1dH6sYcE5pZa3Uo7Tg0Bi2Nl"],
  ["OPENAI_API_KEY", "sk-proj-9Hx4Kv2Rm8Qd1Zc7Ns0Yb6Tp3Lw5Ej-Fa2Gu8Iv4Oq1Xr"],
  ["GEMINI_API_KEY", "AIzaSyD4kQ2mVx9Lp0Rt7Nc3Bw8Hf1Jz6Ye5Ua"],
  ["GROQ_API_KEY", "gsk_7Yw2Qe9Rt4Uv1Ip6Az3Sd8Fg5Hj0Kl"],
  ["OPENROUTER_API_KEY", "sk-or-v1-3Nm8Qp1Zx6Cv9Bt4Ly7Ke2Wr5Da0Gs"],
]);

/**
 * The list the editor renders. Deliberately mixed: two keys Atlas can edit in
 * `.zshrc`, one in a second profile file, one inherited from the ambient
 * environment (read-only — no file to rewrite), and one provider with no key
 * at all, which is the empty row the "Add" flow starts from.
 */
let entries: EnvEntry[] = [
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    last4: "i2Nl",
    file: ZSHRC,
    line: 42,
    editable: true,
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    last4: "1Xr",
    file: ZSHRC,
    line: 43,
    editable: true,
  },
  {
    provider: "google",
    envVar: "GEMINI_API_KEY",
    last4: "5Ua",
    file: ZPROFILE,
    line: 11,
    editable: true,
  },
  {
    provider: "groq",
    envVar: "GROQ_API_KEY",
    last4: "0Kl",
    // Inherited from the parent environment: Atlas found no file defining it.
    file: null,
    line: null,
    editable: false,
  },
  {
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    last4: "0Gs",
    file: ZSHRC,
    line: 58,
    editable: true,
  },
];

/** `ANTHROPIC_API_KEY` → `anthropic`, the way the Rust scanner derives it. */
function providerOf(envVar: string): string {
  return envVar.replace(/_?API_?KEY$/i, "").toLowerCase() || "custom";
}

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface SettingsResponses {
  models_pricing_get: Record<string, ModelPrice>;
  models_pricing_refresh: Unread;
  byok_env_list: EnvKeyMeta[];
  byok_env_entries: EnvEntry[];
  byok_profile_info: ProfileInfo;
  byok_env_reveal: string | null;
  byok_env_set: string;
  byok_env_unset: Unit;
  keybindings_load: KeybindingsLoadResult;
  keybindings_save: KeybindingsFile;
  keybindings_open: Unit;
  menu_set_accelerators: Unit;
  tips_load: TipsState;
  tips_shown: Unit;
  tips_mark_seen: TipsState;
  tips_reset: TipsState;
  tips_checklist_done: TipsState;
  tips_checklist_dismiss: TipsState;
  first_run_complete: Unit;
}

type TipsResponses = Pick<
  SettingsResponses,
  | "tips_load"
  | "tips_shown"
  | "tips_mark_seen"
  | "tips_reset"
  | "tips_checklist_done"
  | "tips_checklist_dismiss"
  | "first_run_complete"
>;

/** `tips.json`, kept in memory until the page reloads: what Rust's
 *  `commands/tips.rs` does, minus the telemetry. */
export function tipsHandlers(initial: Omit<TipsState, "version">): TypedHandlers<TipsResponses> {
  let tips: TipsState = { version: 1, ...initial };
  const once = (list: string[], item: string) => (list.includes(item) ? list : [...list, item]);
  return {
    tips_load: () => tips,
    tips_shown: () => null,
    tips_mark_seen: ({ id }) => (tips = { ...tips, seen: once(tips.seen, id) }),
    tips_reset: ({ keep }) =>
      (tips = {
        ...tips,
        cohort: "fresh",
        checklistDismissed: false,
        seen: tips.seen.filter((id) => (keep as string[]).includes(id)),
      }),
    tips_checklist_done: ({ item }) => (tips = { ...tips, checklist: once(tips.checklist, item) }),
    tips_checklist_dismiss: () => (tips = { ...tips, checklistDismissed: true }),
    first_run_complete: () => null,
  };
}

export const settingsHandlers: TypedHandlers<SettingsResponses> = {
  keybindings_load: (): KeybindingsLoadResult => ({
    file: DEFAULT_KEYBINDINGS_FILE,
    path: "~/.config/atlas/keybindings.json",
    // A returning user; `?scenario=fresh-install` shows the first launch.
    exists: true,
    warnings: [],
  }),
  // Rust writes the file and answers with what it wrote, so the editor shows
  // the saved state rather than the state it optimistically drew.
  keybindings_save: ({ file }): KeybindingsFile =>
    (file as KeybindingsFile) ?? DEFAULT_KEYBINDINGS_FILE,
  keybindings_open: () => null,
  menu_set_accelerators: () => null,
  // Someone who upgraded, with projects: moment tips only and no Get
  // started, so the populated scenarios stay quiet. `?scenario=fresh-install`
  // gets everything.
  ...tipsHandlers({
    cohort: "upgrade",
    seen: [],
    checklist: [],
    checklistDismissed: false,
    activeDays: [],
  }),

  models_pricing_get: (): Record<string, ModelPrice> => PRICING,
  models_pricing_refresh: () => null,

  byok_env_list: (): EnvKeyMeta[] =>
    entries.map(({ provider, envVar, last4 }) => ({ provider, envVar, last4 })),
  byok_env_entries: (): EnvEntry[] => entries.map((entry) => ({ ...entry })),
  byok_profile_info: (): ProfileInfo => ({
    shell: "zsh",
    target: ZSHRC,
    scanned: [
      { path: ZSHRC, exists: true },
      { path: ZPROFILE, exists: true },
      { path: "/Users/dev/.zshenv", exists: false },
      { path: "/Users/dev/.profile", exists: false },
    ],
  }),
  byok_env_reveal: ({ envVar }): string | null => secrets.get(String(envVar)) ?? null,
  byok_env_set: ({ envVar, value }): string => {
    const name = String(envVar);
    const secret = String(value);
    if (!secret.trim()) throw new Error("a key cannot be empty");
    secrets.set(name, secret);
    const existing = entries.find((entry) => entry.envVar === name);
    if (existing) {
      existing.last4 = secret.slice(-4);
      existing.file = existing.file ?? ZSHRC;
      existing.line = existing.line ?? entries.length + 40;
      existing.editable = true;
    } else {
      entries = [
        ...entries,
        {
          provider: providerOf(name),
          envVar: name,
          last4: secret.slice(-4),
          file: ZSHRC,
          line: entries.length + 40,
          editable: true,
        },
      ];
    }
    return ZSHRC;
  },
  byok_env_unset: ({ envVar }): null => {
    const name = String(envVar);
    const entry = entries.find((candidate) => candidate.envVar === name);
    if (entry && !entry.editable) {
      throw new Error(`${name} comes from the environment, not a profile file`);
    }
    entries = entries.filter((candidate) => candidate.envVar !== name);
    secrets.delete(name);
    return null;
  },
};
