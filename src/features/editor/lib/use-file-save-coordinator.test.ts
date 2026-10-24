// @vitest-environment happy-dom
//
// A file tab starts its save session before the file has been read. The
// session must take the text, once it lands, as what "clean" means — not the
// empty string it started with, or undoing back to the file stays dirty and
// clearing the file reads as clean (and ⌘S writes nothing).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFileSaveCoordinator } from "./use-file-save-coordinator";

afterEach(cleanup);

function setup() {
  const persist = vi.fn<(c: string) => Promise<boolean>>().mockResolvedValue(true);
  const onPendingChange = vi.fn();
  const hook = renderHook(
    ({ baseline }: { baseline: string | null }) =>
      useFileSaveCoordinator({
        path: "/repo/a.txt",
        baseline,
        persist,
        onPendingChange,
        onConfirmed: vi.fn(),
      }),
    { initialProps: { baseline: null as string | null } },
  );
  // The read resolves after mount.
  hook.rerender({ baseline: "hello" });
  return { ...hook, persist, onPendingChange };
}

describe("useFileSaveCoordinator, baseline read after mount", () => {
  it("is clean again when edits are undone back to the file as read", () => {
    const { result, onPendingChange } = setup();
    act(() => result.current.change("hello!"));
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    act(() => result.current.change("hello"));
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("treats clearing the file as an edit, and saves it", async () => {
    const { result, onPendingChange, persist } = setup();
    act(() => result.current.change(""));
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    await act(() => result.current.flush());
    expect(persist).toHaveBeenCalledWith("");
  });

  it("ignores later baselines: a save moves it through the session itself", () => {
    const { result, rerender, onPendingChange } = setup();
    act(() => result.current.change("edited"));
    rerender({ baseline: "something else" });
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
  });
});
