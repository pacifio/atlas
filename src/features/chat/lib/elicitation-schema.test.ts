import { describe, expect, it } from "vitest";
import {
  elicitationAnswerContent,
  elicitationQuestionForm,
  parseElicitationSchema,
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
