// @vitest-environment happy-dom
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ResponseSelectionActions } from "./response-selection-actions";
import { selectionCommentBody } from "@/features/artifacts/lib/selection-comment";
import { CommentBody } from "@/features/artifacts/components/comment-thread";
import { COMMENT_LINK_EVENT, type CommentLinkDetail } from "../lib/comment-mentions";

const state = vi.hoisted(() => ({
  shared: true,
  post: vi.fn(async () => {}),
}));
const directory = { byId: new Map(), currentUserId: null };
vi.mock("../stores/chat-comments-store", () => ({
  useAnchorHit: () => (state.shared ? { anchorKind: "message", rowId: "cloud-response" } : null),
  useCommentBucket: () => [],
  useCommentActions: () => ({ post: state.post, resolve: async () => {}, remove: async () => {} }),
  useCommentDirectory: () => directory,
  useHasCloudTarget: () => state.shared,
  useChatCommentsStore: {
    getState: () => ({
      actions: {},
      // A shared session's anchors know both rows; one that is not shared has none.
      byTab: state.shared
        ? {
            "chat-a": {
              actions: { post: state.post },
              anchors: {
                rowIdByChatKey: new Map([
                  ["wire-prompt", {}],
                  ["wire-response", {}],
                ]),
              },
            },
          }
        : {},
    }),
  },
}));

function Harness({ enabled = true }: { enabled?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={viewportRef} data-testid="viewport">
        <div data-comment-anchor="wire-prompt">
          <p data-testid="user">User prompt</p>
        </div>
        <div data-agent-response="wire-response" data-comment-anchor="wire-response">
          <p data-testid="prose">Scope it to the usage page.</p>
          <p>
            See the <a href="https://example.test">usage docs</a>.
          </p>
          <pre data-testid="code">{"const onFocus = () => {\n  refreshUsage();\n};"}</pre>
        </div>
        <p data-testid="streaming">Still arriving</p>
      </div>
      <ResponseSelectionActions viewportRef={viewportRef} tabId="chat-a" enabled={enabled} />
      <button>Outside</button>
    </div>
  );
}

function select(testId: string) {
  const node = screen.getByTestId(testId).firstChild!;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

beforeEach(() => {
  state.shared = true;
  state.post.mockReset();
  state.post.mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 600, 400),
  );
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    new DOMRect(30, 60, 200, 20),
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

/** A press and release that did not travel: a click, as the browser fires it. */
function click(node: Element, at = { clientX: 100, clientY: 200 }) {
  fireEvent.pointerDown(node, { button: 0, ...at });
  fireEvent.pointerUp(node, at);
  fireEvent.click(node, at);
}

/** Every chip the cite popover links into a composer, by detail. */
function linked() {
  const details: CommentLinkDetail[] = [];
  // A composer marks the event handled; the popover closes only on that.
  const listener = (e: Event) => {
    details.push((e as CustomEvent<CommentLinkDetail>).detail);
    e.preventDefault();
  };
  window.addEventListener(COMMENT_LINK_EVENT, listener);
  return { details, stop: () => window.removeEventListener(COMMENT_LINK_EVENT, listener) };
}

/** Select `testId`'s text and open Cite's popover; its note field. */
async function openCite(testId = "prose") {
  render(<Harness />);
  select(testId);
  const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
  fireEvent.click(within(toolbar).getByRole("button", { name: "Cite" }));
  return (await screen.findByRole("textbox", {
    name: "Note for the agent",
  })) as HTMLTextAreaElement;
}

describe("selected response actions", () => {
  it("cites a multiline passage with its note as a chip, only into its source session", async () => {
    const links = linked();
    try {
      const note = await openCite("code");
      expect(screen.getByRole("blockquote", { name: "Cited passage" }).textContent).toBe(
        "const onFocus = () => {\n  refreshUsage();\n};",
      );
      fireEvent.change(note, { target: { value: "  Why on focus?  " } });
      fireEvent.keyDown(note, { key: "Enter" });
      await waitFor(() => expect(links.details).toHaveLength(1));
      const [{ tabId, mention }] = links.details;
      expect(tabId).toBe("chat-a");
      expect(mention).toMatchObject({
        kind: "cited_text",
        messageId: "wire-response",
        rowId: "cloud-response",
        text: "const onFocus = () => {\n  refreshUsage();\n};",
        note: "Why on focus?",
      });
      // Private to the agent unless shared: no comment was posted.
      expect(state.post).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull(),
      );
      expect(window.getSelection()?.isCollapsed).toBe(true);
    } finally {
      links.stop();
    }
  });

  it("waits until the pointer is released so the toolbar cannot intercept a multiline drag", async () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("code"));
    select("code");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
    fireEvent.pointerUp(screen.getByTestId("code"));
    await screen.findByRole("group", { name: "Selected response actions" });
  });

  it("does not offer selection actions for streaming text", async () => {
    render(<Harness />);
    select("streaming");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
  });

  it("offers Comment but not Cite on a prompt: a cite points the agent at its own words", async () => {
    render(<Harness />);
    select("user");
    const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Comment"]);
    // Comment opens the Timeline's thread popover off the pill, with a field
    // to write in — not a composer in the transcript.
    fireEvent.click(within(toolbar).getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("textbox")).toBeTruthy();
  });

  it("is Cite alone on a session that cannot be commented on", async () => {
    state.shared = false;
    render(<Harness />);
    select("prose");
    const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
    expect(within(toolbar).queryByRole("button", { name: "Comment" })).toBeNull();
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cite"]);
  });

  it("keeps Comment beside Cite, and Comment opens the thread popover off the pill", async () => {
    render(<Harness />);
    select("prose");
    const toolbar = await screen.findByRole("group", { name: "Selected response actions" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cite", "Comment"]);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("textbox")).toBeTruthy();
    // The pill stays while its popover is open: the popover hangs off it.
    expect(screen.getByRole("group", { name: "Selected response actions" })).toBeTruthy();
  });

  it("supports Tab focus and dismisses on Escape, outside click and panel scroll", async () => {
    render(<Harness />);
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Cite");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
    fireEvent.click(screen.getByText("Outside"));
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.scroll(screen.getByTestId("viewport"));
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
  });

  it("keeps a dismissed selection dismissed until the selection changes", async () => {
    const frame = () =>
      act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    render(<Harness />);
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    // A press on non-selectable chrome leaves the selection in place.
    for (const target of [screen.getByText("Outside"), screen.getByTestId("viewport")]) {
      fireEvent.pointerDown(target);
      fireEvent.pointerUp(target);
      await frame();
      expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
      expect(window.getSelection()?.isCollapsed).toBe(false);
    }
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(screen.getByText("Outside"));
    await frame();
    expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull();
  });

  it("shows nothing for a pointer over prose — only a selection brings the pill", async () => {
    render(<Harness />);
    fireEvent.pointerMove(screen.getByTestId("prose"), { clientX: 100, clientY: 200 });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("starts nothing on a plain click in the prose: comments open in a popover", async () => {
    render(<Harness />);
    click(screen.getByTestId("prose").firstChild as Element);
    click(screen.getByTestId("user"));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("removes selection actions when the panel is hidden or the response disappears", async () => {
    const view = render(<Harness />);
    select("prose");
    await screen.findByRole("group", { name: "Selected response actions" });
    act(() => screen.getByTestId("prose").parentElement!.remove());
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Selected response actions" })).toBeNull(),
    );
    view.rerender(<Harness enabled={false} />);
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("when no composer takes the cite", () => {
  it("stays open with the note and says so", async () => {
    const note = await openCite();
    fireEvent.change(note, { target: { value: "keep me" } });
    fireEvent.keyDown(note, { key: "Enter" });
    await screen.findByText(/composer could not take the cite/);
    expect(note.value).toBe("keep me");
    expect(screen.getByRole("group", { name: "Selected response actions" })).toBeTruthy();
  });

  it("does not post twice when the comment went out but the cite did not", async () => {
    const note = await openCite();
    fireEvent.click(screen.getByRole("switch", { name: "Share with team" }));
    fireEvent.change(note, { target: { value: "Ask the team" } });
    fireEvent.keyDown(note, { key: "Enter" });
    await screen.findByText(/Shared with the team, but/);
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("switch", { name: "Share with team" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("the note field", () => {
  it("ignores Enter while an IME is composing", async () => {
    const links = linked();
    try {
      const note = await openCite();
      fireEvent.change(note, { target: { value: "にほん" } });
      fireEvent.keyDown(note, { key: "Enter", isComposing: true });
      fireEvent.keyDown(note, { key: "Enter", keyCode: 229 });
      expect(links.details).toHaveLength(0);
      fireEvent.keyDown(note, { key: "Enter" });
      await waitFor(() => expect(links.details).toHaveLength(1));
    } finally {
      links.stop();
    }
  });
});

describe("a layout change while the popover is open", () => {
  it("keeps the popover and its note on scroll, resize and window blur", async () => {
    const note = await openCite();
    fireEvent.change(note, { target: { value: "draft" } });
    fireEvent.scroll(screen.getByTestId("viewport"));
    fireEvent(window, new Event("resize"));
    fireEvent(window, new Event("blur"));
    expect(screen.getByRole("textbox", { name: "Note for the agent" })).toBe(note);
    expect(note.value).toBe("draft");
  });
});

describe("sharing a cite with the team", () => {
  it("draws the switch only when the session passes the comment gate", async () => {
    state.shared = false;
    await openCite();
    expect(screen.queryByRole("switch", { name: "Share with team" })).toBeNull();
    cleanup();
    state.shared = true;
    await openCite();
    const toggle = screen.getByRole("switch", { name: "Share with team" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("posts today's passage comment as well as citing, and needs a note to", async () => {
    const links = linked();
    try {
      const note = await openCite();
      fireEvent.click(screen.getByRole("switch", { name: "Share with team" }));
      const submit = screen.getByRole("button", { name: "Cite and share" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(screen.getByText("A shared cite needs a note.")).toBeTruthy();
      fireEvent.change(note, { target: { value: "Should billing refresh too?" } });
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      await waitFor(() => expect(links.details).toHaveLength(1));
      expect(state.post).toHaveBeenCalledWith(
        "message",
        "cloud-response",
        selectionCommentBody("Scope it to the usage page.", "Should billing refresh too?"),
        null,
      );
      expect(links.details[0].mention).toMatchObject({
        kind: "cited_text",
        note: "Should billing refresh too?",
      });
    } finally {
      links.stop();
    }
  });

  it("cites nothing when the comment fails, and keeps the note", async () => {
    state.post.mockRejectedValueOnce(new Error("offline"));
    const links = linked();
    try {
      const note = await openCite();
      fireEvent.click(screen.getByRole("switch", { name: "Share with team" }));
      fireEvent.change(note, { target: { value: "Ask the team" } });
      fireEvent.keyDown(note, { key: "Enter" });
      await screen.findByText("Error: offline");
      expect(links.details).toHaveLength(0);
      expect(note.value).toBe("Ask the team");
    } finally {
      links.stop();
    }
  });
});

describe("passage comments", () => {
  it("renders a saved passage literally and renders actual comment mentions separately", () => {
    const text = "<script>literal</script>\n  <@someone> &lt;";
    render(
      <CommentBody
        text={selectionCommentBody(text, "Ask <@someone> about this")}
        directory={directory}
      />,
    );
    expect(screen.getByRole("blockquote", { name: "Selected passage" }).textContent).toBe(text);
    expect(screen.getByText("@someone")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });
});
