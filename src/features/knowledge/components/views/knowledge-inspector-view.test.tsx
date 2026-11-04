// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KnowledgeInspectorView } from "./knowledge-inspector-view";

afterEach(cleanup);

const backlinks = [
  { fromEntryId: "roadmap-q4", fromTitle: "Roadmap Q4", snippet: "load-test the session service" },
  { fromEntryId: "architecture/overview", fromTitle: "Overview", snippet: "web renders pages" },
];

function renderInspector(overrides: Partial<Parameters<typeof KnowledgeInspectorView>[0]> = {}) {
  const props = {
    outline: [
      { id: "sign-in", label: "Sign-in", level: 2 as const },
      { id: "tokens", label: "Tokens", level: 3 as const },
    ],
    activeHeadingId: "tokens",
    onJumpToHeading: vi.fn(),
    pageStats: [["Words", "118"]] as Array<[string, string | number]>,
    backlinks,
    onJumpToEntry: vi.fn(),
    ...overrides,
  };
  render(<KnowledgeInspectorView {...props} />);
  return props;
}

describe("KnowledgeInspectorView", () => {
  it("marks the active heading and jumps on click", () => {
    const props = renderInspector();
    const active = screen.getByRole("button", { name: "Tokens" });
    expect(active.getAttribute("aria-current")).toBe("location");
    expect(screen.getByRole("button", { name: "Sign-in" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign-in" }));
    expect(props.onJumpToHeading).toHaveBeenCalledWith("sign-in");
  });

  it("says how to build an outline when there is none", () => {
    renderInspector({ outline: [] });
    expect(screen.getByText("Add H2 or H3 headings to build an outline")).toBeTruthy();
  });

  it("lists the backlinks it is given and opens one", () => {
    const props = renderInspector();
    fireEvent.click(screen.getByRole("button", { name: "Backlinks" }));
    expect(screen.getByText("Pages linking here · 2")).toBeTruthy();
    fireEvent.click(screen.getByText("Roadmap Q4"));
    expect(props.onJumpToEntry).toHaveBeenCalledWith("roadmap-q4");
  });
});
