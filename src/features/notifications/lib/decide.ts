/**
 * The notification decision — pure. Given an event already classified into a
 * catalog kind (title, body, target), the environment it happened in and the
 * user's prefs for that kind, return which channels fire and with what
 * content, or `null` for silence. `deliverNotification` performs the result.
 *
 * Channel rules (per-kind behaviour comes from the catalog):
 *  - center: always, unless the kind drops while the user is looking;
 *  - toast: only when the target is off screen;
 *  - native (OS banner): only when the user is away and prefs allow;
 *  - badge: whenever the center records while the window is unfocused;
 *  - sound: with the OS banner, or — for `needs-you` kinds — in-app when the
 *    target is off screen.
 * "Looking" = target on screen, window focused, input within the last 30 s.
 * "Away" = window unfocused, or focused with no discrete input for ≥ 2 min.
 */
import {
  catalogEntry,
  defaultActions,
  isTabTarget,
  type NotificationAction,
  type NotificationChannel,
  type NotificationKind,
  type NotificationTarget,
  type NotificationTier,
  type ToastVariant,
} from "./catalog";
import type { SystemNotificationAction } from "./notifier-api";
import type { PermissionBannerInfo, PermissionRef } from "./permission-actions-rules";

/** A classified event — what a source (terminal, agent, …) hands the pipeline. */
export interface NotificationEvent {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Second line under the title (the project, when it is not the active one),
   *  for channels that have one. */
  subtitle?: string;
  target: NotificationTarget;
  /** Stable per occurrence; delivery announces each key once. */
  dedupeKey: string;
  /** A permission request: what the banner's Allow once / Deny need. */
  permission?: PermissionBannerInfo;
  /** Buttons to offer, most important first. Omitted → `defaultActions`. */
  actions?: NotificationAction[];
}

export interface NotificationEnv {
  windowFocused: boolean;
  /** ms since the last discrete input (key / pointer). */
  sinceInputMs: number;
  /** The event's target (terminal pane, chat tab) is on screen. */
  targetVisible: boolean;
  /** The target's project is the active one. */
  projectActive: boolean;
  /** The user is not at the machine — `computeAway`. Gates the OS banner. */
  away: boolean;
}

/** Per-kind user prefs. A kind with no entry uses `DEFAULT_KIND_PREFS`. */
export interface KindPrefs {
  enabled: boolean;
  /** Allow the OS banner. */
  native: boolean;
  /** Allow sound (banner sound or in-app chime). */
  sound: boolean;
}

export type NotificationPrefs = Partial<Record<NotificationKind, KindPrefs>>;

export const DEFAULT_KIND_PREFS: KindPrefs = { enabled: true, native: true, sound: false };

export interface NotificationDecision {
  kind: NotificationKind;
  tier: NotificationTier;
  title: string;
  body: string;
  subtitle?: string;
  target: NotificationTarget;
  dedupeKey: string;
  groupKey: string;
  channels: Record<NotificationChannel, boolean>;
  /** Resolved buttons, most important first. The toast shows the first two;
   *  the OS banner shows all but "Open" (a plain click already opens). */
  actions: NotificationAction[];
  toast: { variant: ToastVariant; durationMs: number };
  /** OS banner content; `sound` is set only when the sound channel fires. */
  native: {
    title: string;
    subtitle?: string;
    body: string;
    sound?: string;
    /** Banner action buttons (before capability fitting) and the request
     *  they answer. Permission requests only. */
    actions?: SystemNotificationAction[];
    permission?: PermissionRef;
  };
}

/** "Looking at it" — inside this window a visible, focused target is quiet. */
export const LOOKING_WINDOW_MS = 30_000;

/** Focused with no input for this long counts as away (stepped off, window
 *  left in front). */
export const AWAY_IDLE_MS = 120_000;

/** The one "away" rule, for every source. */
export function computeAway(windowFocused: boolean, sinceInputMs: number): boolean {
  return !windowFocused || sinceInputMs >= AWAY_IDLE_MS;
}

const TARGET_LABEL: Record<NotificationTarget["type"], string> = {
  terminal: "Terminal",
  session: "Agent",
  "atlas-sign-in": "Atlas",
  "agent-sign-in": "Agent",
  "chat-conversation": "Chat",
  "app-update": "Atlas",
  settings: "Atlas",
  "git-panel": "Git",
  "config-file": "Atlas",
};

/** Agent, app and Chat copy is already banner-shaped (title, subtitle, body); the OS shows
 *  the app name, so Atlas adds none. Terminal events keep the project as the
 *  banner title with the event folded into the body. */
function nativeCopy(event: NotificationEvent, source: string) {
  if (source !== "terminal") {
    return { title: event.title, subtitle: event.subtitle, body: event.body };
  }
  return {
    title: `Atlas: ${(isTabTarget(event.target) && event.target.projectName) || TARGET_LABEL[event.target.type]}`,
    body: `${event.title} — ${event.body}`,
  };
}

export function decideNotification(
  event: NotificationEvent,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const entry = catalogEntry(event.kind);
  const p = prefs[event.kind] ?? DEFAULT_KIND_PREFS;
  if (!p.enabled) return null;
  const looking = env.targetVisible && env.windowFocused && env.sinceInputMs < LOOKING_WINDOW_MS;
  if (looking && entry.whenLooking === "drop") return null;

  const center = entry.channels.center;
  const native = entry.channels.native && p.native && env.away;
  const sound =
    entry.channels.sound &&
    entry.sound !== null &&
    p.sound &&
    (native || (entry.tier === "needs-you" && !env.targetVisible));

  return {
    kind: event.kind,
    tier: entry.tier,
    title: event.title,
    body: event.body,
    target: event.target,
    dedupeKey: event.dedupeKey,
    groupKey: entry.groupKey(event.target),
    channels: {
      center,
      toast: entry.channels.toast && !env.targetVisible,
      native,
      badge: entry.channels.badge && center && !env.windowFocused,
      sound,
    },
    actions: event.actions?.length ? event.actions : defaultActions(event.target),
    toast: entry.toast,
    subtitle: event.subtitle,
    native: {
      ...nativeCopy(event, entry.source),
      sound: sound && native ? entry.sound?.native : undefined,
    },
  };
}
