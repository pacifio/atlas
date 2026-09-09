import { describe, expect, it } from "vitest";
import {
  decideTerminalNotification,
  type NotifierEnv,
  type TerminalCtx,
} from "./terminal-notifier-rules";
import type { TerminalNotificationPrefs } from "@/features/settings/lib/app-settings";
import type { TerminalEvent } from "./block-parser";

const ctx: TerminalCtx = {
  terminalId: "pty-1",
  tabId: "terminal",
  workspaceId: "ws-a",
  workspaceName: "atlas",
  orgId: "org-1",
};
const prefs: TerminalNotificationPrefs = {
  enabled: true,
  minDurationMs: 10_000,
  onFailure: true,
  onAttention: true,
  native: true,
  sound: false,
};
const away: NotifierEnv = {
  terminalVisible: false,
  windowFocused: false,
  interactedWithinMs: 999_999,
  workspaceActive: true,
};
const looking: NotifierEnv = {
  terminalVisible: true,
  windowFocused: true,
  interactedWithinMs: 1_000,
  workspaceActive: true,
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
      decideTerminalNotification(finished(), ctx, away, { ...prefs, enabled: false }),
    ).toBeNull();
  });

  it("announces a long successful command", () => {
    const d = decideTerminalNotification(finished(), ctx, away, prefs);
    expect(d?.kind).toBe("terminal-done");
    expect(d?.title).toBe("npm test finished in 12s");
    expect(d?.channels).toEqual({ store: true, toast: true, native: true, sound: false });
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
    expect(d?.channels.store).toBe(true);
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

  it("names the workspace only when it is not the active one", () => {
    const active = decideTerminalNotification(finished(), ctx, away, prefs);
    const other = decideTerminalNotification(
      finished(),
      ctx,
      { ...away, workspaceActive: false },
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
    expect(d?.persistMs).toBe(15_000);
    expect(decideTerminalNotification(e, ctx, away, { ...prefs, onAttention: false })).toBeNull();
  });

  it("chimes in-app for attention when the terminal is off screen and the window is focused", () => {
    const e: TerminalEvent = { type: "attention", kind: "bell", blockId: 7, command: "make" };
    const d = decideTerminalNotification(
      e,
      ctx,
      { ...looking, terminalVisible: false },
      { ...prefs, sound: true },
    );
    expect(d?.channels.sound).toBe(true);
    expect(d?.channels.native).toBe(false);
  });

  it("dedupe keys are stable per block and kind", () => {
    const a = decideTerminalNotification(finished({ exitCode: 1 }), ctx, away, prefs);
    const b = decideTerminalNotification(finished({ exitCode: 1 }), ctx, away, prefs);
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });
});
