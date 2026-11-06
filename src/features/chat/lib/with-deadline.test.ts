import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeadlineError,
  describeMs,
  isDeadlineError,
  withDeadline,
  progressSince,
} from "./with-deadline";

describe("withDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes a value through when the hop settles in time", async () => {
    const p = withDeadline(Promise.resolve(42), 1000, "x");
    await expect(p).resolves.toBe(42);
  });

  it("passes the hop's own rejection through untouched", async () => {
    const boom = { message: "spawn failed", kind: "spawn" };
    const p = withDeadline(Promise.reject(boom), 1000, "x");
    await expect(p).rejects.toBe(boom);
  });

  it("rejects with a tagged DeadlineError naming the hop once the deadline passes", async () => {
    const never = new Promise<void>(() => {});
    const p = withDeadline(never, 180_000, "Codex has not answered `session/new`");
    const settled = p.then(
      () => "resolved",
      (e: unknown) => e,
    );
    vi.advanceTimersByTime(179_999);
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    const err = await settled;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(isDeadlineError(err)).toBe(true);
    expect((err as DeadlineError).code).toBe("bind-timeout");
    expect((err as DeadlineError).message).toBe(
      "Codex has not answered `session/new` in 3 minutes",
    );
  });

  it("does not fire the deadline after the hop settled", async () => {
    let resolve!: (v: number) => void;
    const hop = new Promise<number>((r) => (resolve = r));
    const p = withDeadline(hop, 1000, "x");
    resolve(7);
    await expect(p).resolves.toBe(7);
    // Advancing past the deadline must not surface an unhandled rejection.
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms while the hop reports progress, and rejects once it stops", async () => {
    const never = new Promise<void>(() => {});
    let working = true;
    const settled = withDeadline(never, 1000, "x", () => working).then(
      () => "resolved",
      (e: unknown) => e,
    );
    vi.advanceTimersByTime(3500);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    working = false;
    vi.advanceTimersByTime(1000);
    expect(isDeadlineError(await settled)).toBe(true);
  });

  it("isDeadlineError rejects ordinary errors and backend rejections", () => {
    expect(isDeadlineError(new Error("nope"))).toBe(false);
    expect(isDeadlineError({ message: "x", kind: "auth" })).toBe(false);
    expect(isDeadlineError(null)).toBe(false);
  });

  it("describeMs reads naturally", () => {
    expect(describeMs(180_000)).toBe("3 minutes");
    expect(describeMs(60_000)).toBe("1 minute");
    expect(describeMs(30_000)).toBe("30 seconds");
  });
});

describe("progressSince", () => {
  it("is progress only while the status keeps changing", () => {
    let status: string | undefined = "Installing codex… ";
    const moving = progressSince(() => status);
    // Same string as when armed: nothing moved.
    expect(moving()).toBe(false);
    status = "Installing codex… 20s";
    expect(moving()).toBe(true);
    // Unchanged since the last ask: a wedged install, not a slow one.
    expect(moving()).toBe(false);
    status = "Installing codex… 40s";
    expect(moving()).toBe(true);
  });

  it("a status that appears after arming counts as movement, one that clears does not", () => {
    let status: string | undefined;
    const moving = progressSince(() => status);
    expect(moving()).toBe(false);
    status = "Downloading Node.js…";
    expect(moving()).toBe(true);
    status = undefined;
    expect(moving()).toBe(false);
  });

  it("lets withDeadline re-arm on movement and fire once it stops", async () => {
    vi.useFakeTimers();
    let status: string | undefined = "Installing…";
    const never = new Promise<never>(() => {});
    const guarded = withDeadline(
      never,
      1000,
      "x",
      progressSince(() => status),
    );
    const outcome = vi.fn();
    guarded.catch(outcome);

    status = "Installing… 20s";
    await vi.advanceTimersByTimeAsync(1000); // moved → re-armed
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); // unchanged → fires
    expect(outcome).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
