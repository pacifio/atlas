import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("../lib/agents-api", () => ({ agents: {} }));

const { parseElicitationSchema, elicitationComplete } = await import("./elicitation-modal");

describe("parseElicitationSchema", () => {
  it("reads titles, descriptions and required-ness", () => {
    const [f] = parseElicitationSchema({
      type: "object",
      required: ["branch"],
      properties: {
        branch: { type: "string", title: "Branch name", description: "Where to push" },
      },
    });
    expect(f).toMatchObject({
      name: "branch",
      title: "Branch name",
      description: "Where to push",
      kind: "string",
      required: true,
    });
  });

  it("treats an enum as a choice list regardless of its declared type", () => {
    const [f] = parseElicitationSchema({
      properties: { env: { type: "string", enum: ["dev", "prod"] } },
    });
    expect(f.kind).toBe("enum");
    expect(f.choices).toEqual([
      { value: "dev", label: "dev" },
      { value: "prod", label: "prod" },
    ]);
  });

  it("labels a bare enum from the parallel enumNames", () => {
    const [f] = parseElicitationSchema({
      properties: { env: { type: "string", enum: ["dev"], enumNames: ["Development"] } },
    });
    expect(f.choices).toEqual([{ value: "dev", label: "Development" }]);
  });

  /// The bug behind the empty box: AskUserQuestion arrives as a titled `oneOf`,
  /// never a bare `enum`, so a parser that only reads `enum` renders the whole
  /// question as a naked text input with its options nowhere.
  it("reads choices from a titled oneOf", () => {
    const [f] = parseElicitationSchema({
      properties: {
        question_0: {
          type: "string",
          title: "Client layer",
          oneOf: [
            { const: "Rust", title: "Rust", description: "Socket in Rust" },
            { const: "TS", title: "TypeScript" },
          ],
        },
      },
    });
    expect(f.kind).toBe("enum");
    expect(f.multi).toBe(false);
    expect(f.choices).toEqual([
      { value: "Rust", label: "Rust", description: "Socket in Rust" },
      { value: "TS", label: "TypeScript", description: undefined },
    ]);
  });

  /// A `const` whose title differs is exactly why choices carry both: rendering
  /// the value would show the user an internal token like `retry_fallback`.
  it("keeps the wire value separate from the label", () => {
    const [f] = parseElicitationSchema({
      properties: {
        choice: { type: "string", oneOf: [{ const: "retry_fallback", title: "Retry with Opus" }] },
      },
    });
    expect(f.choices[0]).toMatchObject({ value: "retry_fallback", label: "Retry with Opus" });
  });

  it("reads a multi-select from array items.anyOf", () => {
    const [f] = parseElicitationSchema({
      properties: {
        question_0: { type: "array", items: { anyOf: [{ const: "a", title: "A" }] } },
      },
    });
    expect(f.kind).toBe("enum");
    expect(f.multi).toBe(true);
    expect(f.choices).toEqual([{ value: "a", label: "A", description: undefined }]);
  });

  it("marks the free-text companion so it is not shown as its own question", () => {
    const fields = parseElicitationSchema({
      properties: {
        question_0_custom: {
          type: "string",
          title: "Other",
          _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0" } },
        },
      },
    });
    expect(fields[0].customFor).toBe("question_0");
  });

  it("maps integer and number alike", () => {
    const fields = parseElicitationSchema({
      properties: { a: { type: "integer" }, b: { type: "number" } },
    });
    expect(fields.map((f) => f.kind)).toEqual(["number", "number"]);
  });

  it("reads booleans", () => {
    const [f] = parseElicitationSchema({ properties: { force: { type: "boolean" } } });
    expect(f.kind).toBe("boolean");
  });

  /// A field Atlas silently omitted would make a required request
  /// unanswerable, so an unrecognised type degrades to text rather than vanishing.
  it("falls back to a text input for an unrecognised type", () => {
    const [f] = parseElicitationSchema({ properties: { weird: { type: "tuple" } } });
    expect(f.kind).toBe("string");
  });

  it("falls back to the property name when no title is given", () => {
    const [f] = parseElicitationSchema({ properties: { some_key: { type: "string" } } });
    expect(f.title).toBe("some_key");
  });

  it("carries scalar defaults and ignores exotic ones", () => {
    const fields = parseElicitationSchema({
      properties: {
        a: { type: "string", default: "x" },
        b: { type: "boolean", default: true },
        c: { type: "string", default: { nested: 1 } },
      },
    });
    expect(fields.map((f) => f.default)).toEqual(["x", true, null]);
  });

  it("returns nothing for a schema with no properties", () => {
    expect(parseElicitationSchema(undefined)).toEqual([]);
    expect(parseElicitationSchema({})).toEqual([]);
    expect(parseElicitationSchema({ properties: "nonsense" })).toEqual([]);
  });
});

describe("elicitationComplete", () => {
  const field = (over: Partial<ReturnType<typeof parseElicitationSchema>[number]>) => ({
    name: "f",
    title: "F",
    description: null,
    kind: "string" as const,
    required: true,
    choices: [],
    multi: false,
    default: null,
    ...over,
  });

  it("blocks while a required field is empty", () => {
    expect(elicitationComplete([field({})], {})).toBe(false);
    expect(elicitationComplete([field({})], { f: "   " })).toBe(false);
  });

  it("allows once every required field has a value", () => {
    expect(elicitationComplete([field({})], { f: "main" })).toBe(true);
  });

  it("ignores optional fields entirely", () => {
    expect(elicitationComplete([field({ required: false })], {})).toBe(true);
  });

  /// `false` IS an answer. Treating an unchecked required checkbox as
  /// unanswered would make it impossible to submit "no".
  it("treats an unchecked required boolean as answered", () => {
    expect(elicitationComplete([field({ kind: "boolean" })], { f: false })).toBe(true);
  });

  it("accepts a numeric zero as an answer", () => {
    expect(elicitationComplete([field({ kind: "number" })], { f: 0 })).toBe(true);
  });
});
