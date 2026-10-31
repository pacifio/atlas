import { describe, expect, it } from "vitest";
import { liveThought, thoughtHeadline } from "./thought-headline";

describe("thoughtHeadline", () => {
  it("reads the newest section's bold heading", () => {
    const md =
      "**Reading the store**\n\nIt keeps deltas.\n\n**Checking the cache key**\n\nThe key holds ids.";
    expect(thoughtHeadline(md)).toBe("Checking the cache key");
    expect(thoughtHeadline("**Reading the store**\nIt keeps deltas.")).toBe("Reading the store");
  });

  it("takes the first sentence when there is no heading", () => {
    expect(thoughtHeadline("I should check `turn-rows.ts` first. Then the view.")).toBe(
      "I should check turn-rows.ts first.",
    );
  });

  it("keeps a sentence still being written whole", () => {
    expect(thoughtHeadline("Looking at how the [store](x) batches")).toBe(
      "Looking at how the store batches",
    );
  });

  it("strips list and heading markers and emphasis", () => {
    expect(thoughtHeadline("- *Maybe* the ~~old~~ path is **wrong**. Or not.")).toBe(
      "Maybe the old path is wrong.",
    );
  });

  it("is null for whitespace", () => {
    expect(thoughtHeadline("  \n\n ")).toBeNull();
  });
});

describe("thoughtHeadline on awkward reasoning", () => {
  it("keeps the previous thought while a new paragraph has barely begun", () => {
    expect(thoughtHeadline("Checked the store first.\n\nI")).toBe("Checked the store first.");
  });

  it("skips code blocks", () => {
    expect(thoughtHeadline("The cache needs a key.\n\n```ts\nconst a = 1;\n```")).toBe(
      "The cache needs a key.",
    );
  });

  it("does not end a sentence at an abbreviation", () => {
    expect(thoughtHeadline("Let me look at e.g. the file. Then more.")).toBe(
      "Let me look at e.g. the file.",
    );
  });

  it("strips a long link in a heading instead of cutting it mid-URL", () => {
    const url = `https://example.com/${"a".repeat(500)}`;
    expect(thoughtHeadline(`**Reading [the store](${url})**`)).toBe("Reading the store");
  });

  it("caps a long heading", () => {
    expect(thoughtHeadline(`**${"word ".repeat(200)}**`)!.length).toBeLessThanOrEqual(400);
  });

  it("stays fast on bracket-heavy text", () => {
    const nasty = "[".repeat(20_000) + "[a](".repeat(5_000);
    const t0 = performance.now();
    thoughtHeadline(nasty);
    expect(performance.now() - t0).toBeLessThan(20);
  });
});

describe("thoughtHeadline before there is anything to show", () => {
  it("is null rather than empty for a bare `**` or an empty heading", () => {
    expect(thoughtHeadline("**")).toBeNull();
    expect(thoughtHeadline("** **\n")).toBeNull();
  });
});

describe("liveThought", () => {
  it("is the body under the newest heading", () => {
    expect(liveThought("**Reading**\n\nOld.\n\n**Checking the cache**\n\nThe key is `id`.")).toBe(
      "The key is id.",
    );
  });
  it("is the newest paragraph without headings, and nothing before a body", () => {
    expect(liveThought("First idea.\n\nSecond, longer idea about the store.")).toBe(
      "Second, longer idea about the store.",
    );
    expect(liveThought("**Planning**\n")).toBeNull();
  });
});
