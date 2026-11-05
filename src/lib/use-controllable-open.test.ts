// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useControllableOpen } from "./use-controllable-open";

describe("useControllableOpen", () => {
  it("keeps its own state when the parent passes none", () => {
    const { result } = renderHook(() => useControllableOpen(undefined, undefined));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });

  it("defers to the parent when it owns the state, and reports every request", () => {
    const onOpenChange = vi.fn();
    const { result, rerender } = renderHook(({ open }) => useControllableOpen(open, onOpenChange), {
      initialProps: { open: true },
    });
    act(() => result.current[1](false));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(result.current[0]).toBe(true); // still the parent's word
    rerender({ open: false });
    expect(result.current[0]).toBe(false);
  });
});
