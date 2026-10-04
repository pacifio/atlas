// @vitest-environment happy-dom
//
// ADR-0001 amendment, Rule 7: a session another process is still writing must
// not be sent to from Atlas until the user says so, or the two writers fork the
// transcript. The contract is the banner, the held send (Enter AND the button),
// and that "Send anyway" lets it through.
//
// The CodeMirror input is replaced by a textarea behind the same handle: the
// guard lives in `MessageInput.submit`, not in the editor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

vi.mock("./chat-input", async () => {
  const React = await import("react");
  const ChatInput = React.forwardRef<
    { getValue(): string; setValue(t: string): void; clear(): void; getMentions(): never[] },
    { onChange?: (v: string) => void; onSubmit?: () => void }
  >(function FakeChatInput({ onChange, onSubmit }, ref) {
    const el = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => el.current?.focus(),
      blur: () => el.current?.blur(),
      getValue: () => el.current?.value ?? "",
      setValue: (t: string) => {
        if (el.current) el.current.value = t;
      },
      clear: () => {
        if (el.current) el.current.value = "";
      },
      getMentions: () => [],
      insertMention: () => {},
      view: () => null,
    }));
    return (
      <textarea
        aria-label="Message"
        ref={el}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
    );
  });
  return { ChatInput };
});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useChatStore } from "../stores/chat-store";
import { useLiveElsewhereStore } from "../stores/live-elsewhere-store";
import { MessageInput } from "./message-input";

const TAB = "tab-1";
const SESSION = "sess-live";

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useChatStore.setState((s) => {
    s.sessions[TAB].acpSessionId = SESSION;
  });
  useLiveElsewhereStore.setState({ live: {}, overridden: {} });
});
afterEach(cleanup);

async function mount() {
  const onSend = vi.fn();
  render(<MessageInput tabId={TAB} onSend={onSend} />);
  const input = await screen.findByLabelText("Message");
  return { onSend, input };
}

describe("composer guard for a session running in a terminal", () => {
  it("shows no banner and sends normally while the session is not live", async () => {
    const { onSend, input } = await mount();
    expect(screen.queryByTestId("live-elsewhere-bar")).toBeNull();
    await userEvent.type(input, "hello{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("holds Enter and the send button until Send anyway, then lets the send through", async () => {
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    const { onSend, input } = await mount();

    const bar = screen.getByTestId("live-elsewhere-bar");
    expect(bar.textContent).toContain(
      "This session is still running in a terminal. Sending here will fork it.",
    );

    await userEvent.type(input, "hello{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    // The send button is disabled too, so a click cannot slip past the held Enter.
    const sendButton = document.querySelector<HTMLButtonElement>('button[class*="top-[8px]"]');
    expect(sendButton?.disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(screen.queryByTestId("live-elsewhere-bar")).toBeNull();

    // The text typed while held is still in the composer.
    expect((input as HTMLTextAreaElement).value).toBe("hello");
    await userEvent.type(input, "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("hello");
  });

  it("clears the banner by itself when the session stops being live", async () => {
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    await mount();
    expect(screen.getByTestId("live-elsewhere-bar")).toBeTruthy();

    useLiveElsewhereStore.getState().actions.setLive([]);
    await waitFor(() => expect(screen.queryByTestId("live-elsewhere-bar")).toBeNull());
  });
});
