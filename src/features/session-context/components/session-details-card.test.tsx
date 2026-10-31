// @vitest-environment happy-dom
//
// The Details card's sections, in reading order, and the rows it sheds as it
// runs short of height: the environment, Projects and Lineage first, then
// "Open in" and the Commit row. Branch, pull request and Changes stay. The
// sections are stubbed (each reports the props that choose its rows): this is
// about what the card asks of them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const stub = vi.hoisted(() => (name: string) => (props: Record<string, unknown>) => (
  <section
    data-stub={name}
    data-props={JSON.stringify(
      Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === "boolean")),
    )}
  />
));
vi.mock("./workspace-section", () => ({ WorkspaceSection: stub("workspace") }));
vi.mock("./version-control-section", () => ({ VersionControlSection: stub("version-control") }));
vi.mock("./projects-section", () => ({ ProjectsSection: stub("projects") }));
vi.mock("./lineage-section", () => ({ LineageSection: stub("lineage") }));
vi.mock("../lib/details-project-path", () => ({ useDetailsProjectPath: () => "/work/acme" }));
vi.mock("../lib/session-work-path", () => ({ useSessionWorkPath: () => null }));

import { SessionDetailsCard } from "./session-details-card";

const sections = () =>
  [...document.querySelectorAll("[data-stub]")].map((el) => [
    el.getAttribute("data-stub"),
    JSON.parse(el.getAttribute("data-props") ?? "{}"),
  ]);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionDetailsCard", () => {
  it("shows every section, in reading order, when it has the room", () => {
    render(<SessionDetailsCard tabId="t1" presentation="docked" maxHeight={null} />);
    expect(sections()).toEqual([
      ["workspace", { showEnvironment: true, showOpenIn: true }],
      ["version-control", { compact: false }],
      ["projects", {}],
      ["lineage", {}],
    ]);
    expect(screen.getByRole("region", { name: "Session details" })).toBeTruthy();
  });

  it("is the same card in both forms", () => {
    render(<SessionDetailsCard tabId="t1" presentation="popover" maxHeight={null} />);
    const card = document.querySelector("[data-session-details-card]")!;
    expect(card.getAttribute("data-session-details-card")).toBe("popover");
    expect(sections()).toHaveLength(4);
  });

  it("sheds the environment, projects, lineage, Open in and the git action, in that order", () => {
    // Measured too tall for any height: full, then compact, then essential.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(10_000);
    render(<SessionDetailsCard tabId="t1" presentation="docked" maxHeight={200} />);
    const card = document.querySelector("[data-session-details-card]")!;
    expect(card.getAttribute("data-density")).toBe("essential");
    expect(sections()).toEqual([
      ["workspace", { showEnvironment: false, showOpenIn: false }],
      ["version-control", { compact: true }],
    ]);
  });
});
