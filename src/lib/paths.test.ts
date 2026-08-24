import { describe, expect, it } from "vitest";
import { shortPath, tildePath } from "./paths";

describe("tildePath", () => {
  it.each([
    ["macOS home", "/Users/alice/projects/atlas/src/foo.ts", "~/projects/atlas/src/foo.ts"],
    ["Linux home", "/home/alice/.zshrc", "~/.zshrc"],
    ["macOS home root file", "/Users/alice/.bashrc", "~/.bashrc"],
  ])("rewrites a %s path to ~/...", (_label, input, expected) => {
    expect(tildePath(input)).toBe(expected);
  });

  it.each([
    ["a relative path", "src/lib/paths.ts"],
    ["a non-home absolute path", "/etc/profile"],
    ["a bare home directory with nothing after it", "/Users/alice"],
  ])("leaves %s unchanged", (_label, input) => {
    expect(tildePath(input)).toBe(input);
  });
});

describe("shortPath", () => {
  it("keeps only the last two segments of a long path", () => {
    expect(shortPath("/Users/alice/projects/atlas/src/foo.ts")).toBe("src/foo.ts");
  });

  it("returns both segments unchanged when there are exactly two", () => {
    expect(shortPath("src/foo.ts")).toBe("src/foo.ts");
  });

  it("returns a single segment unchanged, without a leading slash", () => {
    expect(shortPath("foo.ts")).toBe("foo.ts");
  });

  it("ignores a trailing slash", () => {
    expect(shortPath("/Users/alice/projects/atlas/src/")).toBe("atlas/src");
  });

  it("ignores a leading slash on an otherwise two-segment path", () => {
    expect(shortPath("/src/foo.ts")).toBe("src/foo.ts");
  });
});
