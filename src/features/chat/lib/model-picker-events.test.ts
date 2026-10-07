// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesAction } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { isMac } from "@/lib/platform";
import { onModelPickerRequest, requestModelPicker } from "./model-picker-events";

describe("model picker requests", () => {
  const unsubscribers: (() => void)[] = [];
  afterEach(() => unsubscribers.splice(0).forEach((off) => off()));

  it("reaches the composer of the addressed tab only", () => {
    const a = vi.fn();
    const b = vi.fn();
    unsubscribers.push(onModelPickerRequest("tab-a", a), onModelPickerRequest("tab-b", b));
    requestModelPicker("tab-a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("stops after unsubscribing", () => {
    const a = vi.fn();
    onModelPickerRequest("tab-a", a)();
    requestModelPicker("tab-a");
    expect(a).not.toHaveBeenCalled();
  });

  it("is asked for by ⌘⇧M, the chat panel's `chat.toggleModelPicker` chord", () => {
    const e = new KeyboardEvent("keydown", {
      key: "M",
      code: "KeyM",
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });
    expect(matchesAction(e, "chat.toggleModelPicker")).toBe(true);
    const plain = new KeyboardEvent("keydown", { key: "m", code: "KeyM" });
    expect(matchesAction(plain, "chat.toggleModelPicker")).toBe(false);
  });
});
