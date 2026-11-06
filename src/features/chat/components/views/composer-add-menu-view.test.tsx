// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerAddMenuView, type ComposerAddMenuViewProps } from "./composer-add-menu-view";

afterEach(cleanup);

function props(over: Partial<ComposerAddMenuViewProps> = {}): ComposerAddMenuViewProps {
  return {
    open: true,
    onOpenChange: () => {},
    disabled: false,
    hasProject: true,
    imageSupported: true,
    onAddFilesOrPhotos: () => {},
    onAttachMedia: () => {},
    onTakeScreenshot: () => {},
    github: {
      query: "",
      onQuery: () => {},
      onSearch: () => {},
      loading: false,
      results: null,
      cloned: [],
      isCloned: () => false,
      onOpen: () => {},
      onClone: () => {},
    },
    sessions: {
      query: "",
      onQuery: () => {},
      all: [],
      filtered: [],
      onOpen: () => {},
      onPick: () => {},
    },
    projects: { query: "", onQuery: () => {}, rows: [], onPick: () => {} },
    onAddMoreAgents: () => {},
    ...over,
  };
}

async function openProjectsSubmenu() {
  const trigger = screen.getByText("Reference project").closest("[role='menuitem']")!;
  await act(async () => {
    fireEvent.click(trigger);
  });
  return (await screen.findByPlaceholderText("Search projects…")) as HTMLInputElement;
}

describe("ComposerAddMenuView", () => {
  it("lists the attach actions, with the images wording only when images are supported", () => {
    const { rerender } = render(<ComposerAddMenuView {...props()} />);
    expect(screen.getByText("Add files or photos")).toBeTruthy();
    rerender(<ComposerAddMenuView {...props({ imageSupported: false })} />);
    expect(screen.getByText("Add files")).toBeTruthy();
  });

  it("keeps typed keys inside a submenu's search box", async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => outer(e.key)}>
        <ComposerAddMenuView {...props()} />
      </div>,
    );
    const input = await openProjectsSubmenu();
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(outer).not.toHaveBeenCalledWith("a");
    expect(outer).not.toHaveBeenCalledWith("ArrowDown");
  });

  it("lets Escape out of the search box, so it still closes the submenu", async () => {
    render(<ComposerAddMenuView {...props()} />);
    const input = await openProjectsSubmenu();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    await vi.waitFor(() => expect(screen.queryByPlaceholderText("Search projects…")).toBeNull());
  });

  it("never focuses a search box on its own", async () => {
    render(<ComposerAddMenuView {...props()} />);
    const input = await openProjectsSubmenu();
    expect(document.activeElement).not.toBe(input);
  });

  it("closes through the container when Add more agents is clicked", () => {
    const onAddMoreAgents = vi.fn();
    render(<ComposerAddMenuView {...props({ onAddMoreAgents })} />);
    fireEvent.click(screen.getByText("Add more agents"));
    expect(onAddMoreAgents).toHaveBeenCalledOnce();
  });
});
