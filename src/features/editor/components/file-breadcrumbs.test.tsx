// @vitest-environment happy-dom
/**
 * The file view's second row names the file once: its path as crumbs under
 * the tab that carries the icon. These pin what the crumbs say and do.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileBreadcrumbs, type FileBreadcrumbsProps } from "./file-breadcrumbs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@/features/icon-theme/components/file-icon", () => ({
  FileIcon: () => <span data-testid="file-icon" />,
}));

afterEach(cleanup);

function crumbs(overrides: Partial<FileBreadcrumbsProps> = {}) {
  const props: FileBreadcrumbsProps = {
    root: "/work/acme",
    projectName: "acme",
    relativePath: "src/components/button.tsx",
    trail: "src/components/button.tsx",
    onNavigate: vi.fn(),
    onOpenFile: vi.fn(),
    ...overrides,
  };
  render(<FileBreadcrumbs {...props} />);
  return props;
}

const labels = () =>
  [...document.querySelectorAll("[data-file-crumb]")].map((li) =>
    li.firstElementChild?.textContent?.trim(),
  );

describe("FileBreadcrumbs", () => {
  it("runs from the project to the file, the file current and without an icon", () => {
    crumbs();
    expect(labels()).toEqual(["acme", "src", "components", "button.tsx"]);
    const current = document.querySelector("[data-current-file-crumb='true']");
    expect(current?.textContent).toBe("button.tsx");
    expect(screen.queryByTestId("file-icon")).toBeNull();
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
  });

  it("walks to a folder crumb", () => {
    const props = crumbs();
    fireEvent.click(screen.getByRole("button", { name: "src/components" }));
    expect(props.onNavigate).toHaveBeenCalledWith("src/components");
  });

  it("keeps the deeper trail after walking up, and walks back down to the file", () => {
    const props = crumbs({ relativePath: "src" });
    expect(document.querySelector("[data-current-file-crumb='true']")?.textContent).toBe("src");
    expect(labels()).toEqual(["acme", "src", "components", "button.tsx"]);
    fireEvent.click(screen.getByRole("button", { name: "src/components/button.tsx" }));
    expect(props.onNavigate).toHaveBeenCalledWith("src/components/button.tsx");
  });

  it("offers each folder's contents from the chevron after it", () => {
    crumbs();
    expect(screen.getByRole("button", { name: "Browse acme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browse components" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse button.tsx" })).toBeNull();
  });

  it("carries the file's icon and unsaved dot where no tab names it", () => {
    crumbs({ identity: { path: "/work/acme/src/components/button.tsx", dirty: true } });
    expect(screen.getAllByTestId("file-icon")).toHaveLength(1);
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  });

  it("crumbs a file outside the project from the filesystem root, with no contents menus", () => {
    crumbs({ root: null, relativePath: "/tmp/notes/a.md", trail: "/tmp/notes/a.md" });
    expect(labels()).toEqual(["tmp", "notes", "a.md"]);
    expect(screen.queryByRole("button", { name: /^Browse / })).toBeNull();
  });
});
