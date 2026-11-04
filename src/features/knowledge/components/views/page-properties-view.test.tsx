// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PagePropertiesView } from "./page-properties-view";
import type { PagePropertiesMeta } from "../../lib/page-properties-model";

afterEach(cleanup);

const NOW = new Date("2026-10-06T12:00:00Z");
const META: PagePropertiesMeta = {
  status: "RFC",
  owner: "priya",
  tags: ["auth", "security"],
  createdAt: "2026-03-04T12:00:00Z",
  updatedAt: "2025-11-20T12:00:00Z",
};

function renderStrip(meta: PagePropertiesMeta = META, defaultOpen = true) {
  const onPatch = vi.fn();
  render(
    <PagePropertiesView
      meta={meta}
      referencesLabel="3 in · 1 out"
      onPatch={onPatch}
      defaultOpen={defaultOpen}
      now={NOW}
    />,
  );
  return onPatch;
}

describe("PagePropertiesView", () => {
  it("shows the summary while collapsed and the rows once opened", () => {
    renderStrip(META, false);
    expect(screen.getByText("RFC · @priya · #auth +1")).toBeTruthy();
    fireEvent.click(screen.getByText("Properties"));
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Mar 4")).toBeTruthy();
    expect(screen.getByText("Nov 20, 2025")).toBeTruthy();
  });

  it("owner: Escape reverts without a patch, Enter commits", () => {
    const onPatch = renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "priya" }));
    const input = screen.getByRole("textbox", { name: "Owner" });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onPatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "priya" }));
    const again = screen.getByRole("textbox", { name: "Owner" });
    fireEvent.change(again, { target: { value: "x" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(onPatch).toHaveBeenCalledWith({ owner: "x" });
  });

  it("tags: Enter adds, a duplicate is not added, Backspace on empty removes the last", () => {
    const onPatch = renderStrip();
    fireEvent.click(screen.getByRole("button", { name: /add/ }));
    let input = screen.getByRole("textbox", { name: "New tag" });
    fireEvent.change(input, { target: { value: "passkeys" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPatch).toHaveBeenLastCalledWith({ tags: ["auth", "security", "passkeys"] });

    onPatch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /add/ }));
    input = screen.getByRole("textbox", { name: "New tag" });
    fireEvent.change(input, { target: { value: "auth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /add/ }));
    input = screen.getByRole("textbox", { name: "New tag" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onPatch).toHaveBeenCalledWith({ tags: ["auth"] });
  });

  it("removes a tag from its pill", () => {
    const onPatch = renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Remove tag auth" }));
    expect(onPatch).toHaveBeenCalledWith({ tags: ["security"] });
  });
});
