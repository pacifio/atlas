// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { SharedThreadConflict } from "../lib/shared-threads-api";

// The design system's styling libraries are not what is under test.
vi.mock("@/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
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

import { ConflictList, conflictPlace, sideLabels } from "./conflict-view";

afterEach(cleanup);

const TEXT: SharedThreadConflict = {
  conflictId: 7,
  fileId: 3,
  path: "src/app.ts",
  runId: "run-1",
  status: "open",
  lines: { start: 18, end: 19 },
  binary: false,
  base: "line 19\n",
  canonical: "joy 19\n",
  run: "run 19\n",
  involved: { runs: ["run-1"], people: ["monzim", "joy"] },
  raisedBy: "monzim",
  raisedAt: 1,
  resolution: null,
  runBy: "monzim",
  runAgent: "codex",
  canonicalBy: ["joy"],
  canonicalAgents: [],
  proposed: "joy 19\nrun 19\n",
};

const BINARY: SharedThreadConflict = {
  ...TEXT,
  conflictId: 8,
  path: "logo.png",
  lines: null,
  binary: true,
  base: null,
  canonical: "a".repeat(64),
  run: "b".repeat(64),
  proposed: null,
};

describe("ConflictList", () => {
  it("names the place, and who and which agent stands behind each side", () => {
    expect(conflictPlace(TEXT)).toBe("src/app.ts:19");
    expect(conflictPlace({ ...TEXT, lines: { start: 4, end: 7 } })).toBe("src/app.ts:5–7");
    expect(conflictPlace(BINARY)).toBe("logo.png");
    expect(sideLabels(TEXT)).toEqual({
      canonical: "Now in the thread — joy",
      run: "Run by monzim · codex",
    });
  });

  it("shows only open Conflicts, with the three versions and the proposal", () => {
    render(
      <ConflictList
        conflicts={[TEXT, { ...TEXT, conflictId: 9, status: "resolved" }]}
        mayEdit
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText("1 Conflict to resolve")).toBeTruthy();
    fireEvent.click(screen.getByText("src/app.ts:19"));
    expect(screen.getByText("Run by monzim · codex")).toBeTruthy();
    expect((screen.getByLabelText("Merged result") as HTMLTextAreaElement).value).toBe(
      "joy 19\nrun 19\n",
    );
  });

  it("resolves with each action, an edited result included", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    render(<ConflictList conflicts={[TEXT]} mayEdit onResolve={onResolve} />);
    fireEvent.click(screen.getByText("src/app.ts:19"));
    for (const [label, action] of [
      ["Keep current", { side: "canonical" }],
      ["Take the Run's", { side: "run" }],
      ["Keep both", { side: "both" }],
      ["Ask an agent", { side: "agent" }],
    ] as const) {
      fireEvent.click(screen.getByText(label));
      await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(TEXT, action));
    }
    fireEvent.change(screen.getByLabelText("Merged result"), { target: { value: "ours 19\n" } });
    fireEvent.click(screen.getByText("Use result"));
    await waitFor(() =>
      expect(onResolve).toHaveBeenLastCalledWith(TEXT, { side: "edited", text: "ours 19\n" }),
    );
  });

  it("offers a binary file one side or the other, and a viewer nothing", () => {
    const { unmount } = render(<ConflictList conflicts={[BINARY]} mayEdit onResolve={vi.fn()} />);
    fireEvent.click(screen.getByText("logo.png"));
    expect(screen.getByText("Take the Run's")).toBeTruthy();
    expect(screen.queryByText("Keep both")).toBeNull();
    expect(screen.queryByLabelText("Merged result")).toBeNull();
    unmount();
    render(<ConflictList conflicts={[TEXT]} mayEdit={false} onResolve={vi.fn()} />);
    fireEvent.click(screen.getByText("src/app.ts:19"));
    expect(screen.queryByText("Keep current")).toBeNull();
    expect(screen.getByText(/Only people who can edit/)).toBeTruthy();
  });

  it("shows nothing while there is nothing to resolve", () => {
    const { container } = render(<ConflictList conflicts={[]} mayEdit onResolve={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
