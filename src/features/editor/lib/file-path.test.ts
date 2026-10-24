import { describe, expect, it } from "vitest";
import {
  breadcrumbPathOf,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbs,
  relativeToRoot,
  retainedBreadcrumbTrail,
  trailChildOf,
} from "./file-path";

describe("fileBreadcrumbs", () => {
  it("starts a project path at the project's own crumb", () => {
    expect(fileBreadcrumbs("acme-app", "src/components/button.tsx")).toEqual([
      { label: "acme-app", path: "", kind: "project" },
      { label: "src", path: "src", kind: "directory" },
      { label: "components", path: "src/components", kind: "directory" },
      { label: "button.tsx", path: "src/components/button.tsx", kind: "file" },
    ]);
    expect(fileBreadcrumbs("acme-app", "")).toEqual([
      { label: "acme-app", path: "", kind: "project" },
    ]);
  });

  it("starts host paths outside the project at the filesystem root", () => {
    expect(fileBreadcrumbs("acme-app", "/tmp/cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "cleanup", path: "/tmp/cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/cleanup/report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("acme-app", "C:\\Temp\\report.md")).toEqual([
      { label: "C:", path: "C:\\", kind: "directory" },
      { label: "Temp", path: "C:\\Temp", kind: "directory" },
      { label: "report.md", path: "C:\\Temp\\report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("acme-app", "\\\\server\\share\\report.md").map((c) => c.path)).toEqual([
      "\\\\server",
      "\\\\server\\share",
      "\\\\server\\share\\report.md",
    ]);
  });

  it("names a path with stray separators by its own crumb", () => {
    expect(breadcrumbPathOf("src//lib/")).toBe("src/lib");
  });
});

describe("fileBreadcrumbChildren", () => {
  const entries = [
    { path: "README.md", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src-old", kind: "directory" as const },
    { path: "src/index.ts", kind: "file" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/lib/file10.ts", kind: "file" as const },
    { path: "src/lib/file2.ts", kind: "file" as const },
    { path: "src-old/index.ts", kind: "file" as const },
  ];

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });

  it("orders numbered names naturally", () => {
    expect(fileBreadcrumbChildren(entries, "src/lib").map((c) => c.label)).toEqual([
      "file2.ts",
      "file10.ts",
    ]);
  });
});

describe("fileBreadcrumbParent", () => {
  it("walks up to the project root, and no further", () => {
    expect(fileBreadcrumbParent("src/lib")).toBe("src");
    expect(fileBreadcrumbParent("src")).toBe("");
    expect(fileBreadcrumbParent("")).toBeNull();
  });
});

describe("retainedBreadcrumbTrail", () => {
  it.each([
    // Walking up keeps the deeper path, all the way to the project root.
    ["apps/web/src", "apps/web", "apps/web/src"],
    ["apps/web/src", "", "apps/web/src"],
    // Walking back down inside the trail keeps it too.
    ["apps/web/src", "apps/web/src", "apps/web/src"],
    // Somewhere else starts over, including a sibling that shares a name prefix.
    ["apps/web/src", "apps/mobile", "apps/mobile"],
    ["src/lib", "src-old", "src-old"],
    ["apps/web", "apps/web/src/main.tsx", "apps/web/src/main.tsx"],
    // Project and host paths never share a trail.
    ["apps/web/src", "/tmp/report", "/tmp/report"],
    ["/tmp/report", "", ""],
    ["C:\\Temp\\a", "", ""],
    // Host folders outside the project keep their trail the same way.
    ["/Users/me/projects/scope", "/Users/me", "/Users/me/projects/scope"],
    ["/Users/me/projects/scope", "/Users/me/proj", "/Users/me/proj"],
    ["/Volumes/Work/a", "/Volumes/Work/a/", "/Volumes/Work/a"],
    ["C:\\Users\\me\\scope", "C:\\", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "C:\\Users", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "D:\\", "D:\\"],
    ["\\\\nas\\share\\docs\\notes", "\\\\nas\\share", "\\\\nas\\share\\docs\\notes"],
  ])("from trail %j to %j keeps %j", (trail, path, expected) => {
    expect(retainedBreadcrumbTrail(trail, path)).toBe(expected);
  });

  it("starts over when there is no trail yet", () => {
    expect(retainedBreadcrumbTrail(undefined, "src")).toBe("src");
  });
});

describe("trailChildOf", () => {
  it("names the entry of a folder that leads toward the trail", () => {
    expect(trailChildOf("src", "src/components/button.tsx")).toBe("components");
    expect(trailChildOf("", "src/components/button.tsx")).toBe("src");
    expect(trailChildOf("src/components/button.tsx", "src/components/button.tsx")).toBeNull();
    expect(trailChildOf("lib", "src/components/button.tsx")).toBeNull();
  });
});

describe("relativeToRoot", () => {
  it("is the path below a POSIX root", () => {
    expect(relativeToRoot("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(relativeToRoot("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(relativeToRoot("/a.ts", "/")).toBe("a.ts");
  });

  it("is the path below a Windows root, whichever separators either uses", () => {
    expect(relativeToRoot("C:\\work\\repo\\src\\a.ts", "C:\\work\\repo")).toBe("src/a.ts");
    expect(relativeToRoot("C:/work/repo/src/a.ts", "C:\\work\\repo")).toBe("src/a.ts");
  });

  it("is null outside the root, for the root itself, and for a sibling prefix", () => {
    expect(relativeToRoot("/repo", "/repo")).toBeNull();
    expect(relativeToRoot("/repo-two/a.ts", "/repo")).toBeNull();
    expect(relativeToRoot("/elsewhere/a.ts", "/repo")).toBeNull();
    expect(relativeToRoot("/repo/a.ts", "")).toBeNull();
  });
});
