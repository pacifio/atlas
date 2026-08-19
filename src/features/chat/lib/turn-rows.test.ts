import { describe, expect, it } from "vitest";

import { shortPath } from "./turn-rows";

// A tool-call row shows one path, and the reader uses it to tell one call from
// the next. Eliding to the last two segments collapsed distinct files onto the
// same label, which made a transcript of repeated reads impossible to read.

describe("shortPath", () => {
  it("keeps two files apart when only a middle segment differs", () => {
    const cersei = shortPath("crates/atlas-cersei/src/lib.rs");
    const agents = shortPath("crates/atlas-agents/src/lib.rs");
    expect(cersei).not.toEqual(agents);
    expect(cersei).toContain("atlas-cersei");
    expect(agents).toContain("atlas-agents");
  });

  it("always ends with the filename", () => {
    expect(shortPath("src/features/chat/lib/turn-rows.ts")).toMatch(/turn-rows\.ts$/);
    expect(shortPath("a/b/c/d/e/f/g.ts")).toMatch(/g\.ts$/);
  });

  it("leaves a short path alone", () => {
    expect(shortPath("src/lib.rs")).toBe("src/lib.rs");
    expect(shortPath("a/b/c.ts")).toBe("a/b/c.ts");
    expect(shortPath("README.md")).toBe("README.md");
  });

  it("tolerates leading and trailing slashes", () => {
    expect(shortPath("/crates/atlas-cersei/src/lib.rs")).toBe("crates/atlas-cersei/…/lib.rs");
  });
});
