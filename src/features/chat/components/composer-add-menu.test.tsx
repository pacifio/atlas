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

import { searchGithub } from "@/features/github/lib/github-api";
import type { GithubRepo } from "@/features/github/types";
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

  it("offers Add more agents as a menu item the arrow keys reach", async () => {
    renderMenu();
    await act(async () => {
      fireEvent.click(trigger());
    });
    expect(screen.getByRole("menuitem", { name: /Add more agents/ })).toBeTruthy();
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

  it("drops a GitHub search that lands after the menu was closed and reopened", async () => {
    let resolve!: (rows: GithubRepo[]) => void;
    vi.mocked(searchGithub).mockImplementationOnce(
      () => new Promise<GithubRepo[]>((r) => (resolve = r)),
    );
    renderMenu();
    const openGithub = async () => {
      await act(async () => {
        fireEvent.click(screen.getByText("Add from GitHub").closest("[role='menuitem']")!);
      });
      return (await screen.findByPlaceholderText(/Search GitHub repos/)) as HTMLInputElement;
    };

    await act(async () => {
      fireEvent.click(trigger());
    });
    const input = await openGithub();
    fireEvent.change(input, { target: { value: "swr" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(searchGithub).toHaveBeenCalledWith("swr");

    // Another composer menu takes over; then the + menu opens again.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "options" }));
    });
    await vi.waitFor(() => expect(screen.queryByText("Attach media")).toBeNull());
    await act(async () => {
      fireEvent.click(trigger());
    });
    await openGithub();

    await act(async () => {
      resolve([
        { full_name: "vercel/swr", description: "", stars: 1, clone_url: "" } as GithubRepo,
      ]);
    });
    expect(screen.getByText("Type a repo name and press Enter.")).toBeTruthy();
    expect(screen.queryByText("vercel/swr")).toBeNull();
  });
});
