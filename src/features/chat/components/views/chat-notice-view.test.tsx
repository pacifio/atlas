// @vitest-environment happy-dom
//
// The one notice view behind the composer's status bars. What matters: the
// tone reaches the glyph, work in flight is not a control, the
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

  it("busy shows a spinner for the glyph, and progress is a label, not a control", () => {
    const { container } = render(
      <ChatNoticeView placement="above" busy progress="Installing…">
        msg
      </ChatNoticeView>,
    );
    expect(container.querySelectorAll('[data-slot="spinner"]').length).toBe(2);
    expect(screen.getByText("Installing…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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

  it("fires its action, and a disabled action does not", async () => {
    const onClick = vi.fn();
    render(
      <ChatNoticeView placement="tucked" action={{ label: "Send anyway", onClick }}>
        msg
      </ChatNoticeView>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onClick).toHaveBeenCalledOnce();
    cleanup();
    render(
      <ChatNoticeView placement="above" action={{ label: "Restarting…", onClick, disabled: true }}>
        msg
      </ChatNoticeView>,
    );
    expect(screen.getByRole("button", { name: "Restarting…" }).hasAttribute("disabled")).toBe(true);
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
