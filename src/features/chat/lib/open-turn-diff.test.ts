import { describe, expect, it } from "vitest";
import { isAbsolutePath, joinPath, toRepoRelative } from "./open-turn-diff";

describe("toRepoRelative", () => {
  it("strips the repo root from a POSIX path", () => {
    expect(toRepoRelative("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(toRepoRelative("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(toRepoRelative("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts");
    // POSIX is case-sensitive.
    expect(toRepoRelative("/Repo/a.ts", "/repo")).toBe("/Repo/a.ts");
  });

  it("matches a Windows path whatever its separators and drive case", () => {
    expect(toRepoRelative("C:\\Work\\app\\src\\a.ts", "C:\\Work\\app")).toBe("src/a.ts");
    expect(toRepoRelative("c:/work/app/src/a.ts", "C:\\Work\\app")).toBe("src/a.ts");
    expect(toRepoRelative("C:\\Work\\app\\src\\a.ts", "c:/work/app/")).toBe("src/a.ts");
    expect(toRepoRelative("D:\\other\\a.ts", "C:\\Work\\app")).toBe("D:/other/a.ts");
  });
});

describe("isAbsolutePath", () => {
  it("knows POSIX, drive-letter and UNC paths", () => {
    expect(isAbsolutePath("/repo/a.ts")).toBe(true);
    expect(isAbsolutePath("C:\\repo\\a.ts")).toBe(true);
    expect(isAbsolutePath("c:/repo/a.ts")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share\\a.ts")).toBe(true);
    expect(isAbsolutePath("src/a.ts")).toBe(false);
    expect(isAbsolutePath("src\\a.ts")).toBe(false);
  });
});

describe("joinPath", () => {
  it("joins in the root's own separator", () => {
    expect(joinPath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(joinPath("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(joinPath("C:\\Work\\app", "src/a.ts")).toBe("C:\\Work\\app\\src\\a.ts");
    expect(joinPath("C:/Work/app", "src/a.ts")).toBe("C:/Work/app/src/a.ts");
  });
});
