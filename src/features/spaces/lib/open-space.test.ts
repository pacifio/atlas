import { describe, expect, it } from "vitest";
import type { SpacePage } from "./spaces-api";
import { landingPage } from "./open-space";

const row = (id: string, kind: "page" | "folder"): SpacePage => ({
  id,
  kind,
  name: id,
  icon: null,
  parent_id: null,
  sort: 0,
  created_at: 0,
  updated_at: 0,
});

const pages = [row("f-docs", "folder"), row("p-first", "page"), row("p-arch", "page")];

describe("the page a canvas lands on when it connects", () => {
  it("is the page asked for from outside the canvas, over the remembered one", () => {
    expect(landingPage(pages, "p-first", "p-arch")).toBe("p-arch");
  });

  it("is the remembered page when nothing was asked, or the ask is not a page in the tree", () => {
    expect(landingPage(pages, "p-arch", null)).toBe("p-arch");
    expect(landingPage(pages, "p-arch", "p-gone")).toBe("p-arch");
    expect(landingPage(pages, "p-arch", "f-docs")).toBe("p-arch");
  });

  it("is the first page otherwise, and none in a Space with no page", () => {
    expect(landingPage(pages, null, null)).toBe("p-first");
    expect(landingPage(pages, "f-docs", null)).toBe("p-first");
    expect(landingPage([row("f-docs", "folder")], null, null)).toBeNull();
  });
});
