// @vitest-environment happy-dom
//
// The project picker is the sidebar's one way to remove a project: its menu
// offers "Remove <open project> from Atlas", which hands that project to the
// caller, and the store-wired picker sends it to `closeProject`, the existing
// teardown. With no project open there is nothing to remove, so the item is
// absent.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/organisations/components/org-switcher", () => ({
  ORG_MENU_POPUP_CLASS: "",
  OrgAvatar: () => null,
  useOrgMenu: () => ({ active: null, panel: () => null, reset: () => {}, dialogs: null }),
}));
vi.mock("@/features/keybindings/lib/use-action-shortcut", () => ({
  useActionShortcut: () => null,
}));
vi.mock("@/features/projects/lib/org-scope", () => ({
  useActiveOrgProjects: () => [
    { id: "atlas", name: "atlas", path: "/repos/atlas" },
    { id: "server", name: "server", path: "/repos/server" },
  ],
}));
vi.mock("@/features/chat/components/import-threads-modal", () => ({
  ImportThreadsModal: () => null,
}));

import { useProjectStore } from "@/features/projects/stores/project-store";
import { ProjectPicker, SidebarProjectPicker } from "./project-picker";
import type { SidebarProject } from "../lib/sidebar-sessions";

const atlas: SidebarProject = { id: "atlas", name: "atlas", path: "/repos/atlas" };
const server: SidebarProject = { id: "server", name: "server", path: "/repos/server" };

function mount(activeProjectId: string | null) {
  const onRemoveProject = vi.fn();
  render(
    <ProjectPicker
      projects={[atlas, server]}
      activeProjectId={activeProjectId}
      onSwitch={() => {}}
      onProjectSettings={() => {}}
      onRemoveProject={onRemoveProject}
      onImportSessions={() => {}}
    />,
  );
  return onRemoveProject;
}

async function openMenu(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("menu");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectPicker remove project", () => {
  it("removes the open project from Atlas", async () => {
    const onRemoveProject = mount("atlas");
    await openMenu(/Project: atlas/);

    // The label says the folder on disk stays: removing only forgets it.
    const item = screen.getByRole("menuitem", { name: /Remove atlas from Atlas/ });
    expect(item.textContent).toContain("Keeps files");
    fireEvent.click(item);

    expect(onRemoveProject).toHaveBeenCalledTimes(1);
    expect(onRemoveProject).toHaveBeenCalledWith(atlas);
  });

  it("offers no remove item when no project is open", async () => {
    mount(null);
    await openMenu(/Open a project/);

    expect(screen.queryByRole("menuitem", { name: /from Atlas/ })).toBeNull();
  });

  it("sends the open project to the store's closeProject", async () => {
    const closeProject = vi
      .spyOn(useProjectStore.getState().actions, "closeProject")
      .mockResolvedValue();
    useProjectStore.setState({ activeProjectId: "server" });
    render(<SidebarProjectPicker />);
    await openMenu(/Project: server/);

    fireEvent.click(screen.getByRole("menuitem", { name: /Remove server from Atlas/ }));

    expect(closeProject).toHaveBeenCalledWith("server");
  });
});
