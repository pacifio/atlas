// @vitest-environment happy-dom
//
// Editing a queued message puts it back in the composer. The queue holds
// strings, so a large paste sits in it inlined (`withPastesInline`); the edit
// must bring it back as its paste chip, not as every line it holds, which
// would skip the large-paste limit and make the editor lay all of it out.
// This drives the real composer through `MessageInput`'s queue chip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";

import { useChatStore } from "../stores/chat-store";
import { pastedTextMention } from "../lib/pasted-text";
import { citedTextMention } from "../lib/cited-text";
import { resetMentionRegistryForTests } from "../lib/mention-registry";
import { MessageInput } from "./message-input";

const TAB = "tab-q";
const big = Array.from({ length: 150 }, (_, i) => `log line ${i}`).join("\n");

let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  resetMentionRegistryForTests();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("editing a queued message", () => {
  it("brings an inlined paste back as its chip", async () => {
    const paste = pastedTextMention(big);
    useChatStore.getState().actions.enqueueMessage(TAB, `summarise @paste:${paste.id}`, [paste]);
    expect(useChatStore.getState().queues[TAB]?.[0]).toContain("log line 149");

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MessageInput tabId={TAB} onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    // The composer loads lazily.
    const pm = await waitFor(() => {
      const el = container.querySelector(".ProseMirror") as
        | (HTMLElement & { editor: Editor })
        | null;
      expect(el).not.toBeNull();
      return el!;
    });
    act(() => {
      fireEvent.click(screen.getByTitle("Edit / merge into input"));
    });

    await waitFor(() =>
      expect(container.querySelector('[data-mention-kind="pasted_text"]')).not.toBeNull(),
    );
    // The editor holds the prose and one chip, not the paste's lines.
    expect(pm.editor.state.doc.childCount).toBe(1);
    expect(pm.textContent).not.toContain("log line");
    expect(useChatStore.getState().queues[TAB]).toBeUndefined();
  });

  it("brings an inlined cite back as its chip, after a paste", async () => {
    const paste = pastedTextMention(big);
    const cite = citedTextMention({
      text: "Scope it to the usage page.",
      note: "Billing too?",
      messageId: "msg-7",
      rowId: "am-42",
    });
    useChatStore
      .getState()
      .actions.enqueueMessage(TAB, `why @cite:${cite.id} @paste:${paste.id}`, [cite, paste]);
    // The queued string carries the passage and the note, not just the token.
    const queued = useChatStore.getState().queues[TAB]?.[0] ?? "";
    expect(queued).toContain("Scope it to the usage page.");
    expect(queued).toContain("Billing too?");

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MessageInput tabId={TAB} onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    const pm = await waitFor(() => {
      const el = container.querySelector(".ProseMirror") as
        | (HTMLElement & { editor: Editor })
        | null;
      expect(el).not.toBeNull();
      return el!;
    });
    act(() => {
      fireEvent.click(screen.getByTitle("Edit / merge into input"));
    });

    await waitFor(() =>
      expect(container.querySelector('[data-mention-kind="cited_text"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-mention-kind="pasted_text"]')).not.toBeNull();
    expect(pm.editor.state.doc.childCount).toBe(1);
    expect(pm.textContent).not.toContain("Billing too?");
  });
});
