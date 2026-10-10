/**
 * Clearing — the effectful half (see `resolve-rules.ts`): dismiss toasts,
 * remove OS banners (capability-gated inside `native-notify`), mark center
 * items read and refresh the dock badge. One helper for every "this
 * notification no longer applies" path.
 */
import { toast } from "sonner";
import { setDockBadge } from "@/lib/dock-badge";
import {
  nativeCapabilities,
  removeNativeNotification,
  removeNativeNotificationGroup,
} from "@/lib/native-notify";
import { useNotificationsStore } from "../stores/notifications-store";
import {
  isEmptyPlan,
  matchesScope,
  planOpened,
  planResolved,
  type ClearPlan,
  type OpenedSource,
  type ResolvedEvent,
} from "./resolve-rules";

/** `resolved`: the thing itself is settled (not merely looked at), so the
 *  matching center items also lose their action buttons. */
function applyClearPlan(plan: ClearPlan, resolved: boolean): void {
  if (isEmptyPlan(plan)) return;
  for (const id of plan.toastIds) toast.dismiss(id);
  for (const tag of plan.tags) removeNativeNotification(tag);
  for (const group of plan.groups) removeNativeNotificationGroup(group);
  const store = useNotificationsStore.getState();
  if (plan.markRead.length > 0) {
    const match = (i: Parameters<typeof matchesScope>[0]) => matchesScope(i, plan.markRead);
    if (resolved) store.actions.resolveWhere(match);
    else store.actions.markReadWhere(match);
  }
  setDockBadge(useNotificationsStore.getState().items.filter((i) => !i.read).length);
}

/** A notification no longer applies. Never throws. */
export function clearResolved(e: ResolvedEvent): void {
  try {
    applyClearPlan(planResolved(e, nativeCapabilities()), true);
  } catch (err) {
    console.warn("notification clear failed:", err);
  }
}

/** The user brought a thread, terminal or conversation on screen. Never throws. */
export function clearOpened(src: OpenedSource): void {
  try {
    applyClearPlan(planOpened(src, nativeCapabilities()), false);
  } catch (err) {
    console.warn("notification clear failed:", err);
  }
}
