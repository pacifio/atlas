// @vitest-environment happy-dom
//
// The elicitation dialog's answer paths: Send waits for the required fields,
// Decline declines, Esc cancels (never declines), a single choice stays picked
// when pressed again, and focus opens on the first text input, else Decline.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ElicitationDialogView } from "./elicitation-dialog-view";
import type { ElicitationField } from "../../lib/elicitation-schema";

const FIELDS: ElicitationField[] = [
  {
    name: "branch",
    title: "Branch name",
    description: null,
    kind: "string",
    required: true,
    choices: [],
    multi: false,
    default: null,
  },
  {
    name: "draft",
    title: "Open as a draft",
    description: null,
    kind: "boolean",
    required: false,
    choices: [],
    multi: false,
    default: null,
  },
  {
    name: "env",
    title: "Environment",
    description: null,
    kind: "enum",
    required: false,
    choices: [
      { value: "staging", label: "Staging", description: null },
      { value: "prod", label: "Production", description: null },
    ],
    multi: false,
    default: null,
  },
] as unknown as ElicitationField[];

function renderDialog(over: Partial<Parameters<typeof ElicitationDialogView>[0]> = {}) {
  const props = {
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    onCancel: vi.fn(),
    onOpenUrl: vi.fn(),
  };
  render(
    <ElicitationDialogView
      mode="form"
      message="I need a branch."
      url={null}
      fields={FIELDS}
      busy={false}
      {...props}
      {...over}
    />,
  );
  return props;
}

const send = () => screen.getByText("Send").closest("button")!;

afterEach(cleanup);

describe("ElicitationDialogView", () => {
  it("keeps Send off until the required field is filled, then sends the values", () => {
    const { onAccept } = renderDialog();
    fireEvent.click(send());
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "release/1.2" } });
    fireEvent.click(send());
    expect(onAccept).toHaveBeenCalledWith({ branch: "release/1.2", draft: false });
  });

  it("Decline calls onDecline", () => {
    const { onDecline, onCancel } = renderDialog();
    fireEvent.click(screen.getByText("Decline"));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Esc cancels and never declines", async () => {
    const { onDecline, onCancel } = renderDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("keeps a single choice picked when it is pressed again", () => {
    const { onAccept } = renderDialog();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "b" } });
    fireEvent.click(screen.getByText("Staging"));
    fireEvent.click(screen.getByText("Staging"));
    fireEvent.click(send());
    expect(onAccept).toHaveBeenCalledWith({ branch: "b", draft: false, env: "staging" });
  });

  it("holds Send and Decline while a reply is in flight", () => {
    const { onAccept, onDecline } = renderDialog({ fields: [], busy: true });
    fireEvent.click(send());
    fireEvent.click(screen.getByText("Decline"));
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("a yes/no field flips and sends its boolean", () => {
    const { onAccept } = renderDialog();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "b" } });
    expect(screen.getByText("No")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("Yes")).toBeTruthy();
    fireEvent.click(send());
    expect(onAccept).toHaveBeenCalledWith({ branch: "b", draft: true });
  });

  it("locks Send and Decline while someone else drives, and says who", () => {
    const { onAccept, onDecline } = renderDialog({ fields: [], remoteDriver: "Sam Lee" });
    expect(screen.getByTestId("elicitation-seat-notice").textContent).toContain("Sam Lee");
    fireEvent.click(send());
    fireEvent.click(screen.getByText("Decline"));
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("url mode: I'm done accepts with no content, Open page opens the url", () => {
    const { onAccept, onOpenUrl } = renderDialog({
      mode: "url",
      fields: [],
      url: "https://example.invalid/consent",
    });
    fireEvent.click(screen.getByText("Open page"));
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.invalid/consent");
    fireEvent.click(screen.getByText("I'm done"));
    expect(onAccept).toHaveBeenCalledWith({});
  });

  it("shows no Open page button in url mode without a url", () => {
    renderDialog({ mode: "url", fields: [] });
    expect(screen.queryByText("Open page")).toBeNull();
    expect(screen.getByText("I'm done")).toBeTruthy();
  });

  it("opens with focus on the first text input", async () => {
    // The text field is listed after a boolean here: focus skips the switch.
    renderDialog({ fields: [FIELDS[1], FIELDS[0], FIELDS[2]] });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Branch name")));
  });

  it("opens on Decline when there is nothing to type, never on Send", async () => {
    renderDialog({ fields: [] });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText("Decline").closest("button")),
    );
  });

  it("opens on Decline in url mode, not on Open page", async () => {
    renderDialog({ mode: "url", url: "https://example.invalid/consent", fields: [] });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText("Decline").closest("button")),
    );
  });
});
