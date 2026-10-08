// @vitest-environment happy-dom
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { ChatInput, type ChatInputHandle } from "./chat-input";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

afterEach(cleanup);

describe("ChatInput keyboard shortcuts", () => {
  it.each([true, false])("Alt+Enter inserts at the caret with enterToSend=%s", (enterToSend) => {
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(
      <ChatInput
        ref={ref}
        initialValue="firstsecond"
        enterToSend={enterToSend}
        onSubmit={onSubmit}
        onChange={onChange}
      />,
    );
    const view = ref.current!.view()!;
    act(() => view.dispatch({ selection: { anchor: 5 } }));

    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter", altKey: true });

    expect(ref.current!.getValue()).toBe("first\nsecond");
    expect(view.state.selection.main.head).toBe(6);
    expect(onChange).toHaveBeenLastCalledWith("first\nsecond");
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      undo(view);
    });
    expect(ref.current!.getValue()).toBe("firstsecond");
  });

  it("Alt+Enter replaces a selection without confirming a picker or continuing a list", () => {
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    const keyInterceptor = vi.fn(() => true);
    render(
      <ChatInput
        ref={ref}
        initialValue="- first remove second"
        onSubmit={onSubmit}
        keyInterceptor={keyInterceptor}
      />,
    );
    const view = ref.current!.view()!;
    act(() => view.dispatch({ selection: { anchor: 7, head: 15 } }));

    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter", altKey: true });

    expect(ref.current!.getValue()).toBe("- first\nsecond");
    expect(keyInterceptor).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps Enter submission, Shift+Enter newline and Ctrl+Enter submission", () => {
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    render(<ChatInput ref={ref} initialValue="first" onSubmit={onSubmit} />);
    const view = ref.current!.view()!;

    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(ref.current!.getValue()).toBe("first");

    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter", shiftKey: true });
    expect(ref.current!.getValue()).toBe("first\n");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(ref.current!.getValue()).toBe("first\n");
  });
});
