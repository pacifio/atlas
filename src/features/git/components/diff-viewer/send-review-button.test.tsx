// @vitest-environment happy-dom
//
// "Send review to agent": the tab's held comments open the one ask box as one
// prompt, and are let go only once the box hands them over.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useAskAgentStore } from "@/features/ask-agent/stores/ask-agent-store";
import type { MentionReviewComment } from "@/features/chat/lib/mentions";

import { useReviewDraftStore } from "../../stores/review-draft-store";
import { SendReviewButton } from "./send-review-button";

afterEach(() => {
  cleanup();
  useAskAgentStore.setState({ request: null });
  useReviewDraftStore.setState({ byTab: {} });
});

function comment(id: string, text: string): MentionReviewComment {
  return {
    kind: "review_comment",
    id,
    displayName: "src/a.ts:3",
    sectionId: "branch-range",
    sectionTitle: "Changes",
    filePath: "src/a.ts",
    rangeLabel: "+3",
    diff: "@@ -1,1 +3,1 @@\n+const a = 1;",
    fenceLanguage: "diff",
    text,
    start: 3,
    end: 3,
    side: "additions",
    endSide: "additions",
  };
}

describe("SendReviewButton", () => {
  it("shows nothing with no comments held", () => {
    render(<SendReviewButton tabId="diff-1" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the box with every comment, and lets them go once asked", () => {
    const { add } = useReviewDraftStore.getState().actions;
    add("diff-1", comment("a", "Rename this"));
    add("diff-1", comment("b", "Drop the log"));
    render(<SendReviewButton tabId="diff-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Send review to agent/ }));
    const request = useAskAgentStore.getState().request;
    expect(request?.context).toHaveLength(2);
    expect(request?.prompt).toContain("2. `src/a.ts` +3: Drop the log");

    // One more while the box is open, and "a"'s chip taken out of it: only
    // "b" went, so only "b" is let go.
    add("diff-1", comment("c", "Later"));
    request?.onAsked?.({ tabId: "chat-1", title: "S", sent: true, created: false }, [1]);
    expect(useReviewDraftStore.getState().byTab["diff-1"]?.map((c) => c.id)).toEqual(["a", "c"]);
  });
});
