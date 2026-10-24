// @vitest-environment happy-dom
//
// The title bar's session group, kept to two controls: Details, then ⋯ last.
// Nothing else lives in it: team chat left the bar for the sidebar footer and
// the surfaces pane, and the panel toggle is the window's group, not the
// session's.

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@/features/session-context/components/session-details-button", () => ({
  SessionDetailsButton: () => <button type="button" aria-label="Session details" />,
}));
import { HintGroup } from "@/ui/hint-group";
import { SessionHeaderControls } from "./session-header";

function mount() {
  render(
    <HintGroup>
      <SessionHeaderControls
        tabId="t1"
        scope="t:t1"
        docked={false}
        stageRef={createRef<HTMLElement>()}
        onOpenSearch={() => {}}
        roleFilter="all"
        onRoleFilterChange={() => {}}
        pinScopeKey="t1"
        onJumpToPin={() => {}}
        bashPanelOpen={false}
        onToggleBash={() => {}}
        plansPanelOpen={false}
        onTogglePlans={() => {}}
      />
    </HintGroup>,
  );
}

afterEach(cleanup);

describe("the session group", () => {
  it("is Details, then ⋯", () => {
    mount();
    const group = document.querySelector("[data-session-controls]")!;
    const names = [...group.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Session details", "Session options"]);
  });

  it("has no terminal item in ⋯: the drawer is unmounted until the terminal rework", async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    });
    await screen.findByRole("menuitem", { name: /Search in session/ });
    expect(screen.queryByRole("menuitemcheckbox", { name: /Terminal/ })).toBeNull();
  });
});
