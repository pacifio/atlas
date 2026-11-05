import { describe, expect, it } from "vitest";
import {
  fileChipTitle,
  inlineCodeFileTarget,
  inlineCodePathCandidate,
  isBundleName,
  isUnderRoot,
  linkFileTarget,
  resolveInProject,
  splitPosition,
} from "./file-links";

const ROOT = "/Users/dev/acme-app";

describe("inline code that names a project file", () => {
  it.each([
    ["src/lib/api.ts", `${ROOT}/src/lib/api.ts`, undefined],
    ["./src/lib/api.ts", `${ROOT}/src/lib/api.ts`, undefined],
    ["src/lib/api.ts:42", `${ROOT}/src/lib/api.ts`, 42],
    ["src/lib/api.ts:42:7", `${ROOT}/src/lib/api.ts`, 42],
    ["src/lib/api.ts#L10", `${ROOT}/src/lib/api.ts`, 10],
    ["api.ts:12", `${ROOT}/api.ts`, 12],
    [`${ROOT}/README.md`, `${ROOT}/README.md`, undefined],
    ["docker/Dockerfile", `${ROOT}/docker/Dockerfile`, undefined],
    ["src/a/../b/c.tsx", `${ROOT}/src/b/c.tsx`, undefined],
  ])("%s", (code, path, line) => {
    const target = inlineCodeFileTarget(code, ROOT);
    expect(target?.path).toBe(path);
    expect(target?.line).toBe(line);
  });

  it.each([
    ["a URL", "https://example.com/a.ts"],
    ["a scheme-less host", "github.com/acme/app.ts"],
    ["a version", "1.2.3"],
    ["a versioned name", "packages/react-19.0.1"],
    ["e.g.", "e.g."],
    ["i.e.", "i.e."],
    ["a glob", "src/**/*.ts"],
    ["a brace glob", "src/{a,b}.ts"],
    ["a bare word", "useState"],
    ["a bare file name", "package.json"],
    ["a sentence", "run src/a.ts now"],
    ["a folder", "src/lib/"],
    ["no extension", "src/lib/api"],
    ["a path outside the project", "/etc/hosts"],
    ["a relative path that climbs out", "../outside/x.ts"],
    ["a sibling project", "/Users/dev/acme-app-2/a.ts"],
    ["a host and port", "localhost:3000"],
    ["a file name and a port", "server.js:8080"],
    ["a file name and a five-digit port", "app.py:12345"],
    ["a line past any file", "src/a.ts:1234567"],
    ["a host with a TLD and port", "example.com:443"],
    ["a member access", "foo.bar"],
  ])("leaves %s as code", (_name, code) => {
    expect(inlineCodeFileTarget(code, ROOT)).toBeNull();
  });

  it("still reads a plausible line on a bare file name, and any line with a folder", () => {
    expect(inlineCodeFileTarget("api.ts:120", ROOT)?.line).toBe(120);
    expect(inlineCodeFileTarget("src/server.js:8080", ROOT)?.line).toBe(8080);
    expect(inlineCodeFileTarget("server.js:8080:3", ROOT)?.line).toBe(8080);
  });

  it("marks a bundle as a folder", () => {
    expect(inlineCodeFileTarget("build/Foo.app", ROOT)).toEqual({
      path: `${ROOT}/build/Foo.app`,
      folder: true,
    });
    expect(inlineCodeFileTarget("ios/App.xcodeproj", ROOT)?.folder).toBe(true);
    expect(linkFileTarget("build/Foo.app", ROOT)?.folder).toBe(true);
    expect(inlineCodeFileTarget("src/app.ts", ROOT)?.folder).toBe(false);
    expect(isBundleName("Foo.APP")).toBe(true);
    expect(isBundleName(".app")).toBe(false);
  });

  it("takes ~/ against the home the root sits in", () => {
    expect(inlineCodeFileTarget("~/acme-app/src/a.ts", ROOT)?.path).toBe(`${ROOT}/src/a.ts`);
    expect(inlineCodeFileTarget("~/.zshrc.d/x.sh", ROOT)).toBeNull();
  });

  it("is shape alone, before any root", () => {
    expect(inlineCodePathCandidate("src/a.ts:3")).toEqual({ path: "src/a.ts", line: 3 });
    expect(inlineCodePathCandidate("src/a.ts")).toEqual({ path: "src/a.ts" });
  });
});

describe("link destinations that name a project file", () => {
  it.each([
    ["src/lib/utils.ts", `${ROOT}/src/lib/utils.ts`, false],
    ["src/lib/utils.ts#L3", `${ROOT}/src/lib/utils.ts`, false],
    ["./docs/", `${ROOT}/docs`, true],
    [`file://${ROOT}/src/a.ts`, `${ROOT}/src/a.ts`, false],
    ["<src/My%20File.ts>", `${ROOT}/src/My File.ts`, false],
  ])("%s", (href, path, folder) => {
    const target = linkFileTarget(href, ROOT);
    expect(target?.path).toBe(path);
    expect(target?.folder).toBe(folder);
  });

  it.each([
    "https://example.com/a.ts",
    "mailto:dev@acme.dev",
    "#section",
    "//cdn.example.com/a.js",
    "/etc/hosts",
    "docs/page?x=1",
    "github.com/acme/app",
  ])("leaves %s alone", (href) => {
    expect(linkFileTarget(href, ROOT)).toBeNull();
  });
});

describe("helpers", () => {
  it("splits a position off either way it is written", () => {
    expect(splitPosition("a.ts:3:4")).toEqual({ path: "a.ts", line: 3, column: 4 });
    expect(splitPosition("a.ts#L9C2")).toEqual({ path: "a.ts", line: 9, column: 2 });
    expect(splitPosition("a.ts")).toEqual({ path: "a.ts" });
  });

  it("keeps a resolved path inside the root, or gives null", () => {
    expect(resolveInProject("src/../a.ts", ROOT)).toBe(`${ROOT}/a.ts`);
    expect(resolveInProject("../../x", ROOT)).toBeNull();
    expect(resolveInProject("a.ts", "/")).toBeNull();
  });

  it("titles a chip with the full path and position", () => {
    expect(fileChipTitle({ path: `${ROOT}/src/a.ts`, line: 4, column: 2, folder: false })).toBe(
      `${ROOT}/src/a.ts:4:2`,
    );
    expect(fileChipTitle({ path: `${ROOT}/src/a.ts`, folder: false })).toBe(`${ROOT}/src/a.ts`);
  });
});

describe("Windows paths", () => {
  const WIN = "C:\\Users\\me\\proj";

  it("resolves against a drive-letter root, in the root's separators", () => {
    expect(resolveInProject("src/a.ts", WIN)).toBe("C:\\Users\\me\\proj\\src\\a.ts");
    expect(resolveInProject("src\\a.ts", WIN)).toBe("C:\\Users\\me\\proj\\src\\a.ts");
    expect(resolveInProject("src/a.ts", "C:/Users/me/proj")).toBe("C:/Users/me/proj/src/a.ts");
    expect(inlineCodeFileTarget("src/lib/api.ts:7", WIN)).toEqual({
      path: "C:\\Users\\me\\proj\\src\\lib\\api.ts",
      line: 7,
      folder: false,
    });
  });

  it("takes an absolute path on either separator and drive-letter case", () => {
    expect(resolveInProject("c:/Users/me/proj/a.ts", WIN)).toBe("C:\\Users\\me\\proj\\a.ts");
    expect(resolveInProject("C:\\Users\\me\\other\\a.ts", WIN)).toBeNull();
    expect(resolveInProject("D:\\Users\\me\\proj\\a.ts", WIN)).toBeNull();
    expect(resolveInProject("..\\..\\x.ts", WIN)).toBeNull();
    expect(resolveInProject("a.ts", "C:\\")).toBeNull();
  });

  it("takes ~/ against a Windows home", () => {
    expect(resolveInProject("~/proj/a.ts", WIN)).toBe("C:\\Users\\me\\proj\\a.ts");
  });

  it("compares under a root whichever separators either side uses", () => {
    expect(isUnderRoot("C:/Users/me/proj/src/a.ts", WIN)).toBe(true);
    expect(isUnderRoot("c:\\Users\\me\\proj", "C:/Users/me/proj/")).toBe(true);
    expect(isUnderRoot("C:\\Users\\me\\proj-2\\a.ts", WIN)).toBe(false);
    expect(isUnderRoot("/p/src/a.ts", "/p")).toBe(true);
    expect(isUnderRoot("/p2/a.ts", "/p")).toBe(false);
  });
});
