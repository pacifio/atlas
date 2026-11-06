// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
const respondPermission = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  return { agents: { ...real.agents, respondPermission } };
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

const OPTIONS = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Decline", kind: "reject_once" },
];

function pending(toolName: string, title: string) {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: "atlas-agent",
          acpSessionId: "sess-1",
          requestId: "req-1",
          toolCall: {
            toolCallId: "call-1",
            title,
            kind: "other",
            toolName,
            rawInput: { to: "general", body: "deploy is green" },
            content: ["#general, a channel", "deploy is green"],
          },
          options: OPTIONS,
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

const picked = () =>
  (
    respondPermission.mock.calls as unknown as [unknown, unknown, unknown, { option_id?: string }][]
  ).map((call) => call[3].option_id ?? "cancelled");

beforeEach(() => respondPermission.mockClear());
afterEach(cleanup);

describe("keys on the permission card", () => {
  /// L7: the keys listen on the whole window, so an Enter meant for the
  /// composer as an outward card appeared would have posted in the user's
  /// name. Allow on that card is a click.
  it("an outward card is never allowed by Enter or its digit", () => {
    pending("atlas_org.org_send", "Message #general");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "1" });
    expect(respondPermission).not.toHaveBeenCalled();
    expect(screen.queryByText("↵")).toBeNull();
  });

  /// Found in the live run: with Enter no longer taken as Allow, it fell
  /// through to the composer, where Enter on an empty field is Stop — the
  /// card was cancelled and the turn ended. The card keeps its keys.
  it("an outward card's Enter and Allow digit never reach the composer", () => {
    pending("atlas_org.org_send", "Message #general");
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    const reached = vi.fn();
    composer.addEventListener("keydown", reached);
    composer.focus();
    expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(composer, { key: "1" })).toBe(false);
    expect(reached).not.toHaveBeenCalled();
    expect(respondPermission).not.toHaveBeenCalled();
    composer.remove();
  });

  it("an outward card is allowed by a click, and declined by its digit", () => {
    pending("atlas_org.org_send", "Message #general");
    fireEvent.keyDown(window, { key: "2" });
    expect(picked()).toEqual(["reject"]);
  });

  it("an outward card's Allow button still works", () => {
    pending("atlas_org.org_send", "Message #general");
    fireEvent.click(screen.getByText("Allow"));
    expect(picked()).toEqual(["allow-once"]);
  });

  /// The window handler steps aside only while the "tell the agent" field
  /// holds focus, which it knows by the ref the view forwards to its
  /// textarea. Lose that ref and typing "1" there would approve option 1.
  it("digits and Enter typed into the instruction field never pick an option", () => {
    pending("shell", "rm -rf build");
    const field = screen.getByPlaceholderText(/what to do instead/);
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "1" });
    fireEvent.keyDown(field, { key: "2" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("any other card keeps Enter for Allow", () => {
    pending("shell", "rm -rf build");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(picked()).toEqual(["allow-once"]);
  });

  /// Esc on the plan review reached both the window handler and the dialog's
  /// own dismiss, so the agent was sent two cancels for one request.
  it("Esc on the plan review cancels once", () => {
    pendingPlan();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(picked()).toEqual(["cancelled"]);
  });

  /// The plan review opens with Cancel focused. Enter there belongs to the
  /// button; the window handler must not turn it into an approve.
  it("Enter on the plan review's focused Cancel never approves", async () => {
    pendingPlan();
    const cancel = screen.getByText("Cancel").closest("button");
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.keyDown(cancel!, { key: "Enter" });
    expect(picked()).not.toContain("allow-once");
  });
});

function pendingPlan() {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: "atlas-agent",
          acpSessionId: "sess-1",
          requestId: "req-plan",
          toolCall: {
            toolCallId: "call-plan",
            title: "Ready to code?",
            kind: "other",
            toolName: "ExitPlanMode",
            rawInput: { plan: "1. Do the thing" },
          },
          options: OPTIONS,
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}
