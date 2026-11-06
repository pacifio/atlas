// The palette's "Add project" flow and the project badges' icons.
//
// `project_icon` answers an icon for one seeded project only, so the
// sidebar shows a favicon beside the monograms of the rest. The folder
// browser walks a small fake tree, and the GitHub CLI reads as installed
// but signed out, so the "Setup required" path is the one on screen.

import type { MockHandlers } from "../types";

const HOME = "/Users/dev";

const TREE: Record<string, string[]> = {
  [HOME]: ["Applications", "Desktop", "Developer", "Documents", "Downloads", "Movies", "Music"],
  [`${HOME}/Developer`]: ["acme-app", "acme-platform-migration-experiments", "scratch"],
  [`${HOME}/Developer/acme-app`]: ["docs", "public", "src"],
};

const FAVICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="royalblue"/><path d="M4 11.5 8 4l4 7.5H4z" fill="white"/></svg>`,
  );

function absolute(path: string): string {
  const expanded = path === "~" ? HOME : path.replace(/^~\//, `${HOME}/`);
  return expanded.replace(/\/+$/, "") || "/";
}

export const projectSourcesHandlers: MockHandlers = {
  project_icon: (a) =>
    typeof a.projectPath === "string" && a.projectPath.endsWith("/acme-app") ? FAVICON : null,
  project_sources_info: () => ({
    path: `${HOME}/.atlas/projects`,
    gh: "signedOut",
    githubLogin: null,
    installer: "brew",
  }),
  project_browse: (a) => {
    const path = absolute(String(a.path ?? "~"));
    const cut = path.lastIndexOf("/");
    return {
      path,
      parent: path === "/" ? null : path.slice(0, cut) || "/",
      directories: TREE[path] ?? [],
    };
  },
  project_create: (a) => ({ path: `${HOME}/.atlas/projects/${String(a.name)}`, warning: null }),
  project_clone: (a) =>
    `${HOME}/.atlas/projects/${String(a.url)
      .split("/")
      .pop()
      ?.replace(/\.git$/, "")}`,
};
