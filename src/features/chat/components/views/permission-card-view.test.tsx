// @vitest-environment happy-dom
//
// The inline permission card as a view: every option drawn in wire order with
// its digit, ↵ only on the primary, the free-text field's Enter and
// Shift+Enter, and no focus taken from the composer when the card appears.
// The keys that pick options are the container's (`permission-modal.keys`).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PermissionCardView, type PermissionOptionItem } from "./permission-card-view";

const OPTIONS: PermissionOptionItem[] = [
  { optionId: "allow_once", label: "Yes", tone: "allow", isPrimary: true },
  { optionId: "allow_always", label: "Yes, always", tone: "allow", isPrimary: false },
  { optionId: "reject_once", label: "No", tone: "reject", isPrimary: false },
];

function renderCard(
  over: Partial<Parameters<typeof PermissionCardView>[0]> = {},
): Record<string, ReturnType<typeof vi.fn>> {
  const onSelect = vi.fn();
  const onSubmitDraft = vi.fn();
  const onDraftChange = vi.fn();
  render(
    <PermissionCardView
      heading={{ kind: "tool", title: "rm -rf dist" }}
      preview={'{\n  "command": "rm -rf dist"\n}'}
      options={OPTIONS}
      queueNote={null}
      draft="do this instead"
      onDraftChange={onDraftChange}
      onSubmitDraft={onSubmitDraft}
      draftRef={createRef()}
      onSelect={onSelect}
      {...over}
    />,
  );
  return { onSelect, onSubmitDraft, onDraftChange };
}

afterEach(cleanup);

describe("PermissionCardView", () => {
  it("draws every option in wire order, numbered, with ↵ on the primary only", () => {
    renderCard();
    const rows = [...screen.getByTestId("permission-card").querySelectorAll("button")];
    expect(rows.map((b) => b.textContent)).toEqual(["1Yes↵", "2Yes, always", "3No"]);
  });

  it("draws no ↵ when nothing is primary (an outward card)", () => {
    renderCard({
      heading: {
        kind: "outward",
        approval: { title: "Send a message", recipient: "#general", body: "hi" },
      },
      options: OPTIONS.map((o) => ({ ...o, isPrimary: false })),
    });
    expect(screen.queryByText("↵")).toBeNull();
    expect(screen.getByTestId("outward-body").textContent).toBe("hi");
  });

  it("answers an option by click", () => {
    const { onSelect } = renderCard();
    fireEvent.click(screen.getByText("No"));
    expect(onSelect).toHaveBeenCalledWith("reject_once");
  });

  it("submits the free text on Enter, not on Shift+Enter", () => {
    const { onSubmitDraft } = renderCard();
    const field = screen.getByPlaceholderText("Tell the agent what to do instead…");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSubmitDraft).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmitDraft).toHaveBeenCalledTimes(1);
  });

  it("takes no focus when it appears", () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    renderCard();
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });
});
