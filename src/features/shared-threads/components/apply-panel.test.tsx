// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The design system's styling library is not what is under test.
vi.mock("@/ui/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));

const applyThread = vi.fn();
vi.mock("../lib/shared-threads-api", () => ({
  applyThread: (...args: unknown[]) => applyThread(...args),
  sharedThreadError: (e: unknown) => ({ code: "x", message: String(e) }),
}));

import { ApplyPanel } from "./apply-panel";

afterEach(() => {
  cleanup();
  applyThread.mockReset();
});

describe("ApplyPanel", () => {
  it("is blocked while Conflicts are open, pointing at them", () => {
    render(<ApplyPanel sharedThreadId="t1" hasCheckout openConflicts={2} />);
    expect((screen.getByText("Apply to my checkout").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Resolve 2 open Conflicts first")).toBeTruthy();
  });

  it("lists the files uncommitted edits block, and stashes then applies on request", async () => {
    applyThread
      .mockImplementationOnce(() => Promise.resolve({ outcome: "dirty", files: ["src/app.ts"] }))
      .mockImplementationOnce(() =>
        Promise.resolve({
          outcome: "applied",
          files: ["src/app.ts", "notes.md"],
          conflicted: [],
          beside: [],
          setAside: [],
          stashed: "atlas: your edits, set aside to apply a Shared Thread",
        }),
      );
    render(<ApplyPanel sharedThreadId="t1" hasCheckout openConflicts={0} />);
    fireEvent.click(screen.getByText("Apply to my checkout"));
    await waitFor(() => expect(screen.getByText("src/app.ts")).toBeTruthy());
    expect(applyThread).toHaveBeenLastCalledWith("t1", false);
    fireEvent.click(screen.getByText("Stash and apply"));
    await waitFor(() =>
      expect(screen.getByText(/Applied 2 files as uncommitted changes/)).toBeTruthy(),
    );
    expect(applyThread).toHaveBeenLastCalledWith("t1", true);
    expect(screen.getByText(/stashed as/)).toBeTruthy();
  });

  it("names the files left with conflict markers", async () => {
    applyThread.mockImplementationOnce(() =>
      Promise.resolve({
        outcome: "applied",
        files: ["a.ts"],
        conflicted: ["util.ts"],
        beside: ["logo.png.atlas-thread"],
        setAside: ["/repo/.git/atlas-set-aside/1/local/settings.json"],
        stashed: null,
      }),
    );
    render(<ApplyPanel sharedThreadId="t1" hasCheckout openConflicts={0} />);
    fireEvent.click(screen.getByText("Apply to my checkout"));
    await waitFor(() => expect(screen.getByText("util.ts")).toBeTruthy());
    expect(screen.getByText(/conflict markers/)).toBeTruthy();
    expect(screen.getByText("logo.png.atlas-thread")).toBeTruthy();
    expect(screen.getByText("/repo/.git/atlas-set-aside/1/local/settings.json")).toBeTruthy();
  });

  it("says where Apply writes when this machine joined without a checkout", () => {
    render(<ApplyPanel sharedThreadId="t1" hasCheckout={false} openConflicts={0} />);
    expect(screen.queryByText("Apply to my checkout")).toBeNull();
    expect(screen.getByText(/join from one/)).toBeTruthy();
  });
});
