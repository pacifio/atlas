// @vitest-environment happy-dom
//
// The remove-agent confirm: Keep holds focus when it opens, and every way out
// that is not the Remove button — Keep, Esc, a click on the backdrop — means
// Keep. The ask/settle promise itself is `remove-agent-confirm.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoveAgentDialogView } from "./remove-agent-dialog-view";

function renderDialog() {
  const onKeep = vi.fn();
  const onRemove = vi.fn();
  render(<RemoveAgentDialogView open name="Amp" onKeep={onKeep} onRemove={onRemove} />);
  return { onKeep, onRemove };
}

afterEach(cleanup);

describe("RemoveAgentDialogView", () => {
  it("names the agent and opens with focus on Keep", async () => {
    renderDialog();
    expect(screen.getByText("Remove Amp?")).toBeTruthy();
    const keep = screen.getByRole("button", { name: "Keep" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
  });

  it("Remove removes, and only Remove", () => {
    const { onKeep, onRemove } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("Keep keeps", () => {
    const { onKeep, onRemove } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("Esc keeps", async () => {
    const { onKeep, onRemove } = renderDialog();
    const keep = screen.getByRole("button", { name: "Keep" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.keyDown(keep, { key: "Escape" });
    expect(onKeep).toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("a click on the backdrop keeps", () => {
    const { onKeep, onRemove } = renderDialog();
    const backdrop = document.querySelector('[data-slot="alert-dialog-backdrop-close"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onKeep).toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
