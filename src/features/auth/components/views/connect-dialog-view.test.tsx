// @vitest-environment happy-dom
//
// The connect dialog's copy button and its exits.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectDialogView } from "./connect-dialog-view";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CODE = { userCode: "WDJB-MJHT", verificationUri: "https://tryatlas.dev/device" };

function mount(props: Partial<Parameters<typeof ConnectDialogView>[0]> = {}) {
  const handlers = {
    onOpenChange: vi.fn(),
    onCopy: vi.fn(async () => true),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <ConnectDialogView
      open
      done={false}
      error={null}
      code={CODE}
      starting={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("ConnectDialogView", () => {
  it("says Copied after a copy, then reverts after 2s", async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy code/ }));
    });
    expect(screen.getByRole("button", { name: /Copied/ })).toBeTruthy();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: /Copy code/ })).toBeTruthy();
  });

  it("keeps Copy code when the copy is refused", async () => {
    mount({ onCopy: vi.fn(async () => false) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy code/ }));
    });
    expect(screen.getByRole("button", { name: /Copy code/ })).toBeTruthy();
  });

  it("Cancel cancels while waiting", () => {
    const { onCancel } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("Close closes once connected", () => {
    const { onClose } = mount({ done: true });
    expect(screen.getByText("Connected.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("an error offers Try again", () => {
    const { onRetry } = mount({ error: "The code expired." });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
