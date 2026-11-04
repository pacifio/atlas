// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CommsComposerView, type CommsComposerViewProps } from "./comms-composer-view";
import type { OrgMemberProfile } from "../../types";

const ada: OrgMemberProfile = {
  id: "u_ada",
  name: "Ada Lovelace",
  email: "ada@x.test",
  role: "member",
};
const grace: OrgMemberProfile = {
  id: "u_grace",
  name: "Grace Hopper",
  email: "grace@x.test",
  role: "member",
};

afterEach(cleanup);

function mount(overrides: Partial<CommsComposerViewProps> = {}) {
  const props: CommsComposerViewProps = {
    input: <div>Message #general</div>,
    draftEmpty: true,
    intent: null,
    onCancelIntent: vi.fn(),
    attachments: [],
    onRemoveAttachment: vi.fn(),
    atAttachmentLimit: false,
    attachmentLimit: 10,
    onAttach: vi.fn(),
    mention: null,
    bytes: 0,
    maxBytes: 1000,
    sendState: "disabled",
    editing: false,
    onSend: vi.fn(),
    onFormat: vi.fn(),
    onEmoji: vi.fn(),
    onMention: vi.fn(),
    dropActive: false,
    renderAvatar: (m) => <span>{m.name[0]}</span>,
    ...overrides,
  };
  render(<CommsComposerView {...props} />);
  return props;
}

describe("CommsComposerView", () => {
  it("disables send unless the container says it is ready", () => {
    mount({ sendState: "disabled" });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    cleanup();
    const props = mount({ sendState: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("names the send button for an edit and for a wait on uploads", () => {
    mount({ editing: true, sendState: "ready" });
    expect(screen.getByRole("button", { name: "Save edit" })).toBeTruthy();
    cleanup();
    mount({ sendState: "uploading" });
    expect(screen.getByRole("button", { name: "Waiting for uploads…" })).toBeTruthy();
  });

  it("shows the byte counter only past 80% of the cap", () => {
    mount({ bytes: 790 });
    expect(screen.queryByText(/\/ 1,000/)).toBeNull();
    cleanup();
    mount({ bytes: 810 });
    expect(screen.getByText(/\/ 1,000/)).toBeTruthy();
  });

  it("keeps the editor's selection: a format button's mousedown is prevented", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Formatting" }));
    const bold = screen.getByRole("button", { name: /^Bold/ });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    bold.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(bold);
    expect(props.onFormat).toHaveBeenCalledWith("bold");
  });

  it("picks a mention row on click", () => {
    const onPick = vi.fn();
    mount({ mention: { matches: [ada, grace], highlighted: 1, onHover: vi.fn(), onPick } });
    fireEvent.click(screen.getByText("Grace Hopper"));
    expect(onPick).toHaveBeenCalledWith(grace);
  });

  it("reads a reply strip as the author and the preview, and cancels it", () => {
    const props = mount({ intent: { kind: "reply", author: "Ada Lovelace", preview: "hi" } });
    expect(screen.getByText("Replying to")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace · hi")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelIntent).toHaveBeenCalledOnce();
  });
});
