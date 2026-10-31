/**
 * The key per-session UI state is stored under: the session's ACP id once it
 * is bound, its tab until then (the same scheme as `pinScope`). The Details
 * card's open flag and the terminal drawer are keyed by it, so "new agent"
 * and opening a session from history (both reuse the tab) never inherit the
 * previous session's state. Whoever owns the state calls its `adopt` when the
 * one key becomes the other.
 */
export function sessionScope(tabId: string, acpSessionId: string | undefined): string {
  return acpSessionId ? `s:${acpSessionId}` : `t:${tabId}`;
}
