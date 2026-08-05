// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TerminalStopControl } from "./terminal-stop-control";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TerminalStopControl", () => {
  it("stays hidden without an active process", () => {
    render(
      <TerminalStopControl
        active={false}
        onInterrupt={vi.fn()}
        onForceStop={vi.fn()}
        onForceStopped={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("interrupts first, then offers force stop after the grace period", () => {
    vi.useFakeTimers();
    const onInterrupt = vi.fn();
    render(
      <TerminalStopControl
        active
        onInterrupt={onInterrupt}
        onForceStop={vi.fn()}
        onForceStopped={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stop process (Ctrl+C)" }),
    );
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Waiting for process to stop" }),
    ).toBeDisabled();

    act(() => vi.advanceTimersByTime(1500));
    expect(
      screen.getByRole("button", { name: "Force stop process" }),
    ).toBeEnabled();
  });

  it("runs post-kill cleanup only when a foreground process was killed", async () => {
    vi.useFakeTimers();
    const onForceStop = vi.fn().mockResolvedValue(true);
    const onForceStopped = vi.fn();
    render(
      <TerminalStopControl
        active
        onInterrupt={vi.fn()}
        onForceStop={onForceStop}
        onForceStopped={onForceStopped}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stop process (Ctrl+C)" }),
    );
    act(() => vi.advanceTimersByTime(1500));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Force stop process" }),
      );
    });

    expect(onForceStop).toHaveBeenCalledOnce();
    expect(onForceStopped).toHaveBeenCalledOnce();
  });

  it("resets when the process exits during the interrupt grace period", () => {
    vi.useFakeTimers();
    const props = {
      onInterrupt: vi.fn(),
      onForceStop: vi.fn(),
      onForceStopped: vi.fn(),
    };
    const { rerender } = render(<TerminalStopControl active {...props} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Stop process (Ctrl+C)" }),
    );
    rerender(<TerminalStopControl active={false} {...props} />);
    act(() => vi.advanceTimersByTime(1500));

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(props.onForceStop).not.toHaveBeenCalled();
  });
});
