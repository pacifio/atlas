// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/github/lib/github-api", () => ({
  listClonedRepos: vi.fn(async () => []),
  searchGithub: vi.fn(async () => []),
}));
vi.mock("../lib/mentions", () => ({
  listPastSessions: vi.fn(async () => []),
  searchMentions: vi.fn(async () => []),
}));
vi.mock("@/features/settings/lib/open-settings", () => ({ openSettingsSection: vi.fn() }));

import { ComposerAddMenu } from "./composer-add-menu";

afterEach(cleanup);

const noop = () => {};
function renderMenu() {
  return render(
    <ComposerAddMenu
      projectPath="/p"
      imageSupported
      onAddFilesOrPhotos={noop}
      onAttachMedia={noop}
      onTakeScreenshot={noop}
      onCloneRepo={noop}
      onPickSession={noop}
      onPickProject={noop}
    />,
  );
}

const trigger = () => screen.getByRole("button", { name: /Attach files/ });

describe("ComposerAddMenu", () => {
  it("announces itself when it opens, so the other composer menus close", async () => {
    const heard = vi.fn();
    const on = (e: Event) => heard((e as CustomEvent<string>).detail);
    window.addEventListener("atlas:composer-menu-open", on);
    renderMenu();
    await act(async () => {
      fireEvent.click(trigger());
    });
    window.removeEventListener("atlas:composer-menu-open", on);
    expect(heard).toHaveBeenCalledWith("add");
    expect(screen.getByText("Attach media")).toBeTruthy();
  });

  it("closes when another composer menu opens", async () => {
    renderMenu();
    await act(async () => {
      fireEvent.click(trigger());
    });
    expect(screen.queryByText("Attach media")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "options" }));
    });
    await vi.waitFor(() => expect(screen.queryByText("Attach media")).toBeNull());
  });
});
