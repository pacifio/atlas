/**
 * The one delivery step — every side effect of a notification happens here:
 * the in-app center, the toast (with its action buttons), the OS banner, the
 * dock badge and the sound. Input is a `NotificationDecision` from the pure
 * `decideNotification`; nothing here decides whether to speak, only how.
 *
 * Each dedupe key is delivered once (bounded memory), so a source that
 * re-emits the same occurrence cannot double-announce.
 *
 * Channels are independent: each runs in isolation, so one that throws or
 * rejects (a store write, the OS notifier) is logged and the rest still fire.
 * Buttons are `decision.actions`, run through `runNotificationAction`.
 */
import { toast } from "sonner";
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { jumpToTerminal } from "@/features/terminal/lib/jump-to-terminal";
import { isWindowFocused } from "@/lib/window-focus";
import { agentBannerIconPath } from "@/lib/notification-icon";
import {
  nativeCapabilities,
  primeNativeNotificationPermission,
  setNativeResponseHandler,
  showNativeNotification,
} from "@/lib/native-notify";
import { playChime } from "@/lib/chime";
import { setDockBadge } from "@/lib/dock-badge";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { notificationToastIcon } from "../components/notification-leading-icon";
import { useNotificationsStore } from "../stores/notifications-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { promptSignIn } from "@/features/chat/lib/agent-signin";
import { commsActions } from "@/features/comms/stores/comms-store";
import { openConfigFile } from "@/features/settings/lib/atlas-config-api";
import { openGitPanel } from "@/features/git/lib/open-git-panel";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { openUpdatePrompt, restartToUpdate } from "@/features/updater/lib/restart-to-update";
import {
  catalogEntry,
  isTabTarget,
  notificationTag,
  notificationToastId,
  OPEN_ACTION_ID,
  RESTART_ACTION_ID,
  type NotificationAction,
  type NotificationChannel,
  type NotificationTarget,
} from "./catalog";
import type { NotificationDecision } from "./decide";
import {
  bannerActionArgs,
  bannerTarget,
  encodeBannerPayload,
  permissionForResponse,
} from "./native-routing";
import { registerNotificationAction, runNotificationAction } from "./notification-actions";
import type { SystemNotificationAction } from "./notifier-api";
import { answerPermissionFromBanner } from "./permission-actions";

const announced = new Set<string>();
const ANNOUNCED_CAP = 500;

/** Bring a notification's target into view, across projects. Resolves once
 *  the jump settles; never rejects. */
export async function openNotificationTarget(t: NotificationTarget): Promise<void> {
  try {
    await jumpTo(t);
  } catch (err) {
    console.warn(`[notifications] opening a ${t.type} target failed:`, err);
  }
}

function jumpTo(t: NotificationTarget): unknown {
  switch (t.type) {
    case "terminal":
      return jumpToTerminal({ tabId: t.tabId, terminalId: t.terminalId, projectId: t.projectId });
    case "session":
      return jumpToSession(t.tabId);
    case "atlas-sign-in":
      return useAuthStore.getState().actions.beginSignIn();
    case "agent-sign-in":
      return promptSignIn(t.agentType);
    case "chat-conversation":
      return commsActions().openConversation(t.convId);
    case "app-update":
      return openUpdatePrompt();
    case "settings":
      return openSettingsSection(t.section);
    case "git-panel":
      return openGitPanel(t.projectId);
    case "config-file":
      return openConfigFile();
    default: {
      // A new target type must say where "Open" goes — this fails to compile
      // until it does.
      const unhandled: never = t;
      throw new Error(`no route for target ${JSON.stringify(unhandled)}`);
    }
  }
}

export { notificationToastId };

registerNotificationAction(OPEN_ACTION_ID, ({ target }) => openNotificationTarget(target));
registerNotificationAction(RESTART_ACTION_ID, () => restartToUpdate());

// A click on an OS banner opens its exact source (thread tab or terminal pane),
// across projects. Registered at module load so a click that launched the app
// is routed as soon as the notifier flushes it. A permission banner's buttons
// answer the request in place; every other button runs its registered action
// against the banner's target.
setNativeResponseHandler((response) => {
  if (response.actionId !== null && permissionForResponse(response)) {
    answerPermissionFromBanner(response);
    return;
  }
  const target = bannerTarget(response);
  if (!target) return;
  void runNotificationAction(response.actionId ?? OPEN_ACTION_ID, {
    target,
    args: bannerActionArgs(response),
  });
});

/** Banner buttons: a permission request's own, else the decision's actions
 *  minus "Open" — a plain click on the banner already opens. */
function bannerActions(d: NotificationDecision): SystemNotificationAction[] | undefined {
  if (d.native.actions) return d.native.actions;
  const actions = d.actions
    .filter((a) => a.id !== OPEN_ACTION_ID)
    .map(({ id, label, destructive }) => ({ id, label, destructive }));
  return actions.length ? actions : undefined;
}

/** The toast's two buttons: sonner's `action` (primary) and `cancel`. */
function toastButtons(d: NotificationDecision) {
  const button = (a: NotificationAction | undefined) =>
    a && {
      label: a.label,
      onClick: () =>
        void runNotificationAction(a.id, {
          kind: d.kind,
          target: d.target,
          dedupeKey: d.dedupeKey,
          args: a.args,
        }),
    };
  return { action: button(d.actions[0]), cancel: button(d.actions[1]) };
}

/** Run one channel; a throw or rejection is logged and stays in this channel. */
function attempt(channel: NotificationChannel, d: NotificationDecision, run: () => unknown): void {
  const fail = (err: unknown) =>
    console.warn(`[notifications] ${channel} failed for ${d.kind} (${d.dedupeKey}):`, err);
  try {
    const result = run();
    if (result instanceof Promise) result.catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** The agent a notification is about, for its leading icon. Resolved here from
 *  the target so every agent kind carries it without per-rule plumbing. */
function agentTypeOf(t: NotificationTarget): string | undefined {
  if (t.type === "agent-sign-in") return t.agentType;
  if (t.type === "session") return useChatStore.getState().sessions[t.tabId]?.agentType;
  return undefined;
}

/** The OS banner. Agent kinds carry the agent's icon where the backend can
 *  show an image; a missing icon just means no image. */
async function showBanner(d: NotificationDecision, agentType: string | undefined): Promise<void> {
  let imagePath: string | undefined;
  if (agentType) {
    await primeNativeNotificationPermission();
    if (nativeCapabilities().images) imagePath = await agentBannerIconPath(agentType);
  }
  await showNativeNotification({
    // Re-delivering a dedupe key replaces its banner; one group per thread/terminal.
    tag: notificationTag(d.kind, d.dedupeKey),
    group: d.groupKey,
    title: d.native.title,
    subtitle: d.native.subtitle,
    body: d.native.body,
    imagePath,
    sound: d.native.sound,
    urgency: d.tier === "needs-you" ? "high" : "normal",
    // Cut to the backend's capabilities by `showNativeNotification`.
    actions: bannerActions(d),
    payload: encodeBannerPayload(d.target, d.native.permission, d.actions),
  });
}

/** Perform a decision. Returns false when it was a duplicate. */
export function deliverNotification(d: NotificationDecision): boolean {
  if (announced.has(d.dedupeKey)) return false;
  announced.add(d.dedupeKey);
  if (announced.size > ANNOUNCED_CAP) {
    const first = announced.values().next().value;
    if (first) announced.delete(first);
  }

  const t = d.target;
  const agentType = catalogEntry(d.kind).source === "agent" ? agentTypeOf(t) : undefined;
  if (d.channels.center) {
    attempt("center", d, () =>
      useNotificationsStore.getState().actions.add({
        kind: d.kind,
        source: catalogEntry(d.kind).source,
        title: d.title,
        body: d.body,
        tabId: isTabTarget(t) ? t.tabId : undefined,
        terminalId: t.type === "terminal" ? t.terminalId : undefined,
        sessionId: t.type === "session" ? t.sessionId : undefined,
        projectId: isTabTarget(t) ? t.projectId : undefined,
        agentType,
        orgId: isTabTarget(t) || t.type === "chat-conversation" ? t.orgId : undefined,
        // App-level targets have no tab to jump to; the panel opens the target.
        target: isTabTarget(t) ? undefined : t,
        // The card itself opens; it keeps the rest until resolved.
        actions: d.actions.filter((a) => a.id !== OPEN_ACTION_ID),
      }),
    );
  }
  // Re-checked at delivery: the badge is for a window in the background now.
  if (d.channels.badge && !isWindowFocused()) {
    attempt("badge", d, () => {
      const unread = useNotificationsStore.getState().items.filter((i) => !i.read).length;
      return setDockBadge(unread);
    });
  }
  if (d.channels.toast) {
    attempt("toast", d, () => {
      const opts = {
        id: notificationToastId(t, d.dedupeKey),
        description: d.body,
        duration: d.toast.durationMs,
        icon: notificationToastIcon(d.kind, agentType),
        ...toastButtons(d),
      };
      if (d.toast.variant === "error") toast.error(d.title, opts);
      else if (d.toast.variant === "success") toast.success(d.title, opts);
      else toast(d.title, opts);
    });
  }
  if (d.channels.native) {
    attempt("native", d, () => showBanner(d, agentType));
  } else if (d.channels.sound) {
    attempt("sound", d, () => playChime());
  }
  return true;
}
