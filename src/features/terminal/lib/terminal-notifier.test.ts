import { describe, expect, it } from "vitest";
import { decideTerminalNotification, type TerminalCtx } from "./terminal-notifier-rules";
import {
  AWAY_IDLE_MS,
  computeAway,
  type NotificationEnv,
} from "@/features/notifications/lib/decide";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import type { TerminalEvent } from "./shell-integration";

const ctx: TerminalCtx = {
  terminalId: "pty-1",
  tabId: "terminal",
  projectId: "ws-a",
  projectName: "atlas",
  orgId: "org-1",
};
// The terminal's historic defaults: sound off (the tier defaults have it on).
const prefs: AppSettings = {
  ...DEFAULT_SETTINGS,
  notifyNeedsYouSound: false,
  notifyOutcomeSound: false,
};
const away: NotificationEnv = {
  targetVisible: false,
  windowFocused: false,
  sinceInputMs: 999_999,
  projectActive: true,
  away: true,
};
const looking: NotificationEnv = {
  targetVisible: true,
  windowFocused: true,
  sinceInputMs: 1_000,
  projectActive: true,
  away: false,
};

const finished = (over: Partial<Extract<TerminalEvent, { type: "commandFinished" }>> = {}) =>
  ({
    type: "commandFinished",
    blockId: 7,
    command: "npm test",
    cwd: "/Users/adib/Desktop/atlas",
    exitCode: 0,
    startedAt: 0,
    endedAt: 12_000,
    durationMs: 12_000,
    usedAltScreen: false,
    ...over,
  }) satisfies TerminalEvent;

describe("decideTerminalNotification", () => {
  it("is silent when disabled", () => {
    expect(
      decideTerminalNotification(finished(), ctx, away, { ...prefs, notificationsEnabled: false }),
    ).toBeNull();
  });

  it("announces a long successful command", () => {
    const d = decideTerminalNotification(finished(), ctx, away, prefs);
    expect(d?.kind).toBe("terminal-done");
    expect(d?.title).toBe("npm test finished in 12s");
    expect(d?.channels).toEqual({
      center: true,
      toast: true,
      native: true,
      badge: true,
      sound: false,
    });
    expect(d?.native).toEqual({ title: "Atlas: atlas", body: "npm test finished in 12s — atlas" });
  });

  it("stays quiet for a short successful command", () => {
    expect(
      decideTerminalNotification(finished({ durationMs: 3_000 }), ctx, away, prefs),
    ).toBeNull();
  });

  it("announces failures regardless of duration, and records them even when looking", () => {
    const d = decideTerminalNotification(
      finished({ exitCode: 1, durationMs: 200 }),
      ctx,
      looking,
      prefs,
    );
    expect(d?.kind).toBe("terminal-failed");
    expect(d?.channels.center).toBe(true);
    expect(d?.channels.toast).toBe(false);
    expect(d?.channels.native).toBe(false);
  });

  it("treats Ctrl-C as the user's decision", () => {
    expect(decideTerminalNotification(finished({ exitCode: 130 }), ctx, away, prefs)).toBeNull();
  });

  it("never calls a TUI session a long command", () => {
    expect(
      decideTerminalNotification(finished({ usedAltScreen: true }), ctx, away, prefs),
    ).toBeNull();
  });

  it("suppresses success while the user is looking at the terminal", () => {
    expect(decideTerminalNotification(finished(), ctx, looking, prefs)).toBeNull();
  });

  it("names the project only when it is not the active one", () => {
    const active = decideTerminalNotification(finished(), ctx, away, prefs);
    const other = decideTerminalNotification(
      finished(),
      ctx,
      { ...away, projectActive: false },
      prefs,
    );
    expect(active?.body).toBe("atlas");
    expect(other?.body).toBe("atlas — atlas");
  });

  it("attention persists longer and respects the attention toggle", () => {
    const e: TerminalEvent = {
      type: "attention",
      kind: "password",
      blockId: 7,
      command: "sudo true",
    };
    const d = decideTerminalNotification(e, ctx, away, prefs);
    expect(d?.kind).toBe("terminal-attention");
    expect(d?.toast.durationMs).toBe(15_000);
    expect(
      decideTerminalNotification(e, ctx, away, {
        ...prefs,
        notifyDisabledKinds: ["terminal-attention"],
      }),
    ).toBeNull();
  });

  it("chimes in-app for attention when the terminal is off screen and the window is focused", () => {
    const e: TerminalEvent = { type: "attention", kind: "bell", blockId: 7, command: "make" };
    const d = decideTerminalNotification(
      e,
      ctx,
      { ...looking, targetVisible: false },
      { ...prefs, notifyNeedsYouSound: true },
    );
    expect(d?.channels.sound).toBe(true);
    expect(d?.channels.native).toBe(false);
  });

  it("raises the OS banner when focused but idle for 2 minutes (away)", () => {
    const idle: NotificationEnv = {
      ...looking,
      targetVisible: false,
      sinceInputMs: AWAY_IDLE_MS,
      away: computeAway(true, AWAY_IDLE_MS),
    };
    const d = decideTerminalNotification(finished(), ctx, idle, prefs);
    expect(d?.channels.native).toBe(true);
  });

  it("an OS banner carries the system sound instead of the in-app chime", () => {
    const d = decideTerminalNotification(finished({ exitCode: 1 }), ctx, away, {
      ...prefs,
      notifyOutcomeSound: true,
    });
    expect(d?.channels.native).toBe(true);
    expect(d?.native.sound).toBe("Ping");
  });

  it("respects the failure toggle", () => {
    expect(
      decideTerminalNotification(finished({ exitCode: 1 }), ctx, away, {
        ...prefs,
        notifyDisabledKinds: ["terminal-failed"],
      }),
    ).toBeNull();
  });

  it("dedupe keys are stable per block and kind", () => {
    const a = decideTerminalNotification(finished({ exitCode: 1 }), ctx, away, prefs);
    const b = decideTerminalNotification(finished({ exitCode: 1 }), ctx, away, prefs);
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });
});
