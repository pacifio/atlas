// @vitest-environment happy-dom
/**
 * Editing your own comment in place: what opens, what is sent, and where the
 * keyboard goes when the edit ends.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrgMember } from "@/features/auth/lib/auth-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { COMMENT_BODY_MAX, type Comment } from "../lib/comments-api";
import { selectionCommentBody } from "../lib/selection-comment";
import { CommentButton, type CommentActions } from "./comment-thread";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(cleanup);

const member = (userId: string, name: string): OrgMember => ({
  id: `mem_${userId}`,
  userId,
  name,
  email: `${userId}@acme.dev`,
  role: "developer",
  createdAt: null,
  avatarPath: null,
  isOwner: false,
});

const directory: OrgDirectory = {
  byId: new Map([
    ["u_me", member("u_me", "Ada Lovelace")],
    ["u_grace", member("u_grace", "Grace Hopper")],
  ]),
  currentUserId: "u_me",
};

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    sessionId: "s1",
    anchorKind: "entry",
    anchorId: "row-1",
    parentId: null,
    authorId: "u_me",
    guestName: null,
    body: "ask <@u_grace> about @retry",
    mentions: ["u_grace"],
    createdAt: "2026-09-20T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

function open(comments: Comment[], edit: CommentActions["edit"]) {
  const actions: CommentActions = {
    post: async () => {},
    resolve: async () => {},
    remove: async () => {},
    edit,
  };
  render(
    <CommentButton
      anchorKind="entry"
      anchorId="row-1"
      comments={comments}
      actions={actions}
      directory={directory}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Comment/ }));
}

const field = () => screen.getByRole("textbox", { name: "Edit comment" }) as HTMLTextAreaElement;

describe("editing a comment", () => {
  it("keeps the selected passage literal while editing only the comment and its mentions", async () => {
    const edit = vi.fn(async () => {});
    const selection = "  ask <@u_grace> & keep indentation\n\nsecond line";
    open([comment({ body: selectionCommentBody(selection, "ask <@u_grace> about @retry") })], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));

    expect(field().value).toBe("ask @Grace Hopper about @retry");
    expect(screen.getByRole("blockquote", { name: "Selected passage" }).textContent).toBe(
      selection,
    );
    fireEvent.change(field(), { target: { value: "ask @Grace Hopper about the retry" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(edit).toHaveBeenCalledWith(
      "c1",
      selectionCommentBody(selection, "ask <@u_grace> about the retry"),
    );
  });

  it("does not rewrite an unchanged passage comment", async () => {
    const edit = vi.fn(async () => {});
    open([comment({ body: selectionCommentBody("<@u_grace>", "thanks @Grace Hopper") })], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it("counts the preserved passage toward the edit body limit, including Enter submissions", async () => {
    const edit = vi.fn(async () => {});
    const selection = "A long selected passage";
    const prefixLength = selectionCommentBody(selection, "").length;
    open([comment({ body: selectionCommentBody(selection, "original") })], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(field(), {
      target: { value: "x".repeat(COMMENT_BODY_MAX - prefixLength + 1) },
    });
    expect(
      (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it("opens with mentions as names, and saves them back as tokens", async () => {
    const edit = vi.fn(async () => {});
    open([comment()], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));

    expect(field().value).toBe("ask @Grace Hopper about @retry");
    fireEvent.change(field(), { target: { value: "ask @Grace Hopper about the retry" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(edit).toHaveBeenCalledWith("c1", "ask <@u_grace> about the retry");
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
  });

  it("sends nothing when the text was not changed", async () => {
    // A plain "@Name" typed before it was a mention would re-encode into one:
    // that must not turn an untouched save into an edit.
    const edit = vi.fn(async () => {});
    open([comment({ body: "thanks @Grace Hopper", mentions: [] })], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it("leaves Enter to an input method that is still composing", async () => {
    const edit = vi.fn(async () => {});
    open([comment()], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(field(), { target: { value: "にほん" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
      fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    });
    expect(edit).not.toHaveBeenCalled();
    expect(field()).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("Escape leaves the edit and hands focus back to the pencil", () => {
    const edit = vi.fn(async () => {});
    open([comment()], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.keyDown(field(), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
    expect(edit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit comment" }));
  });

  it("keeps the text and says why when the server refuses", async () => {
    const edit = vi.fn(async () => {
      throw "Comment not found";
    });
    open([comment()], edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(field(), { target: { value: "changed" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(field().value).toBe("changed");
    expect(screen.getByText("Comment not found")).toBeTruthy();
  });

  it("is offered only on your own comments", () => {
    open([comment({ authorId: "u_grace" })], vi.fn());
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();
  });
});

/**
 * `openSignal` — the all-comments panel asking one thread to open after it has
 * jumped the reader to the entry the remark is hung off.
 */
describe("opening a thread from elsewhere", () => {
  const actions: CommentActions = {
    post: async () => {},
    resolve: async () => {},
    remove: async () => {},
    edit: async () => {},
  };

  const button = (signal?: number) => (
    <CommentButton
      anchorKind="entry"
      anchorId="row-1"
      comments={[comment()]}
      actions={actions}
      directory={directory}
      openSignal={signal}
    />
  );

  // The trigger's own state, not the presence of the popup: Base UI keeps a
  // closing popup mounted until its exit animation ends, and no animation ever
  // ends under happy-dom.
  const isOpen = () =>
    screen.getByRole("button", { name: /Comment/ }).getAttribute("aria-expanded") === "true";

  const close = () => fireEvent.click(screen.getByRole("button", { name: /Comment/ }));

  it("opens when asked, and again when asked a second time", () => {
    const { rerender } = render(button());
    expect(isOpen()).toBe(false);

    rerender(button(1));
    expect(isOpen()).toBe(true);

    close();
    expect(isOpen()).toBe(false);

    // The same thread, asked for again: a boolean would already have been
    // `true` here and this second click would have done nothing.
    rerender(button(2));
    expect(isOpen()).toBe(true);
  });

  it("stays shut on a re-render that carries the same request", () => {
    const { rerender } = render(button(1));
    close();
    expect(isOpen()).toBe(false);

    rerender(button(1));
    expect(isOpen()).toBe(false);
  });

  // The popup is portalled and gets its first focus before it is positioned —
  // in the real window it was still thousands of pixels below the fold. A
  // focus that scrolled to it scrolled the document itself (`overflow: hidden`
  // stops the user, not script), and the whole app slid out of the window
  // until something scrolled it back.
  it("moves focus into the thread without scrolling anything to reach it", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      render(button(1));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit comment" })).toBe(document.activeElement),
      );
      const scrolling = focus.mock.calls.filter(([options]) => !options?.preventScroll);
      expect(scrolling).toEqual([]);
    } finally {
      focus.mockRestore();
    }
  });

  it("opens straight away for a row that mounts after the request was made", () => {
    // The jump grows the render window, so the row the remark belongs to is
    // often not on screen when the panel asks for it.
    render(button(3));
    expect(isOpen()).toBe(true);
  });
});

describe("votes on a comment", () => {
  function openWith(c: Comment, vote?: CommentActions["vote"]) {
    const actions: CommentActions = {
      post: async () => {},
      resolve: async () => {},
      remove: async () => {},
      vote,
    };
    render(
      <CommentButton
        anchorKind="entry"
        anchorId="row-1"
        comments={[c]}
        actions={actions}
        directory={directory}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Comment/ }));
  }

  it("shows the net score and names who voted, you first", () => {
    openWith(
      comment({ votes: { up: ["u_grace", "u_me"], down: [] } }),
      vi.fn(async () => {}),
    );
    expect(screen.getByLabelText("Score 2")).toBeTruthy();
    const up = screen.getByRole("button", { name: /Upvoted by/ });
    expect(up.getAttribute("aria-label")).toBe("Upvoted by You and Grace Hopper");
    expect(up.getAttribute("aria-pressed")).toBe("true");
  });

  it("takes your vote back on a second click, and switches on the other arrow", () => {
    const vote = vi.fn(async () => {});
    openWith(comment({ votes: { up: ["u_me"], down: [] } }), vote);
    fireEvent.click(screen.getByRole("button", { name: /Upvoted by/ }));
    expect(vote).toHaveBeenLastCalledWith("c1", 0);
    fireEvent.click(screen.getByRole("button", { name: "Downvote" }));
    expect(vote).toHaveBeenLastCalledWith("c1", -1);
  });

  it("shows nothing to click where the reader cannot vote, and nothing at all with no votes", () => {
    openWith(comment({ votes: { up: ["u_grace"], down: [] } }));
    expect(screen.queryByRole("button", { name: /Upvote/ })).toBeNull();
    expect(screen.getByRole("img", { name: "Upvoted by Grace Hopper" })).toBeTruthy();
    cleanup();
    openWith(comment({ votes: { up: [], down: [] } }));
    expect(screen.queryByLabelText(/Upvote/)).toBeNull();
  });
});
