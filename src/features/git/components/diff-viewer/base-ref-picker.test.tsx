// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BranchInfo } from "../../stores/git-store";
import { BaseRefPicker } from "./base-ref-picker";

const branch = (name: string, isRemote = false): BranchInfo => ({
  name,
  isCurrent: false,
  isRemote,
  upstream: null,
  ahead: 0,
  behind: 0,
  subject: "",
  date: "",
});

const BRANCHES = [
  branch("feature/x"),
  branch("main"),
  branch("dev"),
  branch("origin/main", true),
  branch("origin/release", true),
];

function renderPicker(chosen: string | null = null) {
  const onPick = vi.fn();
  render(
    <BaseRefPicker
      current="origin/main"
      chosen={chosen}
      branches={BRANCHES}
      head="feature/x"
      onPick={onPick}
    />,
  );
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /change comparison target/i }));
  });
  return onPick;
}

const rowLabels = () => screen.getAllByRole("option").map((o) => o.textContent);
const search = () => screen.getByRole("combobox", { name: "Search refs" });

afterEach(cleanup);

describe("BaseRefPicker", () => {
  it("lists Automatic, then branches, without the branch being compared", async () => {
    renderPicker();
    await screen.findByRole("listbox");
    expect(rowLabels()).toEqual(["Automatic", "main", "dev", "origin/release"]);
    expect(screen.getByText("Branch")).toBeTruthy();
    expect(screen.getByText("Remote")).toBeTruthy();
  });

  it("filters as you type, and Automatic is not a match for text", async () => {
    renderPicker();
    await screen.findByRole("listbox");
    act(() => {
      fireEvent.change(search(), { target: { value: "rel" } });
    });
    expect(rowLabels()).toEqual(["origin/release"]);
    act(() => {
      fireEvent.change(search(), { target: { value: "nothing-like-it" } });
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching refs.")).toBeTruthy();
  });

  it("moves the highlight with the arrow keys and picks it with Enter", async () => {
    const onPick = renderPicker();
    await screen.findByRole("listbox");
    act(() => {
      fireEvent.keyDown(search(), { key: "ArrowDown" });
      fireEvent.keyDown(search(), { key: "ArrowDown" });
    });
    expect(screen.getAllByRole("option")[2]!.getAttribute("aria-selected")).toBe("true");
    act(() => {
      fireEvent.keyDown(search(), { key: "Enter" });
    });
    expect(onPick).toHaveBeenCalledWith("dev");
  });

  it("wraps up from the first row, and Enter on Automatic picks no ref", async () => {
    const onPick = renderPicker("main");
    await screen.findByRole("listbox");
    act(() => {
      fireEvent.keyDown(search(), { key: "ArrowUp" });
    });
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]!.getAttribute("aria-selected")).toBe("true");
    act(() => {
      fireEvent.keyDown(search(), { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(search(), { key: "Enter" });
    });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("closes on Escape without picking", async () => {
    const onPick = renderPicker();
    await screen.findByRole("listbox");
    act(() => {
      fireEvent.keyDown(search(), { key: "Escape" });
    });
    await vi.waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("a paired row's switch takes the remote-tracking ref, and back", async () => {
    const onPick = renderPicker("main");
    await screen.findByRole("listbox");
    const toggle = screen.getByRole("switch", { name: "Use remote version of main" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(onPick).toHaveBeenLastCalledWith("origin/main");
    // Only paired rows have one; a remote-only row says so instead.
    expect(screen.queryByRole("switch", { name: /dev/ })).toBeNull();
    expect(screen.getByRole("img", { name: "Remote only" })).toBeTruthy();
  });

  it("reads the remote as on when it is the chosen ref, and clicking a row picks that ref", async () => {
    const onPick = renderPicker("origin/main");
    await screen.findByRole("listbox");
    const toggle = screen.getByRole("switch", { name: "Use remote version of main" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(onPick).toHaveBeenLastCalledWith("main");
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: /origin\/release/ }));
    });
    expect(onPick).toHaveBeenLastCalledWith("origin/release");
  });
});
