// @vitest-environment happy-dom
//
// The one notice view behind the composer's status bars. What matters: the
// tone reaches the glyph, an in-flight action cannot be pressed twice, the
// container's test id and tooltip land on the root, and only the notices that
// ask to be status regions are.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShieldAlert } from "lucide-react";
import { ChatNoticeView } from "./chat-notice-view";

afterEach(cleanup);

describe("ChatNoticeView", () => {
  it("colours the glyph by tone", () => {
    const { container } = render(
      <ChatNoticeView placement="tucked" tone="warning" icon={ShieldAlert}>
        msg
      </ChatNoticeView>,
    );
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("text-warning");
  });

  it("busy shows a spinner, and a busy action is disabled", () => {
    const onClick = vi.fn();
    const { container } = render(
      <ChatNoticeView placement="above" busy action={{ label: "Update", onClick, busy: true }}>
        msg
      </ChatNoticeView>,
    );
    expect(container.querySelectorAll('[data-slot="spinner"]').length).toBe(2);
    expect(screen.getByRole("button", { name: "Update" }).hasAttribute("disabled")).toBe(true);
  });

  it("puts the test id and title on the root, and is a status region only when live", () => {
    render(
      <ChatNoticeView placement="above" data-testid="n" title="why">
        msg
      </ChatNoticeView>,
    );
    const root = screen.getByTestId("n");
    expect(root.getAttribute("title")).toBe("why");
    expect(root.getAttribute("role")).toBeNull();
    cleanup();
    render(
      <ChatNoticeView placement="tucked" data-testid="n" live>
        msg
      </ChatNoticeView>,
    );
    expect(screen.getByTestId("n").getAttribute("role")).toBe("status");
  });

  it("fires the action, then the extra actions, in order", async () => {
    const calls: string[] = [];
    render(
      <ChatNoticeView
        placement="tucked"
        action={{ label: "One", onClick: () => calls.push("one") }}
        extraActions={[{ label: "Two", onClick: () => calls.push("two") }]}
      >
        msg
      </ChatNoticeView>,
    );
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["One", "Two"]);
    await userEvent.click(screen.getByRole("button", { name: "One" }));
    await userEvent.click(screen.getByRole("button", { name: "Two" }));
    expect(calls).toEqual(["one", "two"]);
  });

  it("offers a dismiss button only with onDismiss", async () => {
    const onDismiss = vi.fn();
    render(
      <ChatNoticeView placement="tucked" onDismiss={onDismiss} dismissLabel="Dismiss">
        msg
      </ChatNoticeView>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    cleanup();
    render(<ChatNoticeView placement="tucked">msg</ChatNoticeView>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
