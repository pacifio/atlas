// @vitest-environment happy-dom
//
// The bar a resume leaves in the composer when it could not restore the
// user's mode. What matters is that it stays until a pick and that its action
// reaches the picker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useChatStore } from "../stores/chat-store";
import { ModeRestoreBar, OPEN_MODE_PICKER_EVENT } from "./mode-restore-bar";

const TAB = "tab-1";

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "codex");
});
afterEach(cleanup);

describe("ModeRestoreBar", () => {
  it("renders nothing while every mode was restored", () => {
    render(<ModeRestoreBar tabId={TAB} />);
    expect(screen.queryByTestId("mode-restore-bar")).toBeNull();
  });

  it("names the mode it could not restore, and stays until the user picks one", () => {
    const { setAcpModes, setUnrestoredMode } = useChatStore.getState().actions;
    setAcpModes(TAB, "auto", [{ id: "read-only", name: "Read Only" }], "codex");
    setUnrestoredMode(TAB, "read-only");
    render(<ModeRestoreBar tabId={TAB} />);
    expect(screen.getByTestId("mode-restore-bar").textContent).toContain("Read Only");

    act(() => useChatStore.getState().actions.setAcpMode(TAB, "read-only"));
    expect(screen.queryByTestId("mode-restore-bar")).toBeNull();
  });

  it("opens this tab's mode picker", async () => {
    useChatStore.getState().actions.setUnrestoredMode(TAB, "read-only");
    const opened = vi.fn();
    const onOpen = (e: Event) => opened((e as CustomEvent<{ tabId: string }>).detail.tabId);
    window.addEventListener(OPEN_MODE_PICKER_EVENT, onOpen);
    try {
      render(<ModeRestoreBar tabId={TAB} />);
      await userEvent.click(screen.getByRole("button", { name: "Choose mode" }));
      expect(opened).toHaveBeenCalledWith(TAB);
    } finally {
      window.removeEventListener(OPEN_MODE_PICKER_EVENT, onOpen);
    }
  });
});
