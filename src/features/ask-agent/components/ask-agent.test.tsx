// @vitest-environment happy-dom
//
// The ask box's keys as the field receives them (⌘↵ sends, ⌘⇧↵ drafts, a
// plain Enter stays a newline, nothing fires with nothing to ask), and the two
// buttons opening the one box with what they were given.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useAskAgentStore } from "../stores/ask-agent-store";
import type { ErrorContext } from "../lib/agent-context";
import { AskAgentButton, FixWithAgentButton } from "./ask-agent-button";
import { AskAgentBoxView, type AskAgentBoxViewProps } from "./views/ask-agent-box-view";

afterEach(() => {
  cleanup();
  useAskAgentStore.setState({ request: null });
});

function renderBox(over: Partial<AskAgentBoxViewProps> = {}) {
  const props: AskAgentBoxViewProps = {
    chips: [{ key: "0", kind: "error", label: "git push error", title: "git push" }],
    onRemoveChip: vi.fn(),
    prompt: "Fix this:",
    onPromptChange: vi.fn(),
    targets: [{ value: "new", label: "New session" }],
    target: "new",
    onTargetChange: vi.fn(),
    onSend: vi.fn(),
    onDraft: vi.fn(),
    onCancel: vi.fn(),
    canSubmit: true,
    error: null,
    sendKeys: ["⌘", "↵"],
    draftKeys: ["⌘", "⇧", "↵"],
    ...over,
  };
  render(<AskAgentBoxView {...props} />);
  return { props, field: screen.getByRole("textbox", { name: "Ask the agent" }) };
}

describe("the ask box's keys", () => {
  it("sends on ⌘↵ and drafts on ⌘⇧↵", () => {
    const { props, field } = renderBox();
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(props.onSend).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "Enter", metaKey: true, shiftKey: true });
    expect(props.onDraft).toHaveBeenCalledTimes(1);
  });

  it("leaves a plain Enter to the field and cancels on Esc", () => {
    const { props, field } = renderBox();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("does nothing with nothing to ask", () => {
    const { props, field } = renderBox({ canSubmit: false });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("takes a chip back out", () => {
    const { props } = renderBox();
    fireEvent.click(screen.getByRole("button", { name: "Remove git push error" }));
    expect(props.onRemoveChip).toHaveBeenCalledWith("0");
  });
});

describe("the ways into the box", () => {
  const error: ErrorContext = { kind: "error", source: "git push", message: "rejected" };

  it("Ask opens it with the row's context, anchored to the button", () => {
    render(<AskAgentButton context={[error]} />);
    const button = screen.getByRole("button", { name: "Ask agent" });
    fireEvent.click(button);
    expect(useAskAgentStore.getState().request).toMatchObject({
      context: [error],
      anchor: button,
    });
  });

  it("Fix with agent pre-fills the prompt, and closes a modal first", () => {
    const dismiss = vi.fn();
    render(<FixWithAgentButton error={error} dismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Fix with agent/ }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    const request = useAskAgentStore.getState().request;
    expect(request).toMatchObject({ context: [error], prompt: "Fix this: " });
    // The button is going away with the modal: the box grows from its rect.
    expect(request?.anchor).not.toBeInstanceOf(Element);
  });
});
