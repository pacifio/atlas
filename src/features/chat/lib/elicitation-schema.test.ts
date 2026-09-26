import { describe, expect, it } from "vitest";
import {
  elicitationAnswerContent,
  elicitationComplete,
  elicitationQuestionForm,
  parseElicitationSchema,
  type ElicitationField,
} from "./elicitation-schema";

/** The shape `@agentclientprotocol/claude-agent-acp` actually emits for
 *  AskUserQuestion: a titled `oneOf` per question (or `array` + `items.anyOf`
 *  for multiSelect), each followed by a `_meta`-marked free-text companion.
 *  Verified against that package's own `askUserQuestionsToCreateRequest`. */
const askSchema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Client layer",
      oneOf: [
        { const: "Rust", title: "Rust", description: "Socket in Rust" },
        { const: "TypeScript", title: "TypeScript" },
      ],
    },
    question_0_custom: {
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
    },
    question_1: {
      type: "array",
      title: "Surfaces",
      description: "Which surfaces ship first?",
      items: {
        anyOf: [
          { const: "DMs", title: "DMs" },
          { const: "Calls", title: "Calls" },
        ],
      },
    },
    question_1_custom: {
      type: "string",
      title: "Other",
      _meta: { _askUserQuestionCustomAnswer: { questionId: "question_1" } },
    },
  },
};

describe("elicitationQuestionForm", () => {
  it("reads an AskUserQuestion elicitation as multiple choice", () => {
    const form = elicitationQuestionForm(
      parseElicitationSchema(askSchema),
      "Where should it live?",
    );
    expect(form).not.toBeNull();
    // Two questions — the `_custom` companions are absorbed, not shown as their
    // own "Other" questions.
    expect(form!.questions).toHaveLength(2);
    expect(form!.questions[0].header).toBe("Client layer");
    expect(form!.questions[0].options.map((o) => o.label)).toEqual(["Rust", "TypeScript"]);
    expect(form!.questions[1].multiSelect).toBe(true);
  });

  /// A single question carries its text in `message`; repeating it in the field
  /// description is what would print it twice.
  it("takes a lone question's text from the message", () => {
    const form = elicitationQuestionForm(
      parseElicitationSchema({
        type: "object",
        properties: { question_0: { type: "string", oneOf: [{ const: "a", title: "A" }] } },
      }),
      "Pick one?",
    );
    expect(form!.questions[0].question).toBe("Pick one?");
  });

  /// The question card cannot render a free string or a number, so a genuine
  /// MCP form must keep the dialog rather than be silently truncated.
  it("declines a form it cannot represent", () => {
    const fields = parseElicitationSchema({
      type: "object",
      properties: { branch: { type: "string" }, force: { type: "boolean" } },
    });
    expect(elicitationQuestionForm(fields, "Push where?")).toBeNull();
  });
});

describe("elicitationAnswerContent", () => {
  const form = elicitationQuestionForm(parseElicitationSchema(askSchema), "Where?")!;

  it("writes selections to their own fields, arrays for multiSelect", () => {
    const content = elicitationAnswerContent(form, [
      { selected: ["TypeScript"], custom: "" },
      { selected: ["DMs", "Calls"], custom: "" },
    ]);
    expect(content).toEqual({ question_0: "TypeScript", question_1: ["DMs", "Calls"] });
  });

  /// The adapter's own precedence rule: a typed answer replaces the selection.
  /// Sending both would let a stale radio win over what the user typed.
  it("sends a typed answer instead of the selection", () => {
    const content = elicitationAnswerContent(form, [
      { selected: ["Rust"], custom: "A separate worker" },
      { selected: [], custom: "" },
    ]);
    expect(content).toEqual({ question_0_custom: "A separate worker" });
  });

  /// Labels are what the card tracks, but `const` is what goes on the wire —
  /// they differ whenever the agent titles its options.
  it("maps labels back to their wire values", () => {
    const titled = elicitationQuestionForm(
      parseElicitationSchema({
        type: "object",
        properties: {
          choice: {
            type: "string",
            oneOf: [{ const: "retry_fallback", title: "Retry with Opus" }],
          },
        },
      }),
      "Retry?",
    )!;
    expect(
      elicitationAnswerContent(titled, [{ selected: ["Retry with Opus"], custom: "" }]),
    ).toEqual({ choice: "retry_fallback" });
  });

  it("leaves an unanswered question out entirely", () => {
    expect(
      elicitationAnswerContent(form, [
        { selected: [], custom: "" },
        { selected: [], custom: "" },
      ]),
    ).toEqual({});
  });
});

/** Atlas Agent's clarifying question (ADR-0013), exactly as the native seam
 *  raises it (`crates/atlas-native-agent/src/engine/questions.rs`): one titled
 *  `oneOf` per question under the engine's question id, and a `<id>__other`
 *  companion marked for it. The seam's own tests pin that output; this pins
 *  that the card reads it as a question, and that the content it sends back
 *  lands on the keys the seam reads. */
describe("Atlas Agent's clarifying question", () => {
  const nativeSchema = {
    type: "object",
    properties: {
      which_comment: {
        type: "string",
        title: "Comment",
        description: "Which comment should I resolve?",
        oneOf: [
          { const: "The first one", title: "The first one", description: "Only the oldest" },
          { const: "All four", title: "All four", description: "Every open comment" },
        ],
      },
      which_comment__other: {
        type: "string",
        title: "Other",
        _meta: { _askUserQuestionCustomAnswer: { questionId: "which_comment" } },
      },
    },
  };
  const form = elicitationQuestionForm(
    parseElicitationSchema(nativeSchema),
    "Which comment should I resolve?",
  );

  it("renders on the question card with its options, not the form dialog", () => {
    expect(form).not.toBeNull();
    expect(form!.questions).toHaveLength(1);
    expect(form!.questions[0].header).toBe("Comment");
    expect(form!.questions[0].question).toBe("Which comment should I resolve?");
    expect(form!.questions[0].options.map((o) => o.label)).toEqual(["The first one", "All four"]);
  });

  it("answers a pick under the engine's question id", () => {
    expect(elicitationAnswerContent(form!, [{ selected: ["All four"], custom: "" }])).toEqual({
      which_comment: "All four",
    });
  });

  it("answers Other on the companion the seam reads", () => {
    expect(
      elicitationAnswerContent(form!, [{ selected: [], custom: "only the one from Priya" }]),
    ).toEqual({ which_comment__other: "only the one from Priya" });
  });
});

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
  const field = (over: Partial<ElicitationField>) => ({
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
