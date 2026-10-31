// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { PullRequestCommentActions, type EditableRemark } from "./pull-request-comment-actions";
import { PullRequestScopeContext } from "./pull-request-context";

const remark = (extra: Partial<EditableRemark> = {}): EditableRemark => ({
  id: "IC_1",
  kind: "issue-comment",
  body: "Original",
  canEdit: true,
  canDelete: true,
  ...extra,
});

function draw(comment: EditableRemark) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PullRequestScopeContext.Provider
        value={{ repoPath: "/repo", number: 7, repositoryUrl: null }}
      >
        <PullRequestCommentActions comment={comment}>
          <p>Original</p>
        </PullRequestCommentActions>
      </PullRequestScopeContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe("PullRequestCommentActions", () => {
  it("offers nothing on a remark the viewer may not change", () => {
    draw(remark({ canEdit: false, canDelete: false }));
    expect(screen.getByText("Original")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never offers to delete a review's summary", () => {
    draw(remark({ kind: "review", canDelete: true }));
    expect(screen.getByRole("button", { name: "Edit review summary" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("deletes only on the second press", async () => {
    invoke.mockResolvedValue(null);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    draw(remark());
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(invoke).not.toHaveBeenCalled();
    now += 2_000;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm delete comment" }));
    });
    expect(invoke).toHaveBeenCalledWith("pr_delete_comment", {
      path: "/repo",
      number: 7,
      commentId: "IC_1",
      kind: "issue-comment",
    });
  });

  it("swaps the body for the editor and back on cancel", () => {
    draw(remark({ canDelete: false }));
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    expect(screen.queryByText("Original", { selector: "p" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Original", { selector: "p" })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
