// What a sidebar row says about its session, decided once per row.
//
// The live half comes from the chat store (a tab running the session) and
// from Rust (`liveElsewhere`: another process is writing it); the lifecycle
// half — `unread`, `woke` — Rust decides and sends on the row. The order is
// the reference ladder: anything asking for the user beats work in flight,
// work in flight beats a failure, and only a quiet session shows "Woke" or
// "Done".

/** A live tab's state for a session, as the list reads it off the chat store. */
export type SessionLiveStatus = "running" | "waiting" | "error" | null;

export type SessionRowStatus = "input" | "working" | "failed" | "ready";

export function resolveSessionRowStatus(input: {
  live: SessionLiveStatus;
  liveElsewhere: boolean;
  /** Atlas is watching one of its pull requests and will wake its agent:
   *  the session is still the agent's, not back in the user's inbox. */
  watching?: boolean;
  /** A hold keeps the session running in Atlas with no tab on it (Universal
   *  RC): still Atlas's, and still working. */
  heldWorking?: boolean;
}): SessionRowStatus {
  if (input.live === "waiting") return "input";
  if (input.live === "running" || input.liveElsewhere || input.heldWorking || input.watching) {
    return "working";
  }
  if (input.live === "error") return "failed";
  return "ready";
}

export type SessionTopStatus = "input" | "working" | "failed" | "woke" | "done";

/** The status slot's label, or `null` for a quiet row (which shows its time). */
export function resolveSessionTopStatus(input: {
  status: SessionRowStatus;
  unread: boolean;
  woke: boolean;
}): SessionTopStatus | null {
  if (input.status !== "ready") return input.status;
  if (input.woke) return "woke";
  return input.unread ? "done" : null;
}

/** Whether the row steps back: a session already seen, or one an agent is
 *  busy with, is quieter than one asking for the user. */
export function shouldRecedeSessionRow(input: {
  status: SessionRowStatus;
  unread: boolean;
  woke: boolean;
  active: boolean;
}): boolean {
  if (input.active || input.status === "input") return false;
  if (input.status === "working") return true;
  if (input.status === "ready") return !input.unread && !input.woke;
  return false;
}

/** The row's accessible name: title, status, project. */
export function sessionRowLabel(input: {
  title: string;
  statusLabel: string | null;
  projectName: string | null;
  /** The attached projects' names, joined; empty when none. */
  attachedNames?: string;
}): string {
  const attached = input.attachedNames ? `attached: ${input.attachedNames}` : null;
  return [input.title, input.statusLabel, input.projectName, attached].filter(Boolean).join(", ");
}

/** "now", "5m", "3h", "2d", "4w" — the row's compact age. */
export function compactAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s < 365 * 86_400) return `${Math.floor(s / (7 * 86_400))}w`;
  return `${Math.floor(s / (365 * 86_400))}y`;
}
