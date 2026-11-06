// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runMenuItem } = vi.hoisted(() => ({ runMenuItem: vi.fn(() => true) }));
vi.mock("../lib/run-menu-item", () => ({ runMenuItem }));

import { AppMenuButton } from "./menu-bar";

afterEach(cleanup);

async function openMenu() {
  render(<AppMenuButton />);
  fireEvent.click(screen.getByRole("button", { name: "Application menu" }));
  await screen.findByRole("menuitem", { name: "Atlas" });
}

describe("AppMenuButton", () => {
  it("is one button until opened, not a row of menus", () => {
    render(<AppMenuButton />);
    expect(screen.getByRole("button", { name: "Application menu" })).toBeTruthy();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("lists the shared menus as submenus, without the macOS-only ones", async () => {
    await openMenu();
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual(["Atlas", "File", "Edit", "View", "Window", "Help"]);
  });

  it("runs the clicked item by its id", async () => {
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send Feedback…" }));
    expect(runMenuItem).toHaveBeenCalledWith("help.feedback");
  });
});
