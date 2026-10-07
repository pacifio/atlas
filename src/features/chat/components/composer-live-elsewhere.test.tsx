// @vitest-environment happy-dom
//
// ADR-0001 amendment, Rule 7: a session another process is still writing must
// not be sent to from Atlas until the user says so, or the two writers fork the
// transcript. The contract is the banner, the held send (Enter AND the button),
// that "Send anyway" lets it through, and that the composer learns liveness
// itself — from the whole history store, not from whichever sidebar happened to
// list the session — so a session opened from History or another project is
// guarded too.
//
// The CodeMirror input is replaced by a textarea behind the same handle: the
// guard lives in `MessageInput.submit`, not in the editor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  /** Rows `threads_history` answers with. */
  rows: [] as Array<Record<string, unknown>>,
  historyCalls: 0,
  /** Live `atlas:threads-changed` handlers. */
  changed: new Set<() => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "threads_history") {
      backend.historyCalls += 1;
      return backend.rows;
    }
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event !== "atlas:threads-changed") return () => {};
    backend.changed.add(handler);
    return () => backend.changed.delete(handler);
  }),
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

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChatStore } from "../stores/chat-store";
import { useLiveElsewhereStore } from "../stores/live-elsewhere-store";
import { MessageInput } from "./message-input";

const TAB = "tab-1";
const SESSION = "sess-live";

function row(sessionId: string, liveElsewhere: boolean, extra: Record<string, unknown> = {}) {
  return {
    threadId: `th-${sessionId}`,
    sessionId,
    agentId: "claude-code",
    title: sessionId,
    updatedAt: "2026-10-05T00:00:00Z",
    createdAt: null,
    archived: false,
    projectName: "atlas",
    folderPaths: ["/p/atlas"],
    liveElsewhere,
    ...extra,
  };
}

/** The backend's liveness moved; it says so with the change event. */
function backendSays(rows: Array<Record<string, unknown>>) {
  backend.rows = rows;
  act(() => {
    for (const handler of backend.changed) handler();
  });
}

function openTab(tabId: string, sessionId: string) {
  useChatStore.getState().actions.createSession(tabId, "claude-code");
  useChatStore.setState((s) => {
    s.sessions[tabId].acpSessionId = sessionId;
  });
}

let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  backend.rows = [];
  backend.historyCalls = 0;
  backend.changed.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  openTab(TAB, SESSION);
  useLiveElsewhereStore.setState({ live: {}, overridden: {} });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

async function mount(tabs: string[] = [TAB]) {
  const onSend = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      {tabs.map((tabId) => (
        <div key={tabId} data-testid={`composer-${tabId}`}>
          <MessageInput tabId={tabId} onSend={onSend} />
        </div>
      ))}
    </QueryClientProvider>,
  );
  const input = (await screen.findAllByLabelText("Message"))[0];
  return { onSend, input };
}

const sendButton = () => screen.getByRole("button", { name: "Send message" });
const bar = () => screen.queryByTestId("live-elsewhere-bar");

describe("composer guard for a session another process is writing", () => {
  it("shows no banner and sends normally while the session is not live", async () => {
    backend.rows = [row(SESSION, false)];
    const { onSend, input } = await mount();
    await waitFor(() => expect(backend.historyCalls).toBe(1));
    expect(bar()).toBeNull();
    await userEvent.type(input, "hello{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("holds Enter and the send button until Send anyway, then lets the send through", async () => {
    backend.rows = [row(SESSION, true)];
    const { onSend, input } = await mount();

    await waitFor(() => expect(bar()).not.toBeNull());
    expect(bar()?.textContent).toContain(
      "This session is active in another process (likely a terminal). Sending here will fork it.",
    );

    await userEvent.type(input, "hello{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    // The send button is disabled too, so a click cannot slip past the held Enter.
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(bar()).toBeNull();

    // The text typed while held is still in the composer.
    expect((input as HTMLTextAreaElement).value).toBe("hello");
    await userEvent.type(input, "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("hello");
  });

  it("clears the banner by itself when the session stops being live", async () => {
    backend.rows = [row(SESSION, true)];
    await mount();
    await waitFor(() => expect(bar()).not.toBeNull());

    backendSays([row(SESSION, false)]);
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("guards a session no sidebar lists: archived, from another project", async () => {
    // Opened from the History view: archived and in a project that is not
    // open, so the open project's sidebar never had a row for it.
    backend.rows = [
      row("someone-else", false),
      row(SESSION, true, { archived: true, projectName: "other", folderPaths: ["/p/other"] }),
    ];
    const { onSend, input } = await mount();
    await waitFor(() => expect(bar()).not.toBeNull());
    await userEvent.type(input, "hi{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("several composers share one feed and do not clobber each other", async () => {
    openTab("tab-2", "sess-quiet");
    backend.rows = [row(SESSION, true), row("sess-quiet", false)];
    await mount([TAB, "tab-2"]);

    await waitFor(() =>
      expect(
        screen.getByTestId(`composer-${TAB}`).querySelector("[data-testid=live-elsewhere-bar]"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("composer-tab-2").querySelector("[data-testid=live-elsewhere-bar]"),
    ).toBeNull();
    // One query for both composers, and one change listener between them.
    expect(backend.historyCalls).toBe(1);
    expect(backend.changed.size).toBe(1);

    // A change event refreshes both from the one source, once.
    backendSays([row(SESSION, false), row("sess-quiet", true)]);
    await waitFor(() =>
      expect(
        screen.getByTestId("composer-tab-2").querySelector("[data-testid=live-elsewhere-bar]"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId(`composer-${TAB}`).querySelector("[data-testid=live-elsewhere-bar]"),
    ).toBeNull();
    expect(backend.historyCalls).toBe(2);
  });
});
