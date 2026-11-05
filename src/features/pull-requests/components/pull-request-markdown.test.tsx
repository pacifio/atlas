// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PullRequestMarkdownEditor } from "./pull-request-markdown";

afterEach(cleanup);

function editor(value: string, saving = false) {
  return (
    <PullRequestMarkdownEditor
      value={value}
      label="Pull request description"
      saving={saving}
      allowEmpty
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

const box = () => screen.getByRole("textbox", { name: "Pull request description" });

describe("PullRequestMarkdownEditor", () => {
  it("keeps what is being typed when the body is refetched, and offers the new one", () => {
    const { rerender } = render(editor("Original"));
    fireEvent.change(box(), { target: { value: "Original, and my edit" } });

    // A background refetch brings someone else's change.
    rerender(editor("Edited on GitHub"));
    expect(box()).toHaveProperty("value", "Original, and my edit");
    expect(screen.getByRole("status").textContent).toMatch(/Changed on GitHub/);

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(box()).toHaveProperty("value", "Original, and my edit");

    rerender(editor("Edited again"));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(box()).toHaveProperty("value", "Edited again");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing for a refetch that brings back the same text", () => {
    const { rerender } = render(editor("Same"));
    rerender(editor("Same"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing while its own save lands", () => {
    const { rerender } = render(editor("Before"));
    fireEvent.change(box(), { target: { value: "After" } });
    rerender(editor("After", true));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
