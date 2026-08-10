// Persisted provider+model preference for the native Atlas (Cersei) agent.
//
// The ACP agents (Claude Code / Codex) carry their model server-side, but the
// in-process Cersei agent picks a BYOK provider+model in the composer. New chats
// start fresh, so without this the picker would reset to the first configured
// provider every time. We remember the last full selection (globally, not per
// project — it's a user preference) and seed new sessions from it.

export interface CerseiModelPref {
  provider: string;
  model: string;
}

const KEY = "atlas:cersei-model-pref";

/** Last provider+model the user picked for the native agent, or null. */
export function loadCerseiModelPref(): CerseiModelPref | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as CerseiModelPref;
    if (
      v &&
      typeof v.provider === "string" &&
      typeof v.model === "string" &&
      v.provider &&
      v.model
    ) {
      return v;
    }
  } catch {
    // corrupt / unavailable storage — treat as a miss
  }
  return null;
}

/** Persist the user's provider+model selection (best-effort). */
export function saveCerseiModelPref(pref: CerseiModelPref): void {
  try {
    if (pref.provider && pref.model) {
      localStorage.setItem(KEY, JSON.stringify(pref));
    }
  } catch {
    // storage full / unavailable — best-effort
  }
}

const EFFORT_KEY = "atlas:cersei-effort-pref";

/** Last reasoning-effort level the user picked ("" = model default), or "". */
export function loadCerseiEffort(): string {
  try {
    return localStorage.getItem(EFFORT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Persist the reasoning-effort preference (best-effort). */
export function saveCerseiEffort(effort: string): void {
  try {
    localStorage.setItem(EFFORT_KEY, effort);
  } catch {
    // best-effort
  }
}

const COMPRESS_KEY = "atlas:cersei-compress-pref";

/** RTK compression preference (default ON when unset). */
export function loadCerseiCompress(): boolean {
  try {
    return localStorage.getItem(COMPRESS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Persist the compression preference (best-effort). */
export function saveCerseiCompress(on: boolean): void {
  try {
    localStorage.setItem(COMPRESS_KEY, on ? "1" : "0");
  } catch {
    // best-effort
  }
}
