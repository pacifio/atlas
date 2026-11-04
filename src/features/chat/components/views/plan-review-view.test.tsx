// @vitest-environment happy-dom
//
// The plan review's own behaviour: where focus lands when it opens, when
// Atlas's "bypass permissions" action appears, and that Cancel and Esc both
// cancel. The keys that pick an option live in the container's window handler
// (`permission-modal.keys.test.tsx`).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanReviewView } from "./plan-review-view";
import type { PermissionOptionItem } from "./permission-card-view";

const OPTIONS: PermissionOptionItem[] = [
  {
    optionId: "exit-plan-default",
    label: "Yes, and auto-accept edits",
    tone: "allow",
    isPrimary: true,
  },
  {
    optionId: "exit-plan-accept-edits",
    label: "Yes, and ask before edits",
    tone: "allow",
    isPrimary: false,
  },
  { optionId: "reject_once", label: "No, keep planning", tone: "reject", isPrimary: false },
];

function renderReview(bypassOptionId: string | null = null) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  render(
    <PlanReviewView
      plan={<pre>the plan</pre>}
      options={OPTIONS}
      bypassOptionId={bypassOptionId}
      queueNote={null}
      onSelect={onSelect}
      onCancel={onCancel}
    />,
  );
  return { onSelect, onCancel };
}

afterEach(cleanup);

describe("PlanReviewView", () => {
  // An allow never holds default focus (ADR-0014): the review opens on
  // Cancel, not on the first option.
  it("opens with focus on Cancel", async () => {
    renderReview();
    const cancel = screen.getByText("Cancel").closest("button");
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it("lists every option in order, with its digit", () => {
    renderReview();
    const rows = screen.getByTestId("plan-review").querySelectorAll("button");
    const labels = [...rows].map((b) => b.textContent);
    expect(labels.slice(0, 3)).toEqual([
      "1Yes, and auto-accept edits↵",
      "2Yes, and ask before edits",
      "3No, keep planning",
    ]);
  });

  it("offers bypass only when the container names an option for it", () => {
    renderReview();
    expect(screen.queryByText("Yes, and bypass permissions")).toBeNull();
    cleanup();
    const { onSelect } = renderReview("exit-plan-default");
    fireEvent.click(screen.getByText("Yes, and bypass permissions"));
    expect(onSelect).toHaveBeenCalledWith("exit-plan-default", "bypassPermissions");
  });

  it("answers an option by click", () => {
    const { onSelect } = renderReview();
    fireEvent.click(screen.getByText("No, keep planning"));
    expect(onSelect).toHaveBeenCalledWith("reject_once");
  });

  it("cancels from the Cancel button and from Esc", async () => {
    const { onCancel } = renderReview();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2));
  });
});
