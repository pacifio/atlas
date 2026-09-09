/**
 * The terminal notifier's decision rules — a pure module with no store or
 * Tauri imports, so it is unit-testable in plain node and cannot drift into
 * side effects. `terminal-notifier.ts` supplies the environment and delivers.
 */
import type { NotificationKind } from "@/features/notifications/stores/notifications-store";
import type { TerminalNotificationPrefs } from "@/features/settings/lib/app-settings";
import type { TerminalEvent } from "./block-parser";
import { formatDuration } from "./format-duration";

// ── Pure decision ──────────────────────────────────────────────────────────

export interface TerminalCtx {
  terminalId: string;
  tabId: string;
  workspaceId?: string;
  workspaceName?: string;
  orgId?: string;
}

export interface NotifierEnv {
  /** The terminal's pane is on screen in the active workspace. */
  terminalVisible: boolean;
  windowFocused: boolean;
  /** ms since the last discrete input. */
  interactedWithinMs: number;
  /** The owning workspace is the active one. */
  workspaceActive: boolean;
}

export type TerminalNotificationKind = Extract<
  NotificationKind,
  "terminal-done" | "terminal-failed" | "terminal-attention"
>;

export interface Decision {
  kind: TerminalNotificationKind;
  title: string;
  body: string;
  persistMs: number;
  channels: { store: boolean; toast: boolean; native: boolean; sound: boolean };
  dedupeKey: string;
}

/** Ctrl-C: the user ended it; nothing to announce. */
const EXIT_INTERRUPT = 130;
/** "Looking at it" — inside this window a visible, focused terminal is quiet. */
const RECENT_INTERACTION_MS = 30_000;
const ATTENTION_PERSIST_MS = 15_000;
const DONE_PERSIST_MS = 5_000;

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function where(ctx: TerminalCtx, cwd: string, env: NotifierEnv): string {
  const dir = basename(cwd);
  // Name the workspace only when it is not the one on screen — mirrors the
  // chat's background toast.
  return !env.workspaceActive && ctx.workspaceName ? `${dir} — ${ctx.workspaceName}` : dir;
}

export function decideTerminalNotification(
  e: TerminalEvent,
  ctx: TerminalCtx,
  env: NotifierEnv,
  prefs: TerminalNotificationPrefs,
): Decision | null {
  if (!prefs.enabled) return null;
  const suppressed =
    env.terminalVisible && env.windowFocused && env.interactedWithinMs < RECENT_INTERACTION_MS;
  const channels = (kind: TerminalNotificationKind) => ({
    store: kind !== "terminal-done" || !suppressed,
    toast: !env.terminalVisible,
    native: !env.windowFocused && prefs.native,
    sound:
      prefs.sound &&
      ((!env.windowFocused && prefs.native) ||
        (kind === "terminal-attention" && !env.terminalVisible)),
  });

  if (e.type === "commandFinished") {
    if (e.exitCode === EXIT_INTERRUPT) return null;
    if (e.usedAltScreen) return null;
    const failed = e.exitCode != null && e.exitCode !== 0;
    if (failed && prefs.onFailure) {
      return {
        kind: "terminal-failed",
        title: `${e.command} failed (exit ${e.exitCode})`,
        body: where(ctx, e.cwd, env),
        persistMs: DONE_PERSIST_MS,
        channels: channels("terminal-failed"),
        dedupeKey: `${ctx.terminalId}:${e.blockId}:failed`,
      };
    }
    if (!failed && e.durationMs >= prefs.minDurationMs) {
      if (suppressed) return null;
      return {
        kind: "terminal-done",
        title: `${e.command} finished in ${formatDuration(e.durationMs)}`,
        body: where(ctx, e.cwd, env),
        persistMs: DONE_PERSIST_MS,
        channels: channels("terminal-done"),
        dedupeKey: `${ctx.terminalId}:${e.blockId}:done`,
      };
    }
    return null;
  }

  if (e.type === "attention") {
    if (!prefs.onAttention) return null;
    const title =
      e.kind === "password"
        ? `${e.command} needs a password`
        : e.kind === "bell"
          ? `Terminal bell — ${e.command}`
          : e.kind === "notify"
            ? e.title || `${e.command} says`
            : `${e.command} needs input`;
    const body =
      e.kind === "notify" && e.body
        ? e.body
        : `${e.command} in ${where(ctx, "", env) || "terminal"}`;
    return {
      kind: "terminal-attention",
      title,
      body,
      persistMs: ATTENTION_PERSIST_MS,
      channels: channels("terminal-attention"),
      dedupeKey: `${ctx.terminalId}:${e.blockId ?? "x"}:${e.kind}:${e.body ?? ""}`,
    };
  }

  return null;
}
