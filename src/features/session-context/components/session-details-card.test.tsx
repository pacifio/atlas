// @vitest-environment happy-dom
//
// The Details card merged two cards that said the same things twice. What it
// promises: every section either card had, each fact once (one Changes
// section, the child agents in Lineage only), in reading order; the sections
// shed from the top as the card runs short of height, keeping the session's
// own record; and the capture view replacing the sections when deep-linked.
// The sections are stubbed: this is about which ones the card puts where.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const stub = vi.hoisted(() => (name: string) => () => (
  <section data-stub={name} aria-label={name} />
));
vi.mock("./workspace-section", () => ({ WorkspaceSection: stub("workspace") }));
vi.mock("./projects-section", () => ({ ProjectsSection: stub("projects") }));
vi.mock("./version-control-section", () => ({ VersionControlSection: stub("version-control") }));
vi.mock("./changes-section", () => ({ ChangesSection: stub("changes") }));
vi.mock("./lineage-section", () => ({ LineageSection: stub("lineage") }));
vi.mock("./memory-section", () => ({ MemorySection: stub("memory") }));
vi.mock("./session-section", () => ({ SessionSection: stub("session") }));
vi.mock("@/features/capture/components/capture-popover", () => ({
  CapturePopover: () => <div data-testid="capture-view" />,
}));
vi.mock("../lib/details-project-path", () => ({ useDetailsProjectPath: () => "/work/acme" }));

import { useSessionDetailsStore } from "../stores/session-details-store";
import { SessionDetailsCard } from "./session-details-card";

const order = () =>
  [...document.querySelectorAll("[data-stub]")].map((el) => el.getAttribute("data-stub"));

beforeEach(() => {
  useSessionDetailsStore.setState({ view: "main", collapsed: {} });
});
afterEach(cleanup);

describe("SessionDetailsCard", () => {
  it("holds every section of both old cards, each once, in reading order", () => {
    render(<SessionDetailsCard tabId="t1" presentation="docked" maxHeight={null} />);
    expect(order()).toEqual([
      "workspace",
      "projects",
      "version-control",
      "changes",
      "lineage",
      "memory",
      "session",
    ]);
    expect(screen.getByRole("region", { name: "Session details" })).toBeTruthy();
  });

  it("is the same card in both forms", () => {
    render(<SessionDetailsCard tabId="t1" presentation="popover" maxHeight={null} />);
    const card = document.querySelector("[data-session-details-card]")!;
    expect(card.getAttribute("data-session-details-card")).toBe("popover");
    expect(order()).toHaveLength(7);
  });

  it("sheds the project-wide rows first, and keeps the session's own record", () => {
    // Measured too tall for any height: full, then compact, then essential.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(10_000);
    render(<SessionDetailsCard tabId="t1" presentation="docked" maxHeight={200} />);
    const card = document.querySelector("[data-session-details-card]")!;
    expect(card.getAttribute("data-density")).toBe("essential");
    expect(order()).toEqual(["changes", "lineage", "memory"]);
    vi.restoreAllMocks();
  });

  it("opens straight onto its capture view when deep-linked", () => {
    useSessionDetailsStore.setState({ view: "capture" });
    render(<SessionDetailsCard tabId="t1" presentation="docked" maxHeight={null} />);
    expect(screen.getByTestId("capture-view")).toBeTruthy();
    expect(screen.getByText("Session capture")).toBeTruthy();
    expect(order()).toEqual([]);
  });
});
