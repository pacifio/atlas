/**
 * The notification catalog — every kind Atlas can raise, and how it behaves
 * by default. The pipeline is catalog → `decideNotification` (pure: event,
 * environment, prefs → channels + content) → `deliverNotification` (the one
 * place with side effects).
 *
 * Each entry names:
 *  - its urgency `tier` — `needs-you` (blocked on the user), `outcome` (work
 *    finished or failed), `warning` (something degraded), `team` (Chat);
 *  - the `channels` it may use (each still gated by environment and prefs);
 *  - its `sound` (a system sound for the OS banner; the in-app chime when the
 *    banner is not shown);
 *  - its `groupKey` (what collapses together — one terminal, one session);
 *  - whether it is `locked` (cannot be silenced). Every other kind gets its
 *    own switch in Settings, stored in `notifyDisabledKinds`.
 *
 * Pure — no store, Tauri or DOM imports.
 */
export type NotificationTier = "needs-you" | "outcome" | "warning" | "team";

/** Which subsystem raised it — drives the center's icon and click routing. */
export type NotificationSource = "agent" | "terminal" | "app" | "chat";

export type NotificationChannel = "center" | "toast" | "native" | "badge" | "sound";

export type ToastVariant = "default" | "success" | "error";

export interface CatalogEntry {
  /** What Settings calls this kind in its group. */
  label: string;
  /** Not switchable: Settings lists it as always on, and the prefs mapping
   *  leaves it at the defaults (no master, tier or kind switch applies). */
  locked?: true;
  tier: NotificationTier;
  source: NotificationSource;
  /** Channels this kind may use at all. */
  channels: Readonly<Record<NotificationChannel, boolean>>;
  /** While the user is looking at the target: `drop` says nothing at all,
   *  `record` still lands in the center (the other channels are already
   *  quiet because the target is visible and the window focused). */
  whenLooking: "drop" | "record";
  /** `native` is a system sound name for the OS banner; otherwise the
   *  synthesised in-app chime plays. `null` = silent kind. */
  sound: { native: string } | null;
  toast: { variant: ToastVariant; durationMs: number };
  /** Grouping key — notifications sharing one collapse together in the OS
   *  notification list (once a backend supports it). */
  groupKey: (target: NotificationTarget) => string;
}

/** The Settings sections a notification can open. */
export const NOTIFICATION_SETTINGS_SECTIONS = ["models", "agents"] as const;
export type NotificationSettingsSection = (typeof NOTIFICATION_SETTINGS_SECTIONS)[number];
export const isNotificationSettingsSection = (s: unknown): s is NotificationSettingsSection =>
  (NOTIFICATION_SETTINGS_SECTIONS as readonly unknown[]).includes(s);

/** What a notification is about — where "Open" jumps, and the owner used to
 *  filter by organisation. */
export type NotificationTarget =
  | {
      type: "terminal";
      tabId: string;
      terminalId: string;
      projectId?: string;
      projectName?: string;
      orgId?: string;
    }
  | {
      type: "session";
      tabId: string;
      sessionId?: string;
      projectId?: string;
      projectName?: string;
      orgId?: string;
    }
  // App-level targets own no tab: they open a sign-in surface.
  /** Atlas itself is signed out — opens the connect dialog. */
  | { type: "atlas-sign-in" }
  /** One agent needs credentials — opens that agent's sign-in dialog. */
  | { type: "agent-sign-in"; agentType: string }
  /** A Chat conversation (DM, group DM or channel) — opens it in the Chat panel. */
  | { type: "chat-conversation"; convId: string; orgId?: string }
  /** An update is staged — opens the "Restart to update" prompt. */
  | { type: "app-update" }
  /** A Settings section (the model download's and agent update's homes). */
  | { type: "settings"; section: NotificationSettingsSection }
  /** `config.toml` itself — opens it in the OS editor. */
  | { type: "config-file" }
  /** One project's git panel (a push / pull / fetch ran there). */
  | { type: "git-panel"; projectId: string; projectName?: string };

/**
 * A button a notification offers — data only, so events and decisions stay
 * pure and a banner can carry it across a cold start. The `id` names a
 * handler registered with `registerNotificationAction`; the same id serves
 * the toast button and the OS-banner button.
 */
export interface NotificationAction {
  id: string;
  label: string;
  /** Rendered as destructive where the surface supports it (OS banners). */
  destructive?: boolean;
}

/** Built-in action ids — registered by `deliver.ts`. Feature actions use a
 *  `<feature>.<verb>` id and are registered by the source that offers them. */
export const OPEN_ACTION_ID = "open";
export const RESTART_ACTION_ID = "restart";

/** What a notification offers when its source names no actions: "Open" jumps
 *  to the target; a staged update restarts into it instead. */
export function defaultActions(target: NotificationTarget): NotificationAction[] {
  if (target.type === "app-update") return [{ id: RESTART_ACTION_ID, label: "Restart" }];
  return [{ id: OPEN_ACTION_ID, label: "Open" }];
}

/** Targets that live in a chat or terminal tab (and so carry project/org). */
export type TabTarget = Extract<NotificationTarget, { type: "terminal" | "session" }>;
export const isTabTarget = (t: NotificationTarget): t is TabTarget =>
  t.type === "terminal" || t.type === "session";

const ALL_CHANNELS = { center: true, toast: true, native: true, badge: true, sound: true };
const DONE_TOAST_MS = 5_000;
const ATTENTION_TOAST_MS = 15_000;

/** The OS-banner group a target's notifications collapse into. */
export const targetGroupKey = (t: NotificationTarget): string => {
  switch (t.type) {
    case "terminal":
      return `terminal:${t.terminalId}`;
    case "session":
      return `session:${t.sessionId ?? t.tabId}`;
    case "atlas-sign-in":
      return "atlas-sign-in";
    case "agent-sign-in":
      return `agent-sign-in:${t.agentType}`;
    case "chat-conversation":
      return `chat:${t.convId}`;
    case "app-update":
      return "app-update";
    case "settings":
      return `settings:${t.section}`;
    case "git-panel":
      return `git:${t.projectId}`;
    case "config-file":
      return "config-file";
  }
};

/** The toast id a notification's toast carries, so a source can dismiss it later. */
export const notificationToastId = (target: NotificationTarget, dedupeKey: string) =>
  `bg-${target.type}-${dedupeKey}`;

/** The OS-banner tag of a notification — re-delivering a key replaces its banner. */
export const notificationTag = (kind: NotificationKind, dedupeKey: string) =>
  `${kind}:${dedupeKey}`;

export const NOTIFICATION_CATALOG = {
  "terminal-attention": {
    label: "Terminal needs input",
    tier: "needs-you",
    source: "terminal",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "terminal-done": {
    label: "Command finished",
    tier: "outcome",
    source: "terminal",
    channels: ALL_CHANNELS,
    whenLooking: "drop",
    sound: { native: "Ping" },
    toast: { variant: "success", durationMs: DONE_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "terminal-failed": {
    label: "Command failed",
    tier: "outcome",
    source: "terminal",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: DONE_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // Agent kinds — raised by `agent-notifier.ts`; governed by the master and
  // tier switches in Settings, and their own kind switch.
  permission: {
    label: "Permission requests",
    tier: "needs-you",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // The agent asked the user a question mid-turn (ADR-0013) — blocked on the
  // user exactly like a permission request, so it behaves like one.
  "agent-question": {
    label: "Agent questions",
    tier: "needs-you",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // A finish is quiet: the banner carries no sound (permission and failures do).
  "agent-done": {
    label: "Agent finished",
    tier: "outcome",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "drop",
    sound: null,
    toast: { variant: "success", durationMs: DONE_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "agent-failed": {
    label: "Agent failed",
    tier: "outcome",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: DONE_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // The agent process died; the session shows Restart. Nothing moves until
  // the user acts, so it is needs-you (and keeps its banner and sound).
  "agent-disconnected": {
    label: "Agent stopped",
    tier: "needs-you",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // Sign-in problems (ATL-383): every agent stops working until the user acts,
  // so both are needs-you. Each is its own thing to look at, so a visible
  // window is no reason to drop the center record.
  "agent-sign-in": {
    label: "Agent sign-in needed",
    tier: "needs-you",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "atlas-signed-out": {
    label: "Atlas signed out",
    locked: true,
    tier: "needs-you",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // Chat (ATL-387): a DM / group DM message, or an @mention in a channel.
  // Nothing to say while the conversation is on screen and being looked at.
  // Muting does not exist in the Chat model, so there is nothing to honour yet.
  "chat-dm": {
    label: "Direct messages",
    tier: "team",
    source: "chat",
    channels: ALL_CHANNELS,
    whenLooking: "drop",
    sound: { native: "Ping" },
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "chat-mention": {
    label: "Mentions",
    tier: "team",
    source: "chat",
    channels: ALL_CHANNELS,
    whenLooking: "drop",
    sound: { native: "Ping" },
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // Degradation warnings (ATL-385): quiet by design — no sound, and the OS
  // banner is off in the default warning-tier switches.
  "agent-context-warning": {
    label: "Context nearly full",
    tier: "warning",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "agent-rate-limit": {
    label: "Rate limited",
    tier: "warning",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // One toast per thread, updated in place as attempts advance.
  "agent-retrying": {
    label: "Retrying",
    tier: "warning",
    source: "agent",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // Outcome-tier app events (ATL-384): downloads and git remote operations.
  // The update prompt opens by itself on a live "ready", so the toast is the
  // way back to it (with Restart) once dismissed; no sound — nothing is urgent.
  "app-update-ready": {
    label: "Update ready",
    tier: "outcome",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "model-download-done": {
    label: "Model downloaded",
    tier: "outcome",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "success", durationMs: DONE_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "model-download-failed": {
    label: "Model download failed",
    tier: "outcome",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // A success is only worth saying after a long wait (rules in
  // `outcome-notifier-rules.ts`); a failure always is.
  "git-op-done": {
    label: "Git push, pull or fetch finished",
    tier: "outcome",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "drop",
    sound: null,
    toast: { variant: "success", durationMs: DONE_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "git-op-failed": {
    label: "Git push, pull or fetch failed",
    tier: "outcome",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: { native: "Ping" },
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  // App warnings (ATL-386): something degraded that the user can fix. Quiet —
  // no sound, and the OS banner is off in the default warning-tier switches.
  "git-autofetch-failing": {
    label: "Auto-fetch keeps failing",
    tier: "warning",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "git-behind": {
    label: "Branch fell behind its remote",
    tier: "warning",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "default", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "config-error": {
    label: "config.toml has an error",
    tier: "warning",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
  "agent-update-failed": {
    label: "Agent update failed",
    tier: "warning",
    source: "app",
    channels: ALL_CHANNELS,
    whenLooking: "record",
    sound: null,
    toast: { variant: "error", durationMs: ATTENTION_TOAST_MS },
    groupKey: targetGroupKey,
  },
} as const satisfies Record<string, CatalogEntry>;

export type NotificationKind = keyof typeof NOTIFICATION_CATALOG;

export function catalogEntry(kind: NotificationKind): CatalogEntry {
  return NOTIFICATION_CATALOG[kind];
}

export function isNotificationKind(k: unknown): k is NotificationKind {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, k);
}
