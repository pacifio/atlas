// @vitest-environment happy-dom
//
// A comment thread's open state and drafts outlive its row: under a
// `CommentAnchorProvider` a remounted row reads back what it held, and without
// one the state is plain local state, gone with the row.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommentAnchorProvider, useCommentAnchorState } from "./comment-anchor-context";

afterEach(cleanup);

function Draft({ anchor }: { anchor: string }) {
  const [value, setValue] = useCommentAnchorState(anchor, "");
  return <textarea aria-label="draft" value={value} onChange={(e) => setValue(e.target.value)} />;
}

function Rows({ shown, wrap }: { shown: boolean; wrap: boolean }) {
  const row = shown ? <Draft anchor="message:m1" /> : null;
  return wrap ? <CommentAnchorProvider>{row}</CommentAnchorProvider> : row;
}

describe("useCommentAnchorState", () => {
  it("keeps a draft across the row unmounting and coming back", () => {
    const view = render(<Rows shown wrap />);
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "half a thought" } });
    view.rerender(<Rows shown={false} wrap />);
    view.rerender(<Rows shown wrap />);
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("an instance handed another anchor reads that anchor, not the last one's draft", () => {
    const at = (anchor: string) => (
      <CommentAnchorProvider>
        <Draft anchor={anchor} />
      </CommentAnchorProvider>
    );
    const view = render(at("message:m1"));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "for m1" } });
    view.rerender(at("message:m2"));
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("");
    view.rerender(at("message:m1"));
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("for m1");
  });

  it("is plain local state without a provider", () => {
    const view = render(<Rows shown wrap={false} />);
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "half a thought" } });
    view.rerender(<Rows shown={false} wrap={false} />);
    view.rerender(<Rows shown wrap={false} />);
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("");
  });
});
