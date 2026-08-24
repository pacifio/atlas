// Per-agent config-option preferences (#33).
//
// Zed re-applies persisted per-agent defaults at session open
// (`zed-ref/acp.rs:1370-1420`). Atlas keeps per-agent preferences on the
// frontend — the same home as the last-mode pref — and pushes them after bind.
// The discipline is the mode pref's: a remembered pick is only ever pushed when
// the agent still ADVERTISES that knob and offers that value; no pick means
// "defer to the agent's own default", never an Atlas-side override.

import { parseConfigOptions } from "./acp-config-options";

const key = (agentType: string) => `atlas:acp-config-prefs:${agentType}`;

export type ConfigOptionPrefs = Record<string, boolean | string>;

/** The user's remembered picks for this agent, `{}` when none. */
export function loadConfigOptionPrefs(agentType: string): ConfigOptionPrefs {
  try {
    const raw = localStorage.getItem(key(agentType));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ConfigOptionPrefs = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "boolean" || typeof value === "string") out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember an explicit pick. Called from the store's set action, so only
 *  user-driven changes persist — an agent-side change is its own business. */
export function saveConfigOptionPref(
  agentType: string,
  configId: string,
  value: boolean | string,
): void {
  try {
    const prefs = loadConfigOptionPrefs(agentType);
    prefs[configId] = value;
    localStorage.setItem(key(agentType), JSON.stringify(prefs));
  } catch {
    // storage full / unavailable — preferences are best-effort
  }
}

/** What to push at session open: remembered picks the agent still advertises,
 *  with a value it still offers, that differ from where it already sits.
 *
 *  Pure, so the judgement calls — advertised-only, offered-values-only,
 *  skip-when-already-there, drop-stale-shapes — are testable without a DOM. */
export function configOptionPushes(
  advertised: unknown,
  prefs: ConfigOptionPrefs,
): { configId: string; value: boolean | string }[] {
  const knobs = parseConfigOptions(advertised);
  const pushes: { configId: string; value: boolean | string }[] = [];
  for (const knob of knobs) {
    const pref = prefs[knob.id];
    if (pref === undefined) continue;
    if (knob.kind === "boolean") {
      if (typeof pref !== "boolean" || pref === knob.value) continue;
      pushes.push({ configId: knob.id, value: pref });
    } else {
      if (typeof pref !== "string" || pref === knob.currentValue) continue;
      if (!knob.choices.some((choice) => choice.id === pref)) continue;
      pushes.push({ configId: knob.id, value: pref });
    }
  }
  return pushes;
}
