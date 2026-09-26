// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { cleanup, render, screen } from "@testing-library/react";
import { OutwardActionBody, OutwardActionHeading } from "./permission-modal";
import { outwardApprovalOf } from "@/features/org-actions/lib/outward-approval";

afterEach(cleanup);

/** Well past the 4000 characters the ordinary tool-call preview keeps. */
const LONG = Array.from({ length: 300 }, (_, i) => `line ${i}: renamed the theme keys`).join("\n");

const approval = outwardApprovalOf({
  toolCallId: "call-1",
  title: "Reply on Sam Lee's comment",
  kind: "other",
  toolName: "atlas_org.org_comment_reply",
  content: ['Sam Lee, on their comment "can you check the path?"', LONG],
})!;

describe("the outward action's approval card", () => {
  it("names the act and the recipient instead of asking to run a tool", () => {
    render(<OutwardActionHeading approval={approval} />);
    expect(screen.getByText("Reply on Sam Lee's comment")).toBeTruthy();
    expect(screen.getByText('Sam Lee, on their comment "can you check the path?"')).toBeTruthy();
    expect(screen.queryByText(/wants to run/)).toBeNull();
  });

  it("shows the whole body, scrolling inside the card rather than cut short", () => {
    render(<OutwardActionBody approval={approval} />);
    const body = screen.getByTestId("outward-body");
    expect(LONG.length).toBeGreaterThan(4000);
    expect(body.textContent).toBe(LONG);
    expect(body.className).toContain("overflow-auto");
    expect(body.className).toContain("whitespace-pre-wrap");
  });
});
