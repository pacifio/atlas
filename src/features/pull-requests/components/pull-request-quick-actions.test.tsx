// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";

const { invoke, toast } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));

import { resetGhGateForTests } from "../lib/pr-errors";
import { INLINE_CONFIRM_GRACE_MS } from "../lib/use-inline-confirm";
import type { PrAction } from "../lib/pull-requests-types";
import {
  PullRequestQuickActions,
  PullRequestQuickActionsProvider,
  sweepRowAtY,
  useCloseBatch,
  useCloseSweep,
  useQuickActionRunner,
  type QuickActionEntry,
} from "./pull-request-quick-actions";

const ALL = new Set<PrAction>(["close", "merge", "ready", "reopen"]);

const open = (number: number): QuickActionEntry => ({
  number,
  title: `Change ${number}`,
  state: "open",
  isDraft: false,
});

function wrap(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function Group({ entry, onActed }: { entry: QuickActionEntry; onActed?: () => void }) {
  const perform = useQuickActionRunner("/repo", onActed);
  return (
    <PullRequestQuickActionsProvider hostActions={ALL} perform={perform}>
      <PullRequestQuickActions entry={entry} />
    </PullRequestQuickActionsProvider>
  );
}

const group = () => screen.getByRole("group", { hidden: true });

beforeEach(() => {
  resetGhGateForTests();
  invoke.mockImplementation(async (name: string) => {
    if (name === "pr_detail") {
      return {
        headSha: "abc123",
        capabilities: { mergeMethods: ["merge", "squash", "rebase"] },
        mergeCapabilities: { merge: false, squash: true, rebase: false },
        viewerPermissions: { actions: ["merge", "close"] },
      };
    }
    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  invoke.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  localStorage.clear();
});

describe("PullRequestQuickActions", () => {
  it("shows only while Shift alone is held", () => {
    render(wrap(<Group entry={open(7)} />));
    expect(group().style.display).toBe("none");
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    expect(group().style.display).toBe("flex");
    fireEvent.keyDown(window, { key: "Meta", shiftKey: true, metaKey: true });
    expect(group().style.display).toBe("none");
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.keyUp(window, { key: "Shift", shiftKey: false });
    expect(group().style.display).toBe("none");
  });

  it("offers Ready on a draft and Reopen when closed", () => {
    const { rerender } = render(wrap(<Group entry={{ ...open(7), isDraft: true }} />));
    expect(screen.getByRole("button", { name: "Ready #7", hidden: true })).toBeTruthy();
    rerender(wrap(<Group entry={{ ...open(7), state: "closed" }} />));
    expect(screen.getByRole("button", { name: "Reopen #7", hidden: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close #7", hidden: true })).toBeNull();
  });

  it("closes on one click", async () => {
    const acted = vi.fn();
    render(wrap(<Group entry={open(7)} onActed={acted} />));
    fireEvent.click(screen.getByRole("button", { name: "Close #7", hidden: true }));
    await waitFor(() => expect(acted).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("pr_action", {
      path: "/repo",
      number: 7,
      input: { action: "close" },
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it("merges only on the second click, with an allowed method and the head it read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<Group entry={open(7)} />));
    fireEvent.click(screen.getByRole("button", { name: "Merge #7", hidden: true }));
    expect(invoke).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirm merge #7", hidden: true });
    // The armed group stays up with Shift released.
    expect(group().style.display).toBe("flex");
    act(() => vi.advanceTimersByTime(INLINE_CONFIRM_GRACE_MS + 10));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pr_action", {
        path: "/repo",
        number: 7,
        input: {
          action: "merge",
          mergeMethod: "squash",
          expectedHeadOid: "abc123",
          // The project setting's default.
          removeAgentCredits: false,
        },
      }),
    );
  });

  it("says why when the merge is refused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invoke.mockImplementation(async (name: string) => {
      if (name === "pr_detail") {
        return {
          headSha: "abc",
          capabilities: { mergeMethods: ["merge"] },
          mergeCapabilities: { merge: true },
          viewerPermissions: { actions: [] },
        };
      }
      return null;
    });
    render(wrap(<Group entry={open(7)} />));
    fireEvent.click(screen.getByRole("button", { name: "Merge #7", hidden: true }));
    act(() => vi.advanceTimersByTime(INLINE_CONFIRM_GRACE_MS + 10));
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge #7", hidden: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(invoke.mock.calls.some(([name]) => name === "pr_action")).toBe(false);
  });
});

describe("the close sweep", () => {
  it("finds the row under the pointer", () => {
    const rows = [
      { key: 1, top: 0 },
      { key: 2, top: 50 },
      { key: 3, top: 100 },
    ];
    expect(sweepRowAtY(rows, 75)).toBe(2);
    expect(sweepRowAtY(rows, -20)).toBe(1);
    expect(sweepRowAtY(rows, 500)).toBe(3);
    expect(sweepRowAtY([], 10)).toBeNull();
  });

  const entries = [open(1), open(2), { ...open(3), state: "closed" as const }, open(4)];

  function Sweep({ onCommit }: { onCommit: (rows: QuickActionEntry[]) => void }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const sweep = useCloseSweep({
      scrollerRef,
      read: () => ({
        ordered: entries.map((e) => e.number),
        rows: new Map(entries.map((e) => [e.number, e])),
      }),
      canSweep: (_origin, row) => row.state === "open",
      onCommit,
    });
    return (
      <div ref={scrollerRef} data-testid="scroller">
        {entries.map((entry) => (
          <div
            key={entry.number}
            data-pull-request-number={entry.number}
            data-swept={sweep.swept.has(entry.number)}
          >
            <button
              type="button"
              onPointerDown={(event) => sweep.start(entry, event.nativeEvent)}
            >{`Close ${entry.number}`}</button>
          </div>
        ))}
      </div>
    );
  }

  /** happy-dom lays nothing out: give each row a top 50px apart. */
  function layOut() {
    const rows = document.querySelectorAll<HTMLElement>("[data-pull-request-number]");
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 50 }) as DOMRect;
    });
    screen.getByTestId("scroller").getBoundingClientRect = () =>
      ({ top: 0, bottom: 400 }) as DOMRect;
  }

  const swept = () =>
    [...document.querySelectorAll<HTMLElement>('[data-swept="true"]')].map((n) =>
      Number(n.dataset.pullRequestNumber),
    );

  it("closes every open row dragged across, skipping the closed one", () => {
    const onCommit = vi.fn();
    render(<Sweep onCommit={onCommit} />);
    layOut();
    fireEvent.pointerDown(screen.getByText("Close 1"), { clientY: 10 });
    fireEvent.pointerMove(document, { clientY: 60 });
    fireEvent.pointerMove(document, { clientY: 160 });
    expect(swept()).toEqual([1, 2, 4]);
    fireEvent.pointerUp(document, { clientY: 160 });
    expect(onCommit).toHaveBeenCalledWith([entries[0], entries[1], entries[3]]);
    expect(swept()).toEqual([]);
  });

  it("is a plain click when the pointer never travels", () => {
    const onCommit = vi.fn();
    render(<Sweep onCommit={onCommit} />);
    layOut();
    fireEvent.pointerDown(screen.getByText("Close 2"), { clientY: 60 });
    fireEvent.pointerMove(document, { clientY: 62 });
    fireEvent.pointerUp(document, { clientY: 62 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const onCommit = vi.fn();
    render(<Sweep onCommit={onCommit} />);
    layOut();
    fireEvent.pointerDown(screen.getByText("Close 1"), { clientY: 10 });
    fireEvent.pointerMove(document, { clientY: 110 });
    expect(swept()).toEqual([1, 2]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(swept()).toEqual([]);
    fireEvent.pointerUp(document, { clientY: 110 });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("useCloseBatch", () => {
  function Batch({ rows }: { rows: QuickActionEntry[] }) {
    const { close, closing } = useCloseBatch("/repo");
    return (
      <button type="button" onClick={() => void close(rows)}>
        {`close all (${closing.size})`}
      </button>
    );
  }

  it("closes the open ones, toasts once, and the toast's Reopen puts them back", async () => {
    render(wrap(<Batch rows={[open(1), open(2), { ...open(3), state: "merged" }]} />));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const closes = invoke.mock.calls.filter(([name]) => name === "pr_action");
    expect(closes.map(([, args]) => args.number).sort()).toEqual([1, 2]);
    const [title, options] = toast.success.mock.calls[0]!;
    expect(title).toBe("Closed 2 pull requests");
    invoke.mockClear();
    options.action.onClick();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls.map(([, args]) => [args.number, args.input.action]).sort()).toEqual([
      [1, "reopen"],
      [2, "reopen"],
    ]);
  });

  it("reports the ones that failed", async () => {
    invoke.mockImplementation(async (_name: string, args: { number: number }) => {
      if (args.number === 2) throw { kind: "failed", message: "Nope" };
      return null;
    });
    render(wrap(<Batch rows={[open(1), open(2)]} />));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0]![0]).toBe("Closed 1 of 2 pull requests");
  });
});
