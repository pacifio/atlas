// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupCommentPillView } from "./group-comment-pill-view";

afterEach(cleanup);

describe("GroupCommentPillView", () => {
  it("renders nothing at zero", () => {
    const { container } = render(<GroupCommentPillView count={0} faces={[]} onOpen={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("caps the count at 9+, names the calls, and opens on click", async () => {
    const onOpen = vi.fn();
    render(<GroupCommentPillView count={12} faces={[]} onOpen={onOpen} />);
    const pill = screen.getByRole("button", { name: "12 comments on these tool calls" });
    expect(pill.textContent).toBe("9+");
    await userEvent.click(pill);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("says comment, singular, for one", () => {
    render(<GroupCommentPillView count={1} faces={[]} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "1 comment on these tool calls" })).toBeTruthy();
  });
});
