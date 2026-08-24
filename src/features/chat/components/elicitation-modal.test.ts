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
    expect(f.choices).toEqual(["dev", "prod"]);
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
