// @vitest-environment happy-dom
//
// The title bar's session group is Details alone (the pins pill joins it only
// while something is pinned). Nothing else lives in it, and nothing follows
// the window's panel toggle: team chat left the bar for the sidebar footer and
// the surfaces pane, the session's actions are its sidebar row's menu, and the
// Bash calls and Plans panels open from the Details card.

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

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

afterEach(cleanup);

describe("the session group", () => {
  it("is Details alone while nothing is pinned", () => {
    render(
      <HintGroup>
        <SessionHeaderControls
          tabId="t1"
          scope="t:t1"
          docked={false}
          stageRef={createRef<HTMLElement>()}
          pinScopeKey="t1"
          onJumpToPin={() => {}}
        />
      </HintGroup>,
    );
    const group = document.querySelector("[data-session-controls]")!;
    const names = [...group.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Session details"]);
  });
});
