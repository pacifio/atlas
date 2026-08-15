// Persisted per-agent explicit mode preference.
//
// When a user explicitly changes a permission/agent mode in Atlas, that pick
// should outlive the tab and the app restart: the next session with the same
// agent starts in it instead of the agent's own default. Keyed by agentType —
// which for registry-installed externals IS the plugin id — so every agent,
// first-party or installed, keeps its own record.
//
// Only user-initiated picks are ever written. Modes the agent advertises at
// `session/new` or adopts on its own (ACP `current_mode_update`, e.g. exiting
// a plan mode) must NOT be stored — persisting those would turn an observed
// state into an Atlas-side default that overrides the CLI's user-level config.

const key = (agentType: string) => `atlas:last-mode:v1:${agentType}`;

/** The last mode the user explicitly picked for this agent, or null. */
export function loadLastModePref(agentType: string): string | null {
  try {
    return localStorage.getItem(key(agentType));
  } catch {
    // storage unavailable — treat as no preference
  }
  return null;
}

/** Record an explicit pick. Passing null clears it, deferring to the agent's
 *  own configured default again. */
export function saveLastModePref(agentType: string, mode: string | null): void {
  try {
    if (mode === null) localStorage.removeItem(key(agentType));
    else localStorage.setItem(key(agentType), mode);
  } catch {
    // storage full / unavailable — persistence is best-effort
  }
}
