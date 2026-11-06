// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { INLINE_CONFIRM_GRACE_MS, useInlineConfirm } from "./use-inline-confirm";

let clock = 0;
const now = () => clock;

function Merge({ onConfirm }: { onConfirm: () => void }) {
  const confirm = useInlineConfirm("pr", now);
  return (
    <button type="button" {...confirm.props("merge", onConfirm)}>
      {confirm.isArmed("merge") ? "Confirm merge?" : "Merge"}
    </button>
  );
}

afterEach(() => {
  cleanup();
  clock = 0;
});

describe("useInlineConfirm", () => {
  it("arms on the first press and runs on a second, later one", () => {
    const onConfirm = vi.fn();
    render(<Merge onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("Confirm merge?");
    clock += INLINE_CONFIRM_GRACE_MS + 1;
    fireEvent.click(screen.getByRole("button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not confirm on a press right after arming", () => {
    const onConfirm = vi.fn();
    render(<Merge onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button"));
    clock += 50;
    fireEvent.click(screen.getByRole("button"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button").textContent).toBe("Confirm merge?");
  });

  it("swallows a held Enter's repeats", () => {
    render(<Merge onConfirm={vi.fn()} />);
    const button = screen.getByRole("button");
    const first = fireEvent.keyDown(button, { key: "Enter" });
    const repeat = fireEvent.keyDown(button, { key: "Enter", repeat: true });
    // `fireEvent` returns false when the handler prevented the default,
    // which is what stops the browser activating the button again.
    expect(first).toBe(true);
    expect(repeat).toBe(false);
  });
});
