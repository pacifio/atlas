// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { LineComment } from "../lib/shared-threads-api";

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

const { LineCommentList, NewLineComment, commentedLines, linesLabel, threadsOf } = await import("./line-comments");

const RANGE = { threadId: "thr_1", fileId: 1, path: "src/site.css", start: "AAEEAA==", end: "AAENQQ==", quote: "  color: blue;\n" };

function comment(over: Partial<LineComment>): LineComment {
  return {
    id: "c1",
    parentId: null,
    authorId: "joy",
    body: "Is blue right?",
    createdAt: "2026-10-04T00:00:00Z",
    resolvedAt: null,
    resolvedBy: null,
    votes: { up: [], down: [] },
    threadRange: RANGE,
    lines: { start: 4, end: 4 },
    ...over,
  };
}

const nameOf = (id: string) => ({ joy: "Joy", monzim: "Monzim" })[id] ?? id;
const noop = () => Promise.resolve();

afterEach(cleanup);

describe("placing a file's discussions", () => {
  it("orders them by line, outdated last, and marks only open ones in the editor", () => {
    const placed = comment({ id: "a", lines: { start: 9, end: 10 } });
    const early = comment({ id: "b", lines: { start: 2, end: 2 } });
    const gone = comment({ id: "c", lines: null });
    const done = comment({ id: "d", resolvedAt: "2026-10-04T01:00:00Z", lines: { start: 5, end: 5 } });
    const other = comment({ id: "e", threadRange: { ...RANGE, fileId: 2 } });
    const reply = comment({ id: "r", parentId: "a", threadRange: null, lines: null, body: "Pink" });
    const all = [placed, early, gone, done, other, reply];
    expect(threadsOf(all, 1).map((t) => t.root.id)).toEqual(["b", "d", "a", "c"]);
    expect(threadsOf(all, 1).find((t) => t.root.id === "a")!.replies.map((r) => r.id)).toEqual(["r"]);
    expect(commentedLines(all, 1)).toEqual([
      { start: 2, end: 2 },
      { start: 9, end: 10 },
    ]);
    expect(linesLabel({ start: 3, end: 3 })).toBe("Line 3");
    expect(linesLabel({ start: 3, end: 5 })).toBe("Lines 3–5");
  });
});

describe("LineCommentList", () => {
  it("shows an outdated comment with the lines it was written on", () => {
    render(
      <LineCommentList
        threads={threadsOf([comment({ lines: null })])}
        me="monzim"
        nameOf={nameOf}
        canWrite
        onReply={noop}
        onResolve={noop}
        onVote={noop}
      />,
    );
    expect(screen.getByText("Outdated")).toBeTruthy();
    expect(screen.getByText("color: blue;", { exact: false })).toBeTruthy();
  });

  it("replies, resolves and votes through the comment doors", async () => {
    const onReply = vi.fn(noop);
    const onResolve = vi.fn(noop);
    const onVote = vi.fn(noop);
    render(
      <LineCommentList
        threads={threadsOf([comment({ votes: { up: ["monzim"], down: [] } })])}
        me="monzim"
        nameOf={nameOf}
        canWrite
        onReply={onReply}
        onResolve={onResolve}
        onVote={onVote}
      />,
    );
    expect(screen.getByText("Line 4")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: " Pink " } });
    fireEvent.submit(screen.getByLabelText("Reply").closest("form")!);
    expect(onReply).toHaveBeenCalledWith("c1", "Pink");
    fireEvent.click(screen.getByLabelText("Resolve"));
    expect(onResolve).toHaveBeenCalledWith("c1", true);
    // A vote already given is taken back.
    fireEvent.click(screen.getByLabelText("Vote up"));
    expect(onVote).toHaveBeenCalledWith("c1", 0);
    fireEvent.click(screen.getByLabelText("Vote down"));
    expect(onVote).toHaveBeenLastCalledWith("c1", -1);
    await waitFor(() => expect((screen.getByLabelText("Reply") as HTMLTextAreaElement).value).toBe(""));
  });
});

describe("NewLineComment", () => {
  it("posts the body for the chosen lines and closes", async () => {
    const onSubmit = vi.fn(noop);
    const onCancel = vi.fn();
    render(<NewLineComment path="src/site.css" lines={{ start: 2, end: 3 }} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText(/lines 2–3 of/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "why teal?" } });
    fireEvent.submit(screen.getByLabelText("Comment").closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("why teal?");
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });
});
