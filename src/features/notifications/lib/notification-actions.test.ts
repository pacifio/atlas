import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasNotificationAction,
  registerNotificationAction,
  runNotificationAction,
} from "./notification-actions";

const target = { type: "git-panel" as const, projectId: "p1" };
const cleanups: (() => void)[] = [];
const register = (...args: Parameters<typeof registerNotificationAction>) =>
  cleanups.push(registerNotificationAction(...args));

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

describe("notification actions", () => {
  it("runs the registered handler with the notification's context", async () => {
    const handler = vi.fn();
    register("git.choose-pull", handler);
    await runNotificationAction("git.choose-pull", { target, dedupeKey: "k" });
    expect(handler).toHaveBeenCalledWith({ target, dedupeKey: "k" });
  });

  it("falls back to open for an id nobody registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const open = vi.fn();
    register("open", open);
    await runNotificationAction("missing", { target });
    expect(open).toHaveBeenCalledWith({ target });
    expect(warn).toHaveBeenCalled();
  });

  it("never rejects: a throwing or rejecting handler is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    register("throws", () => {
      throw new Error("sync");
    });
    register("rejects", () => Promise.reject(new Error("async")));
    await expect(runNotificationAction("throws", { target })).resolves.toBeUndefined();
    await expect(runNotificationAction("rejects", { target })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("unregisters only its own handler (a re-registration survives an old cleanup)", () => {
    const first = registerNotificationAction("x", vi.fn());
    const second = registerNotificationAction("x", vi.fn());
    first();
    expect(hasNotificationAction("x")).toBe(true);
    second();
    expect(hasNotificationAction("x")).toBe(false);
  });

  it("checks stillApplies first, and opens the target instead when it no longer does", async () => {
    const open = vi.fn();
    const act = vi.fn();
    register("open", open);
    let applies = true;
    register("git.choose-pull", act, { stillApplies: () => applies });
    await runNotificationAction("git.choose-pull", { target });
    expect(act).toHaveBeenCalledTimes(1);
    applies = false;
    await runNotificationAction("git.choose-pull", { target });
    expect(act).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ target });
  });

  it("treats a check that throws or rejects as no longer applying", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const open = vi.fn();
    const act = vi.fn();
    register("open", open);
    register("throws", act, {
      stillApplies: () => {
        throw new Error("x");
      },
    });
    register("rejects", act, { stillApplies: () => Promise.reject(new Error("y")) });
    await runNotificationAction("throws", { target });
    await runNotificationAction("rejects", { target });
    expect(act).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
