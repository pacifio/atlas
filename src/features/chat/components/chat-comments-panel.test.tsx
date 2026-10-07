// @vitest-environment happy-dom
/**
 * The comments panel is DOCKED beside the transcript, not modal over it, so
 * the keyboard is shared: the composer, a permission card and every hidden
 * chat tab are all live while it is open. These pin who Escape belongs to and
 * where focus goes when the panel opens and closes.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_ORG_DIRECTORY } from "@/features/organisations/lib/use-org-directory";
import { EMPTY_ANCHOR_MAP } from "../lib/comment-anchors";
import { useChatCommentsStore } from "../stores/chat-comments-store";
import { ChatCommentsPanel } from "./chat-comments-panel";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(() => {
  cleanup();
  useChatCommentsStore.setState({
    byTab: {
      t1: {
        target: null,
        entries: [],
        anchors: EMPTY_ANCHOR_MAP,
        byAnchor: {},
        byChatKey: {},
        session: [],
        commentCount: 0,
        actions: {
          post: async () => {},
          resolve: async () => {},
          remove: async () => {},
        },
        directory: EMPTY_ORG_DIRECTORY,
      },
    },
  });
});

/** The panel beside a stand-in composer, opened by a header-style toggle. */
function Pane({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        toggle comments
      </button>
      <textarea aria-label="composer" />
      {open && (
        <ChatCommentsPanel
          tabId="t1"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function open() {
  const toggle = screen.getByRole("button", { name: "toggle comments" });
  toggle.focus();
  fireEvent.click(toggle);
  return toggle;
}

describe("ChatCommentsPanel keyboard and focus", () => {
  it("takes focus on open, so Escape closes it straight away", () => {
    render(<Pane />);
    open();
    const panel = screen.getByRole("complementary", { name: "Comments" });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
  });

  it("hands focus back to the button that opened it", () => {
    render(<Pane />);
    const toggle = open();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves Escape typed in the composer to the composer", () => {
    const onClose = vi.fn();
    render(<Pane onClose={onClose} />);
    open();
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Comments" })).toBeTruthy();
  });

  it("does not steal focus back from where the user moved it", () => {
    render(<Pane />);
    const toggle = open();
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    fireEvent.click(toggle); // closed from the header while typing elsewhere
    expect(document.activeElement).toBe(composer);
  });

  it("clears a search on the first Escape and closes on the second", () => {
    const onClose = vi.fn();
    render(<Pane onClose={onClose} />);
    open();
    const search = screen.getByRole("textbox", { name: "Search comments" });
    search.focus();
    fireEvent.change(search, { target: { value: "token" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
