// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryUpdatedCard } from "./memory-updated-card";
import { useMemoryStore } from "../stores/memory-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

function write(id: number, content: string, op = "insert", state = "active", live = true) {
  return { id, rev: id * 10, op, kind: "decision", content, state, at: id, live };
}

let writes: ReturnType<typeof write>[] = [];

beforeEach(() => {
  writes = [write(2, "Sign JWTs with EdDSA"), write(1, "always force-push", "insert", "candidate")];
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { id?: number }) => {
    if (cmd === "memory_session_writes") return writes;
    // Forgetting writes no revision under this session; only `live` changes.
    if (cmd === "memory_forget_entry") {
      writes = writes.map((w) => (w.id === args.id ? { ...w, live: false } : w));
    }
    return true;
  });
});
afterEach(cleanup);

describe("the Memory updated card", () => {
  it("counts what the session saved and lists it when opened", async () => {
    const user = userEvent.setup();
    render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await user.click(await screen.findByText("Memory updated: 2 saved"));
    expect(screen.getByText("Sign JWTs with EdDSA")).toBeTruthy();
    expect(screen.getByText("always force-push")).toBeTruthy();
    expect(screen.getByText("candidate")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("memory_session_writes", {
      projectPath: "/repo",
      sessionId: "s-a",
      since: 0,
    });
  });

  it("forgets an entry after confirming", async () => {
    const user = userEvent.setup();
    render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await user.click(await screen.findByText("Memory updated: 2 saved"));
    await user.click(screen.getAllByRole("button", { name: "Forget" })[1]);
    const confirms = await screen.findAllByRole("button", { name: "Forget" });
    await user.click(confirms[confirms.length - 1]);
    expect(invoke).toHaveBeenCalledWith("memory_forget_entry", { projectPath: "/repo", id: 1 });
    // Re-read: the forgotten row stays listed, marked, with nothing to forget.
    await screen.findByText("Memory updated: 1 saved, 1 removed");
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(1);
    expect(screen.getByText("removed")).toBeTruthy();
  });

  it("opens a row's entry in Memory ▸ Shared", async () => {
    useMemoryStore.setState({ subTab: "graph", focusEntryId: null });
    const user = userEvent.setup();
    render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await user.click(await screen.findByText("Memory updated: 2 saved"));
    await user.click(screen.getByRole("button", { name: "Sign JWTs with EdDSA" }));
    expect(useMemoryStore.getState().subTab).toBe("shared");
    expect(useMemoryStore.getState().focusEntryId).toBe(2);
    const layout = useLayoutStore.getState();
    // Memory is a destination (ADR-0024): it opens over the columns.
    expect(layout.destinationShown).toBe(true);
    expect(layout.destination?.type).toBe("memory");
  });

  it("offers no Forget on a write whose entry is gone or archived", async () => {
    writes = [write(3, "Use Postgres", "insert", "active", false)];
    const user = userEvent.setup();
    render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await user.click(await screen.findByText("Memory updated: 1 removed"));
    expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
  });

  it("drops the previous session's writes when the session changes", async () => {
    const { rerender } = render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await screen.findByText("Memory updated: 2 saved");
    let answer: (rows: unknown[]) => void = () => {};
    invoke.mockImplementation(
      () => new Promise((resolve) => (answer = resolve as (rows: unknown[]) => void)),
    );
    rerender(<MemoryUpdatedCard projectPath="/repo" sessionId="s-b" />);
    await waitFor(() => expect(screen.queryByText(/Memory updated/)).toBeNull());
    answer([write(4, "Pin Node 22")]);
    expect(await screen.findByText("Memory updated: 1 saved")).toBeTruthy();
  });

  it("renders nothing when the session wrote nothing", async () => {
    writes = [];
    const { container } = render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
  });
});
