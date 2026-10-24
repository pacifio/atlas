// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { DraftCommentCard } from "./pull-request-review-thread";

afterEach(cleanup);

describe("DraftCommentCard", () => {
  it("posts once for a double click on Comment now", async () => {
    let settle: () => void = () => undefined;
    const onPostNow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    // The card is drawn once, as the diff viewer draws an annotation: no
    // re-render from above will tell it a post is in flight.
    render(
      <DraftCommentCard
        label="src/a.ts:3"
        onAddToReview={vi.fn()}
        onPostNow={onPostNow}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Looks off" } });
    const post = screen.getByRole("button", { name: "Comment now" });
    fireEvent.click(post);
    fireEvent.click(post);
    expect(onPostNow).toHaveBeenCalledTimes(1);
    expect(onPostNow).toHaveBeenCalledWith("Looks off");
    expect(screen.getByRole("button", { name: "Posting…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add to review" })).toHaveProperty("disabled", true);

    // A failed post unlocks it for another try.
    await act(async () => settle());
    expect(screen.getByRole("button", { name: "Comment now" })).toHaveProperty("disabled", false);
  });

  it("restores what was typed and reports each change", () => {
    const onTextChange = vi.fn();
    render(
      <DraftCommentCard
        label="src/a.ts:3"
        initialText="Half a thought"
        onTextChange={onTextChange}
        onAddToReview={vi.fn()}
        onPostNow={vi.fn(async () => undefined)}
        onCancel={vi.fn()}
      />,
    );
    const box = screen.getByRole("textbox");
    expect(box).toHaveProperty("value", "Half a thought");
    fireEvent.change(box, { target: { value: "Half a thought, finished" } });
    expect(onTextChange).toHaveBeenCalledWith("Half a thought, finished");
  });
});
