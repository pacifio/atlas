import { describe, expect, it } from "vitest";

import { normalizeGuide } from "./pull-request-guide-normalize";
import {
  parseGeneratedGuide,
  parseStoredGuide,
  type GeneratedGuide,
  type GuideChange,
  type GuideStop,
} from "./pull-request-guide-types";

// The change `pr_guide_prepare` reports for: a.ts with two added hunks and a
// removal, gone.ts deleted, readme.md with one added line.
const change: GuideChange = {
  files: ["src/a.ts", "src/gone.ts", "docs/readme.md"],
  hunks: {
    "src/a.ts": {
      new: [
        [10, 14],
        [40, 59],
      ],
      old: [[30, 30]],
    },
    "src/gone.ts": { new: [], old: [[1, 20]] },
    "docs/readme.md": { new: [[3, 3]], old: [] },
  },
};

const stop = (overrides: Partial<GuideStop>): GuideStop => ({
  title: "Stop",
  summary: "",
  attention: null,
  excerpts: [],
  files: [],
  notes: [],
  questions: [],
  ...overrides,
});

const guide = (stops: GuideStop[]): GeneratedGuide => ({ stops });

const excerpt = (path: string, start: number, end: number, side: "new" | "old" = "new") => ({
  path,
  side,
  start,
  end,
  caption: "",
});

describe("normalizeGuide", () => {
  it("clamps excerpts to changed lines, merges touching ones, and caps their length", () => {
    const result = normalizeGuide(
      guide([
        stop({
          excerpts: [
            excerpt("src/a.ts", 5, 12),
            excerpt("src/a.ts", 13, 14),
            excerpt("src/a.ts", 38, 80),
            excerpt("src/a.ts", 20, 25),
            excerpt("src/gone.ts", 2, 8, "old"),
          ],
          files: [{ path: "docs/readme.md", note: "" }],
        }),
      ]),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([
      excerpt("src/a.ts", 10, 14),
      excerpt("src/a.ts", 40, 59),
      excerpt("src/gone.ts", 2, 8, "old"),
    ]);
    expect(result.stops[0]?.files).toEqual([{ path: "docs/readme.md" }]);
    expect(result.stops).toHaveLength(1);
  });

  it("drops notes outside the stop's remaining excerpts", () => {
    const result = normalizeGuide(
      guide([
        stop({
          excerpts: [excerpt("src/a.ts", 5, 12)],
          notes: [
            { path: "src/a.ts", line: 11, title: "Inside", body: "" },
            { path: "src/a.ts", line: 6, title: "Clamped away", body: "" },
            { path: "src/other.ts", line: 11, title: "Other file", body: "" },
          ],
        }),
      ]),
      change,
    );
    expect(result.stops[0]?.notes.map((note) => note.title)).toEqual(["Inside"]);
  });

  it("drops excerpts and files outside the change", () => {
    const result = normalizeGuide(
      guide([
        stop({
          excerpts: [excerpt("src/unchanged.ts", 1, 5)],
          files: [{ path: "src/a.ts", note: "edited" }, { path: "src/unchanged.ts" }],
        }),
      ]),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([]);
    expect(result.stops[0]?.files).toEqual([{ path: "src/a.ts", note: "edited" }]);
  });

  it("puts changed files the tour left out into a closing stop", () => {
    const result = normalizeGuide(
      guide([stop({ excerpts: [excerpt("src/a.ts", 10, 12)] })]),
      change,
    );
    expect(result.stops[result.stops.length - 1]).toMatchObject({
      title: "Other files",
      files: [{ path: "src/gone.ts" }, { path: "docs/readme.md" }],
    });
  });

  it("lets stops show different parts of one file and lists an unshown file once", () => {
    const result = normalizeGuide(
      guide([
        stop({
          title: "Shape",
          excerpts: [excerpt("src/a.ts", 10, 14)],
          files: [{ path: "docs/readme.md" }],
        }),
        stop({
          title: "Implementation",
          excerpts: [excerpt("src/a.ts", 40, 50)],
          files: [{ path: "src/a.ts" }, { path: "docs/readme.md" }, { path: "src/gone.ts" }],
        }),
      ]),
      change,
    );
    expect(result.stops.map((s) => [s.title, s.excerpts.map((e) => e.start), s.files])).toEqual([
      ["Shape", [10], [{ path: "docs/readme.md" }]],
      ["Implementation", [40], [{ path: "src/gone.ts" }]],
    ]);
  });
});

describe("parseGeneratedGuide", () => {
  it("reads an answer wrapped in a fence and prose", () => {
    const text = [
      "Here is the tour.",
      "```json",
      JSON.stringify({
        stops: [
          {
            title: "The shape",
            summary: "s",
            attention: { kind: "risk", note: "n" },
            excerpts: [{ path: "a.ts", side: "new", start: 1, end: 3, caption: "" }],
            files: [{ path: "b.ts", note: "" }],
            notes: [{ path: "a.ts", line: 2, title: "t", body: "b" }],
            questions: ["Why?"],
          },
        ],
      }),
      "```",
    ].join("\n");
    const parsed = parseGeneratedGuide(text);
    expect(parsed?.stops[0]).toMatchObject({
      title: "The shape",
      attention: { kind: "risk", note: "n" },
      files: [{ path: "b.ts" }],
      questions: ["Why?"],
    });
  });

  it("drops malformed fields rather than trusting them", () => {
    const parsed = parseGeneratedGuide(
      JSON.stringify({
        stops: [
          {
            title: "x",
            attention: { kind: "nonsense", note: "n" },
            excerpts: [
              { path: "a.ts", side: "sideways", start: 1, end: 2 },
              { path: "", start: 1 },
            ],
            notes: [{ path: "a.ts", line: -1, title: "t" }],
          },
        ],
      }),
    );
    expect(parsed?.stops[0]).toMatchObject({ attention: null, excerpts: [], notes: [] });
  });

  it("refuses an answer with no stops", () => {
    expect(parseGeneratedGuide("I could not read the change.")).toBeNull();
    expect(parseGeneratedGuide('{"tour": []}')).toBeNull();
  });
});

describe("parseStoredGuide", () => {
  it("needs the head it was written for", () => {
    expect(parseStoredGuide({ stops: [] })).toBeNull();
    expect(parseStoredGuide({ headSha: "abc1234", stops: [], agent: "codex" })).toMatchObject({
      headSha: "abc1234",
      agent: "codex",
    });
  });
});
