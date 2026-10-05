// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { SharedPeer } from "../lib/shared-threads-api";

// The design system's styling library is not what is under test.
vi.mock("@/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import { PresenceBar, SyncBadge, activity, initials } from "./presence-bar";

afterEach(cleanup);

function peer(over: Partial<SharedPeer>): SharedPeer {
  return {
    peerId: "c1",
    userId: "monzim",
    role: "participant",
    surface: "desktop",
    typing: null,
    cursors: [],
    runs: [],
    sync: "current",
    ...over,
  };
}

describe("presence (ATL-407)", () => {
  it("shows whether this replica is current, syncing or behind", () => {
    const { rerender } = render(<SyncBadge sync="current" connected />);
    expect(screen.getByText("Up to date")).toBeTruthy();
    rerender(<SyncBadge sync="syncing" connected />);
    expect(screen.getByText("Syncing")).toBeTruthy();
    // Offline before the replica has said anything is behind too.
    rerender(<SyncBadge sync={null} connected={false} />);
    expect(screen.getByText("Behind")).toBeTruthy();
  });

  it("draws one avatar per person and says who is typing where, and where Runs are", () => {
    const { container } = render(
      <PresenceBar
        peers={[
          peer({ typing: "src/app.ts" }),
          peer({ peerId: "c2", typing: null }),
          peer({ peerId: "w1", userId: "joy", surface: "web", runs: [{ runId: "r", path: "README.md" }] }),
        ]}
      />,
    );
    expect(screen.getAllByText(/^(MO|JO)$/)).toHaveLength(2);
    // His second window is idle; what the first is doing still shows.
    expect(container.textContent).toContain("monzim is typing in src/app.ts");
    expect(container.textContent).toContain("joy is running an agent in README.md");
  });

  it("uses people's names where it knows them", () => {
    const { container } = render(
      <PresenceBar peers={[peer({ typing: "a.ts" })]} nameOf={(id) => (id === "monzim" ? "Azraf Monzim" : id)} />,
    );
    expect(screen.getByText("AM")).toBeTruthy();
    expect(container.textContent).toContain("Azraf Monzim is typing in a.ts");
  });

  it("names avatars and activity plainly", () => {
    expect(initials("monzim")).toBe("MO");
    expect(initials("joy.lee")).toBe("JL");
    expect(initials("Joy Lee")).toBe("JL");
    expect(activity(peer({}))).toBeNull();
    expect(activity(peer({ runs: [{ runId: "r", path: null }] }))).toBe("running an agent");
  });
});
