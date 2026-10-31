// @vitest-environment happy-dom
import { useEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const conversations = [{ id: "c", name: "general" }];
const drafts = {
  c: [
    { id: "d1", title: "One" },
    { id: "d2", title: "Two" },
  ],
};

vi.mock("../stores/comms-store", () => {
  const useCommsStore = (select: (s: { drafts: typeof drafts }) => unknown) => select({ drafts });
  useCommsStore.use = { conversations: () => conversations };
  return { useCommsStore };
});

/** One entry per editor MOUNT — a re-render with new props adds nothing. */
const mounts: string[] = [];
vi.mock("./draft-editor", () => ({
  DraftEditor: ({ draft }: { draft: { id: string } }) => {
    useEffect(() => {
      mounts.push(draft.id);
      // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-draft={draft.id} />;
  },
}));

const { CommsDraftTab } = await import("./comms-draft-tab");

afterEach(() => {
  cleanup();
  mounts.length = 0;
});

describe("CommsDraftTab", () => {
  /**
   * The regression: the centre panel renders the active tab in one unkeyed
   * slot, so switching from one draft tab to another re-rendered the SAME
   * editor with a new draft id. Its Y.Doc and `ready` flag belonged to the
   * first draft, and the two drafts' content mixed.
   */
  it("mounts a fresh editor when the draft in the same slot changes", () => {
    const { rerender } = render(<CommsDraftTab convId="c" draftId="d1" />);
    rerender(<CommsDraftTab convId="c" draftId="d2" />);
    rerender(<CommsDraftTab convId="c" draftId="d1" />);
    expect(mounts).toEqual(["d1", "d2", "d1"]);
  });
});
