/**
 * Banner click routing: the payload a banner carries and how a response is
 * turned back into the target to open. Pure — `deliver.ts` owns the side
 * effect (`openNotificationTarget`).
 *
 * The payload is the whole target, not a lookup key, so a click that cold-starts
 * the app (no in-memory state) can still route to the exact thread tab or
 * terminal pane, in any project.
 */
import { isNotificationSettingsSection, type NotificationTarget } from "./catalog";
import type { PermissionRef } from "./permission-actions-rules";
import type { SystemNotificationResponse } from "./notifier-api";

export function encodeBannerPayload(
  target: NotificationTarget,
  permission?: PermissionRef,
): string {
  return JSON.stringify({ v: 1, target, ...(permission ? { permission } : {}) });
}

/** The permission request an action button on a banner answers, or null. */
export function permissionForResponse(r: SystemNotificationResponse): PermissionRef | null {
  if (r.actionId === null || !r.payload) return null;
  try {
    const parsed: unknown = JSON.parse(r.payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = (parsed as { permission?: unknown }).permission;
    if (typeof p !== "object" || p === null) return null;
    const { sessionId, requestId } = p as Record<string, unknown>;
    return typeof sessionId === "string" && sessionId && typeof requestId === "string" && requestId
      ? { sessionId, requestId }
      : null;
  } catch {
    return null;
  }
}

function isTarget(t: unknown): t is NotificationTarget {
  if (typeof t !== "object" || t === null) return false;
  const r = t as Record<string, unknown>;
  // App-level targets own no tab.
  if (r.type === "atlas-sign-in") return true;
  if (r.type === "agent-sign-in") return typeof r.agentType === "string" && !!r.agentType;
  if (r.type === "chat-conversation") return typeof r.convId === "string" && !!r.convId;
  if (r.type === "app-update") return true;
  if (r.type === "settings") return isNotificationSettingsSection(r.section);
  if (r.type === "config-file") return true;
  if (r.type === "git-panel") return typeof r.projectId === "string" && !!r.projectId;
  if (typeof r.tabId !== "string" || !r.tabId) return false;
  if (r.type === "terminal") return typeof r.terminalId === "string";
  return r.type === "session";
}

/** The target a plain click on a banner should open, or null (an action
 *  button, a malformed or foreign payload). Action buttons are routed by the
 *  features that offer them. */
export function targetForResponse(r: SystemNotificationResponse): NotificationTarget | null {
  return r.actionId !== null ? null : bannerTarget(r);
}

/** The target a banner was raised for, whether it was clicked or one of its
 *  action buttons pressed — what an action handler runs against. Null for a
 *  malformed or foreign payload. */
export function bannerTarget(r: SystemNotificationResponse): NotificationTarget | null {
  if (!r.payload) return null;
  try {
    const parsed: unknown = JSON.parse(r.payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const target = (parsed as { target?: unknown }).target;
    return isTarget(target) ? target : null;
  } catch {
    return null;
  }
}
