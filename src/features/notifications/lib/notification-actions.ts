/**
 * Notification action handlers, by id. A notification names its buttons as
 * data (`NotificationAction`, on the event); the code that runs when one is
 * pressed lives here, registered by whoever offers it — `deliver.ts` for the
 * built-ins ("open", "restart"), a feature's notifier for its own
 * (`git.choose-pull`). The same id answers the toast button and the OS-banner
 * button, so a banner pressed after a cold start routes the same way.
 *
 * Running an action never throws and never leaves a rejection unhandled: a
 * failing handler is logged, and an id nobody registered falls back to "open"
 * so the button still goes somewhere useful.
 *
 * Check before acting: a button can be pressed long after it was offered (a
 * toast that sat, a center item from yesterday). An action whose effect
 * depends on state registers `stillApplies`; when that says no — or cannot
 * tell — the target is opened instead of acting on a stale premise.
 */
import { OPEN_ACTION_ID, type NotificationKind, type NotificationTarget } from "./catalog";

export interface NotificationActionContext {
  kind?: NotificationKind;
  target: NotificationTarget;
  dedupeKey?: string;
}

export type NotificationActionHandler = (ctx: NotificationActionContext) => void | Promise<void>;

export interface NotificationActionOptions {
  /** Is the action's premise still true right now? Runs just before the
   *  handler; false (or a throw) opens the target instead. */
  stillApplies?: (ctx: NotificationActionContext) => boolean | Promise<boolean>;
}

interface Registration extends NotificationActionOptions {
  handler: NotificationActionHandler;
}

const handlers = new Map<string, Registration>();

/** Register the handler for `id`, replacing any earlier one (HMR re-runs a
 *  module's registration). Returns an unregister function. */
export function registerNotificationAction(
  id: string,
  handler: NotificationActionHandler,
  options: NotificationActionOptions = {},
): () => void {
  const registration: Registration = { handler, ...options };
  handlers.set(id, registration);
  return () => {
    if (handlers.get(id) === registration) handlers.delete(id);
  };
}

export function hasNotificationAction(id: string): boolean {
  return handlers.has(id);
}

/** Run the action `id` for a notification. Resolves once the handler settles;
 *  never rejects. */
export async function runNotificationAction(
  id: string,
  ctx: NotificationActionContext,
): Promise<void> {
  const open = handlers.get(OPEN_ACTION_ID);
  let registration = handlers.get(id);
  if (!registration) {
    console.warn(`[notifications] no handler for action "${id}"; opening the target instead`);
    registration = open;
  } else if (registration.stillApplies && !(await applies(id, registration, ctx))) {
    registration = open;
  }
  if (!registration) return;
  try {
    await registration.handler(ctx);
  } catch (err) {
    console.warn(`[notifications] action "${id}" failed:`, err);
  }
}

async function applies(
  id: string,
  registration: Registration,
  ctx: NotificationActionContext,
): Promise<boolean> {
  try {
    return (await registration.stillApplies?.(ctx)) ?? true;
  } catch (err) {
    console.warn(`[notifications] could not check whether "${id}" still applies:`, err);
    return false;
  }
}
