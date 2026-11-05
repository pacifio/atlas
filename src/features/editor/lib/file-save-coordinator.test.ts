import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSaveCoordinator } from "./file-save-coordinator";

function deferred() {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator, saving on its own", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<boolean>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(true);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(true);
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.lastCall).toEqual([false]);
  });

  it("saves an edit made inside the debounce window when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<boolean>>().mockResolvedValue(true);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved");
  });

  it.each([false, true])(
    "keeps an edit pending after write permission is removed (closing=%s)",
    async (closeEditor) => {
      vi.useFakeTimers();
      let canWrite = true;
      const persist = vi.fn().mockResolvedValue(true);
      const onPendingChange = vi.fn();
      const coordinator = new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: vi.fn(),
      });

      coordinator.change("unsaved");
      canWrite = false;
      if (closeEditor) coordinator.dispose();
      await vi.runAllTimersAsync();

      expect(persist).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith(true);
    },
  );

  it("flushes an edit made while a write was in flight when the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<boolean>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(true);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    coordinator.dispose();
    inFlight.resolve(true);
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("retries a failed write when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi.fn().mockRejectedValue(new Error("write failed")),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores editor changes emitted after disposal", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<boolean>>().mockResolvedValue(true);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.dispose();
    coordinator.change("stale contents");
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });
});

describe("FileSaveCoordinator, saving on request", () => {
  const manual = (persist: (c: string) => Promise<boolean>) => {
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: null,
      persist,
      onPendingChange,
      onConfirmed,
    });
    coordinator.reset("on disk");
    onPendingChange.mockClear();
    return { coordinator, onPendingChange, onConfirmed };
  };

  it("only marks an edit pending, and writes it on flush", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(true);
    const { coordinator, onPendingChange } = manual(persist);
    coordinator.change("edited");
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);

    await expect(coordinator.flush()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledWith("edited");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
  });

  it("reports pending once per transition, not per keystroke", () => {
    const { coordinator, onPendingChange } = manual(vi.fn());
    coordinator.change("a");
    coordinator.change("ab");
    coordinator.change("abc");
    expect(onPendingChange).toHaveBeenCalledTimes(1);
  });

  it("is clean again when the edits are undone back to what is on disk", () => {
    const { coordinator, onPendingChange } = manual(vi.fn());
    coordinator.change("on disk!");
    coordinator.change("on disk");
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(coordinator.isPending).toBe(false);
  });

  it("never writes on close", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const { coordinator } = manual(persist);
    coordinator.change("edited");
    coordinator.dispose();
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
  });

  it("stays pending when an edit lands during the write, until saved again", async () => {
    const write = deferred();
    const persist = vi
      .fn<(c: string) => Promise<boolean>>()
      .mockReturnValueOnce(write.promise)
      .mockResolvedValue(true);
    const { coordinator } = manual(persist);
    coordinator.change("first");
    const saved = coordinator.flush();
    coordinator.change("second");
    write.resolve(true);
    await expect(saved).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(coordinator.isPending).toBe(true);

    await coordinator.flush();
    expect(persist).toHaveBeenLastCalledWith("second");
    expect(coordinator.isPending).toBe(false);
  });

  it("is clean once the write lands when edits during it were undone to its exact bytes", async () => {
    const write = deferred();
    const persist = vi.fn<(c: string) => Promise<boolean>>().mockReturnValueOnce(write.promise);
    const { coordinator, onPendingChange } = manual(persist);
    coordinator.change("written");
    const saved = coordinator.flush();
    coordinator.change("written, then more");
    coordinator.change("written");
    write.resolve(true);
    await expect(saved).resolves.toBe(true);

    expect(coordinator.isPending).toBe(false);
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    // And nothing is left to write.
    await expect(coordinator.flush()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("writes the newer contents when saved again while a write is in flight", async () => {
    const write = deferred();
    const persist = vi
      .fn<(c: string) => Promise<boolean>>()
      .mockReturnValueOnce(write.promise)
      .mockResolvedValue(true);
    const { coordinator } = manual(persist);
    coordinator.change("first");
    void coordinator.flush();
    coordinator.change("second");
    const second = coordinator.flush();
    write.resolve(true);
    await expect(second).resolves.toBe(true);
    expect(persist.mock.calls).toEqual([["first"], ["second"]]);
    expect(coordinator.isPending).toBe(false);
  });

  it("forgets pending edits when the document is replaced from disk", () => {
    const { coordinator, onPendingChange } = manual(vi.fn());
    coordinator.change("edited");
    coordinator.reset("new on disk");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(coordinator.isPending).toBe(false);
  });
});
