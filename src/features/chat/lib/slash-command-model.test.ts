import { describe, expect, it } from "vitest";
import {
  argsHint,
  commandRequiresArgs,
  matchSegments,
  rankCommands,
  slashPickerPosition,
  SLASH_PICKER_WIDTH,
  wrapIndex,
  type SlashCommand,
} from "./slash-command-model";

const cmd = (name: string, description = "", signature = `/${name}`): SlashCommand => ({
  name,
  signature,
  description,
  handler: "passthrough",
});

describe("rankCommands", () => {
  const commands = [
    cmd("zeta", "mentions review in passing"),
    cmd("prereview"),
    cmd("review-pr"),
    cmd("review"),
    cmd("compact"),
  ];

  it("keeps the given order for an empty or blank query", () => {
    expect(rankCommands(commands, "")).toBe(commands);
    expect(rankCommands(commands, "   ")).toBe(commands);
  });

  it("ranks exact, then prefix, then substring, then description, and drops the rest", () => {
    expect(rankCommands(commands, "review").map((c) => c.name)).toEqual([
      "review",
      "review-pr",
      "prereview",
      "zeta",
    ]);
  });

  it("breaks ties alphabetically and ignores case", () => {
    const rows = rankCommands([cmd("init-b"), cmd("Init-a"), cmd("init-c")], "INIT");
    expect(rows.map((c) => c.name)).toEqual(["Init-a", "init-b", "init-c"]);
  });
});

describe("matchSegments", () => {
  it("is one unmatched segment for an empty query or no occurrence", () => {
    expect(matchSegments("hello", "")).toEqual([{ text: "hello", match: false }]);
    expect(matchSegments("hello", "  ")).toEqual([{ text: "hello", match: false }]);
    expect(matchSegments("hello", "zz")).toEqual([{ text: "hello", match: false }]);
  });

  it("marks every case-insensitive occurrence, and joins back to the text", () => {
    const segs = matchSegments("Run-ui-build", "u");
    expect(segs.filter((s) => s.match)).toHaveLength(3);
    expect(segs.map((s) => s.text).join("")).toBe("Run-ui-build");
  });

  it("keeps only `max` matches and folds the tail back in", () => {
    const segs = matchSegments("a u b u c u d", "u", 1);
    expect(segs.filter((s) => s.match)).toHaveLength(1);
    expect(segs.map((s) => s.text).join("")).toBe("a u b u c u d");
  });

  it("treats regex metacharacters literally", () => {
    expect(matchSegments("a.b axb", "a.b").filter((s) => s.match)).toEqual([
      { text: "a.b", match: true },
    ]);
    expect(matchSegments("f(x) fx", "(x)").filter((s) => s.match)).toEqual([
      { text: "(x)", match: true },
    ]);
  });
});

describe("wrapIndex", () => {
  it("steps and wraps at both ends", () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });

  it("leaves the index alone for an empty list", () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

describe("slashPickerPosition", () => {
  const viewport = { width: 1000, height: 800 };

  it("sits above the caret", () => {
    expect(slashPickerPosition({ x: 100, y: 700 }, viewport)).toEqual({ left: 100, bottom: 106 });
  });

  it("clamps the left edge inside the viewport at both sides", () => {
    expect(slashPickerPosition({ x: 0, y: 700 }, viewport).left).toBe(8);
    expect(slashPickerPosition({ x: 990, y: 700 }, viewport).left).toBe(
      1000 - SLASH_PICKER_WIDTH - 8,
    );
  });
});

describe("commandRequiresArgs / argsHint", () => {
  it("reads the agent's hint out of the signature, falling back to args", () => {
    const hinted = cmd("checkout", "", "/checkout <branch>");
    expect(commandRequiresArgs(hinted)).toBe(true);
    expect(argsHint(hinted)).toBe("branch");
    const bare = cmd("compact");
    expect(commandRequiresArgs(bare)).toBe(false);
    expect(argsHint(bare)).toBe("args");
  });
});
