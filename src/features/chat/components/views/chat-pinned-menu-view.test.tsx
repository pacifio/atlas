// @vitest-environment happy-dom
//
// The pinned-messages dropdown: absent with no pins, a row jumps and closes,
// the search narrows the rows, and unpin reports the message id.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPinnedMenuView } from "./chat-pinned-menu-view";

afterEach(cleanup);

const AT = new Date().toISOString();
const PINS = [
  { messageId: "m1", text: "Fix the login race", at: AT },
  { messageId: "m2", text: "Bump the schema", at: AT },
];

describe("ChatPinnedMenuView", () => {
  it("renders nothing with no pins", () => {
    const { container } = render(
      <ChatPinnedMenuView pins={[]} onJump={() => {}} onUnpin={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("filters, jumps and unpins", async () => {
    const onJump = vi.fn();
    const onUnpin = vi.fn();
    render(<ChatPinnedMenuView pins={PINS} onJump={onJump} onUnpin={onUnpin} />);
    await userEvent.click(screen.getByRole("button", { name: "2 pinned messages" }));

    await userEvent.type(screen.getByLabelText("Search pinned messages"), "schema");
    expect(screen.queryByText("Fix the login race")).toBeNull();
    await userEvent.click(screen.getByLabelText("Unpin message"));
    expect(onUnpin).toHaveBeenCalledWith("m2");

    await userEvent.click(screen.getByText("Bump the schema"));
    expect(onJump).toHaveBeenCalledWith(PINS[1]);
  });
});
