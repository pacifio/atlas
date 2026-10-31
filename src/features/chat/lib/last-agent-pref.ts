// The agent the user last picked in a composer, for new sessions to start on
// (`newSessionUsesLastAgent`, read in `default-agent.ts`).
//
// Only explicit picks are written: switching agents in a session, or cycling
// with ⌥/. A session that merely opened on an agent did not choose it.

const KEY = "atlas:last-agent:v1";

/** The agent last picked, or null. */
export function loadLastAgentPref(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // storage unavailable: no preference
  }
  return null;
}

/** Record an explicit pick. */
export function saveLastAgentPref(agentType: string): void {
  try {
    localStorage.setItem(KEY, agentType);
  } catch {
    // storage full or unavailable: persistence is best-effort
  }
}
