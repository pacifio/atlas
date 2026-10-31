import type { ThreadRow } from "./history-api";

/**
 * A session's lifecycle fields on a `ThreadRow`, all at rest: active, not
 * pinned or snoozed, never viewed, no completed turn. What the mock backend
 * and test fixtures spread into a row that has no lifecycle of its own.
 *
 * The lifecycle itself is Rust's (`atlas-thread-metadata`'s store): every
 * rule between states is enforced there, and `unread` / `woke` arrive
 * already decided. Nothing here re-derives them.
 */
export const RESTING_LIFECYCLE = {
  settledAt: null,
  pinnedAt: null,
  pinOrder: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastSnoozeWakeAt: null,
  lastViewedAt: null,
  lastTurnCompletedAt: null,
  unread: false,
  woke: false,
} as const satisfies Pick<
  ThreadRow,
  | "settledAt"
  | "pinnedAt"
  | "pinOrder"
  | "snoozedUntil"
  | "snoozedAt"
  | "lastSnoozeWakeAt"
  | "lastViewedAt"
  | "lastTurnCompletedAt"
  | "unread"
  | "woke"
>;
