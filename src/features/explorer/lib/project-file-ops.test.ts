import { describe, expect, it } from "vitest";
import {
  absoluteOf,
  entryNameError,
  freeName,
  intoItselfError,
  relativeTo,
} from "./project-file-ops";

describe("entryNameError", () => {
  it("accepts a plain name, dotfiles and spaces", () => {
    for (const name of ["a.ts", ".env", "my notes.md", "..hidden", "a..b"]) {
      expect(entryNameError(name)).toBeNull();
    }
  });

  it("refuses names that are not one entry in the folder", () => {
    for (const name of ["", "  ", ".", "..", "a/b", "../x", "a\\b", "a\u0000b", "a\nb"]) {
      expect(entryNameError(name)).not.toBeNull();
    }
  });
});

describe("intoItselfError", () => {
  it("refuses a folder into itself or below it", () => {
    expect(intoItselfError("/p/src", "/p/src")).not.toBeNull();
    expect(intoItselfError("/p/src", "/p/src/lib")).not.toBeNull();
  });

  it("allows a sibling that shares a prefix, and the parent", () => {
    expect(intoItselfError("/p/src", "/p/src-old")).toBeNull();
    expect(intoItselfError("/p/src", "/p")).toBeNull();
  });
});

describe("freeName", () => {
  it("keeps a free name and suffixes a taken one before the extension", () => {
    expect(freeName("a.ts", new Set())).toBe("a.ts");
    expect(freeName("a.ts", new Set(["a.ts"]))).toBe("a copy.ts");
    expect(freeName("a.ts", new Set(["a.ts", "a copy.ts"]))).toBe("a copy 2.ts");
  });

  it("treats a leading dot as part of the stem", () => {
    expect(freeName(".env", new Set([".env"]))).toBe(".env copy");
  });
});

describe("relativeTo / absoluteOf", () => {
  it("maps inside paths and refuses outside ones", () => {
    expect(relativeTo("/p", "/p")).toBe("");
    expect(relativeTo("/p", "/p/a/b")).toBe("a/b");
    expect(relativeTo("/p", "/pp/a")).toBeNull();
    expect(relativeTo("/p", "/q")).toBeNull();
  });

  it("round-trips", () => {
    expect(absoluteOf("/p", "")).toBe("/p");
    expect(absoluteOf("/p", relativeTo("/p", "/p/a/b")!)).toBe("/p/a/b");
  });
});
