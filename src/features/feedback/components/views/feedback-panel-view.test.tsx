// @vitest-environment happy-dom
//
// The feedback panel's keyboard and category rules, against the view alone:
// ⌘↵ sends only a non-empty message, the categories never empty, and the
// arrow keys select (not just focus) the next category, wrapping.

import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackPanelView, type FeedbackPanelViewProps } from "./feedback-panel-view";

const CATEGORIES = [
  { id: "issue", label: "Issue", placeholder: "What broke?" },
  { id: "idea", label: "Idea", placeholder: "What would you like?" },
  { id: "other", label: "Other", placeholder: "Anything." },
];

function renderView(over: Partial<FeedbackPanelViewProps> = {}) {
  const props: FeedbackPanelViewProps = {
    categories: CATEGORIES,
    capturing: false,
    category: "issue",
    message: "",
    shot: null,
    anonymous: false,
    submitting: false,
    sent: false,
    error: null,
    identity: null,
    telemetryOff: false,
    textareaRef: createRef(),
    onClose: vi.fn(),
    onCategory: vi.fn(),
    onMessage: vi.fn(),
    onAttach: vi.fn(),
    onRemoveShot: vi.fn(),
    onToggleAnonymous: vi.fn(),
    onSubmit: vi.fn(),
    onSendAnother: vi.fn(),
    onOpenIssue: vi.fn(),
    onOpenCommunity: vi.fn(),
    ...over,
  };
  render(<FeedbackPanelView {...props} />);
  return props;
}

beforeEach(cleanup);

describe("FeedbackPanelView", () => {
  it("sends on ⌘↵ only with a message", () => {
    const empty = renderView();
    fireEvent.keyDown(screen.getByLabelText("Your feedback"), { key: "Enter", metaKey: true });
    expect(empty.onSubmit).not.toHaveBeenCalled();
    cleanup();

    const typed = renderView({ message: "It broke" });
    fireEvent.keyDown(screen.getByLabelText("Your feedback"), { key: "Enter", metaKey: true });
    expect(typed.onSubmit).toHaveBeenCalledOnce();
  });

  it("disables Send with an empty or blank message", () => {
    renderView({ message: "   " });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("selects a clicked category, and never reports an empty one", () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Idea" }));
    expect(props.onCategory).toHaveBeenCalledWith("idea");
    fireEvent.click(screen.getByRole("button", { name: "Issue" }));
    expect(props.onCategory).not.toHaveBeenCalledWith(undefined);
    expect(props.onCategory).toHaveBeenCalledTimes(1);
  });

  it("selects the adjacent category with the arrow keys, wrapping", () => {
    const props = renderView();
    const group = screen.getByRole("group", { name: "Feedback category" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(props.onCategory).toHaveBeenLastCalledWith("other");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(props.onCategory).toHaveBeenLastCalledWith("idea");
  });
});
