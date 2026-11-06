// @vitest-environment happy-dom
//
// A line comment as a composer chip: its token in the draft, what it becomes
// on a path that carries plain text only, and the composer draft as the one
// record of which comments exist (adding links a chip; removing takes the
// chip, or the token when no composer is mounted, back out).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "../stores/chat-store";
import { COMMENT_LINK_EVENT, type CommentLinkDetail } from "./comment-mentions";
import {
  knownMention,
  mintedMention,
  rememberMention,
  resetMentionRegistryForTests,
} from "./mention-registry";
import { toShortForm, type MentionReviewComment } from "./mentions";
import {
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_TEXT_MAX_CHARS,
  REVIEW_UNLINK_EVENT,
  capReviewComment,
  fenceFor,
  linkReviewCommentToComposer,
  reviewCommentAsText,
  reviewCommentIdsIn,
  unlinkReviewComment,
  withReviewCommentsInline,
} from "./review-comments";

const review = (over: Partial<MentionReviewComment> = {}): MentionReviewComment => ({
  kind: "review_comment",
  id: "r1x2y3",
  displayName: "src/a.ts:2-3",
  sectionId: "changes",
  sectionTitle: "Changes",
  filePath: "src/a.ts",
  rangeLabel: "2 to 3",
  diff: "@@ -3,1 +2,2 @@\n+TWO\n three",
  fenceLanguage: "diff",
  text: "Why uppercase?",
  start: 2,
  end: 3,
  side: "additions",
  endSide: "additions",
  ...over,
});

beforeEach(() => resetMentionRegistryForTests());

describe("the chip's token", () => {
  it("is @review:<id>, and the registry gives the chip back for it", () => {
    const m = review();
    expect(toShortForm(m)).toBe("@review:r1x2y3");
    rememberMention(m, "/p");
    expect(knownMention("@review:r1x2y3", "/p")).toEqual(m);
    expect(mintedMention("review_comment", "r1x2y3")).toEqual(m);
    expect(mintedMention("review_comment", "nope")).toBeNull();
  });

  it("reads the ids a draft holds, in order, once each", () => {
    expect(reviewCommentIdsIn(undefined)).toBe("");
    expect(reviewCommentIdsIn("no tokens here")).toBe("");
    expect(reviewCommentIdsIn("@review:aa fix @review:bb and @review:aa again")).toBe("aa bb");
    // A path or an address is not a token.
    expect(reviewCommentIdsIn("x/@review:cc me@review:dd")).toBe("");
  });
});

describe("as plain text", () => {
  it("writes the file, range, section, quoted lines and comment", () => {
    expect(reviewCommentAsText(review())).toBe(
      [
        "Review comment (@review:r1x2y3) on `src/a.ts`, 2 to 3 (Changes):",
        "```diff",
        "@@ -3,1 +2,2 @@",
        "+TWO",
        " three",
        "```",
        "Comment:",
        "```",
        "Why uppercase?",
        "```",
      ].join("\n"),
    );
  });

  it("fences past any backtick run in the quote or the comment", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ```` b", "`x`")).toBe("`````");
  });

  it("follows the prose on a plain-text path, only when there are comments", () => {
    const m = review();
    expect(withReviewCommentsInline("hi", [])).toBe("hi");
    expect(withReviewCommentsInline("hi", [m])).toBe(`hi\n\n${reviewCommentAsText(m)}`);
  });

  it("caps the comment and the quote", () => {
    const capped = capReviewComment(
      review({ text: `  ${"c".repeat(REVIEW_TEXT_MAX_CHARS + 50)}  `, diff: "d".repeat(9000) }),
    );
    expect(capped.text.length).toBeLessThanOrEqual(REVIEW_TEXT_MAX_CHARS);
    expect(capped.diff.length).toBeLessThanOrEqual(REVIEW_DIFF_MAX_CHARS);
    expect(capped.diff.endsWith("…")).toBe(true);
  });
});

describe("adding and removing", () => {
  const listeners: Array<[string, EventListener]> = [];
  const on = (type: string, fn: (e: CustomEvent) => void) => {
    const l = fn as unknown as EventListener;
    listeners.push([type, l]);
    window.addEventListener(type, l);
  };
  afterEach(() => {
    for (const [type, l] of listeners.splice(0)) window.removeEventListener(type, l);
    useChatStore.setState({ drafts: {} });
  });

  it("is added when a composer takes the chip, capped", () => {
    let got: CommentLinkDetail | null = null;
    on(COMMENT_LINK_EVENT, (e) => {
      got = e.detail as CommentLinkDetail;
      e.preventDefault();
    });
    expect(linkReviewCommentToComposer("tab", review({ text: " hi " }))).toBe(true);
    expect(got).toMatchObject({ tabId: "tab", mention: { kind: "review_comment", text: "hi" } });
  });

  it("is not added when no composer takes it", () => {
    expect(linkReviewCommentToComposer("tab", review())).toBe(false);
  });

  it("leaves a mounted composer to take its chip out", () => {
    useChatStore.setState({ drafts: { tab: "see @review:r1x2y3 please" } });
    on(REVIEW_UNLINK_EVENT, (e) => e.preventDefault());
    unlinkReviewComment("tab", "r1x2y3");
    expect(useChatStore.getState().drafts.tab).toBe("see @review:r1x2y3 please");
  });

  it("strips the token from the draft when no composer is mounted", () => {
    useChatStore.setState({ drafts: { tab: "see @review:r1x2y3 please @review:r1x2y3z" } });
    unlinkReviewComment("tab", "r1x2y3");
    expect(useChatStore.getState().drafts.tab).toBe("see please @review:r1x2y3z");
  });
});
