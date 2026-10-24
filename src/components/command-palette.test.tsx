// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  addTab: vi.fn(),
  toggleLeftPanel: vi.fn(),
  toggleRightPanel: vi.fn(),
  toggleRightChatPanel: vi.fn(),
  toggleChatSidebar: vi.fn(),
  toggleTabBar: vi.fn(),
  toggleZenMode: vi.fn(),
  setLeftSection: vi.fn(),
  setRightSection: vi.fn(),
  revealRightSection: vi.fn(),
  addGroup: vi.fn(),
  focusAdjacentGroup: vi.fn(),
  closeGroup: vi.fn(),
}));

vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: {
    use: { actions: () => actions },
    getState: () => ({
      leftPanel: { visible: false },
      rightPanel: { visible: true, mode: "chat" },
      focusedGroupId: "main",
    }),
  },
}));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { use: { actions: () => ({ openProject: vi.fn() }) } },
}));
vi.mock("@/features/keybindings/components/action-kbd", () => ({ ActionKbd: () => null }));

import { CommandPalette } from "./command-palette";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("workspace navigation commands", () => {
  it("opens Knowledge in a center tab instead of the removed left-panel section", () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Show Knowledge/ }));
    expect(actions.addTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "knowledge", title: "Knowledge" }),
    );
    expect(actions.setLeftSection).not.toHaveBeenCalled();
    expect(actions.toggleLeftPanel).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [/Show Source Control/, "changes"],
    [/Show Git Graph/, "git-graph"],
  ] as const)("reveals %s even when the right panel is showing team chat", (name, section) => {
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name }));
    expect(actions.revealRightSection).toHaveBeenCalledWith(section);
  });
});
