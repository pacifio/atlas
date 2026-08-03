import { describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { safeUnlisten, safeUnlistenPromise } from "./safe-unlisten";

/**
 * `UnlistenFn` is declared `() => void` but Tauri implements it as an async
 * function. The casts below reproduce that mismatch on purpose — it is the
 * whole reason these helpers exist.
 */
function unlistenReturning(value: unknown): UnlistenFn {
  return (() => value) as unknown as UnlistenFn;
}

/** Collects unhandled rejections raised while `run` settles. */
async function unhandledRejectionsDuring(run: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const capture = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", capture);
  try {
    run();
    // Two macrotask turns: one for the microtask queue to drain, one for
    // Node's unhandled-rejection checkpoint to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", capture);
  }
  return seen;
}

describe("safeUnlisten", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("does nothing when given %s", (_label, input) => {
    expect(() => safeUnlisten(input)).not.toThrow();
  });

  it("calls the unlisten function exactly once", () => {
    const un = vi.fn();
    safeUnlisten(un as unknown as UnlistenFn);
    expect(un).toHaveBeenCalledTimes(1);
  });

  it("swallows a synchronous throw", () => {
    // The listener entry was already removed; there is nothing left to undo.
    const un = (() => {
      throw new TypeError("undefined is not an object (evaluating '.handlerId')");
    }) as unknown as UnlistenFn;
    expect(() => safeUnlisten(un)).not.toThrow();
  });

  it("swallows a rejected promise instead of leaking an unhandled rejection", async () => {
    // The bug this helper exists for: fast mount/unmount churn makes Tauri's
    // generated unlisten script reject, and the caller has no `.catch`.
    const seen = await unhandledRejectionsDuring(() => {
      safeUnlisten(unlistenReturning(Promise.reject(new Error("already removed"))));
    });
    expect(seen).toEqual([]);
  });

  it("detects a leak when the helper is bypassed", async () => {
    // Control for the assertion above. Without it, a harness that never
    // observes unhandled rejections would report a permanent, meaningless
    // pass. The rejection is neutralised afterwards so it cannot escape into
    // the rest of the run; the `rejectionHandled` listener is what stops Node
    // printing a PromiseRejectionHandledWarning when that late catch lands.
    const quiet = () => {};
    process.on("rejectionHandled", quiet);
    try {
      const escaping = Promise.reject(new Error("unguarded"));
      const seen = await unhandledRejectionsDuring(() => {
        void escaping;
      });
      expect(seen).toHaveLength(1);
      escaping.catch(quiet);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("rejectionHandled", quiet);
    }
  });

  it.each([
    ["undefined", undefined],
    ["a plain object with no catch", { handlerId: 1 }],
    ["a number", 42],
  ])("tolerates an unlisten that returns %s", async (_label, value) => {
    expect(() => safeUnlisten(unlistenReturning(value))).not.toThrow();
  });
});

describe("safeUnlistenPromise", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("does nothing when given %s", (_label, input) => {
    expect(() => safeUnlistenPromise(input)).not.toThrow();
  });

  it("unlistens once the listen() promise resolves", async () => {
    const un = vi.fn();
    safeUnlistenPromise(Promise.resolve(un as unknown as UnlistenFn));
    await vi.waitFor(() => expect(un).toHaveBeenCalledTimes(1));
  });

  it("swallows a listen() that never resolved", async () => {
    // Unmounting before `listen(...)` settles is routine in split view.
    const seen = await unhandledRejectionsDuring(() => {
      safeUnlistenPromise(Promise.reject(new Error("listen failed")));
    });
    expect(seen).toEqual([]);
  });

  it("swallows a rejection from the resolved unlisten function", async () => {
    const seen = await unhandledRejectionsDuring(() => {
      safeUnlistenPromise(
        Promise.resolve(unlistenReturning(Promise.reject(new Error("already removed")))),
      );
    });
    expect(seen).toEqual([]);
  });
});
