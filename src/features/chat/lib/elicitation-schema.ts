// Projecting an ACP elicitation's `requestedSchema` into something renderable.
//
// An elicitation asks for DATA described by a JSON Schema. Two very different
// producers send one:
//
//   1. An MCP server asking for a branch name, an environment, a yes/no —
//      arbitrary primitive fields, rendered as a form.
//   2. An agent's AskUserQuestion, which is really multiple choice. The Claude
//      adapter renders it as a form elicitation whose fields are
//      `question_<n>` (a titled `oneOf` enum, or `type: "array"` +
//      `items.anyOf` for multiSelect) each followed by a `question_<n>_custom`
//      free-text companion marked with `_askUserQuestionCustomAnswer`.
//
// The whole point of the split below is (2): read as a plain form it is a pile
// of naked text inputs, because the choices live in `oneOf`/`anyOf` rather than
// `enum`. `elicitationQuestionForm` recognises that shape and hands it to the
// question card instead; anything it cannot represent returns null and falls
// back to the form.

import type { QuestionSpec } from "./questions";

/** One selectable value. `value` goes on the wire, `label` is what is read —
 *  they differ whenever the agent sends a titled `oneOf` (e.g. const
 *  `retry_fallback` titled "Retry with Opus"), so rendering the value would
 *  show the user an internal token. */
export interface ElicitationChoice {
  value: string;
  label: string;
  description?: string;
}

/** One field the agent wants filled, projected from its JSON schema. */
export interface ElicitationField {
  name: string;
  title: string;
  description: string | null;
  kind: "string" | "number" | "boolean" | "enum";
  required: boolean;
  /** `enum` only. */
  choices: ElicitationChoice[];
  /** `enum` only — the schema asked for an array, so several may be picked. */
  multi: boolean;
  /** Set when this field is the free-text companion to another field; holds
   *  that field's name. Rendered as part of its question, never on its own. */
  customFor?: string;
  default: string | number | boolean | null;
}

const CUSTOM_ANSWER_META_KEY = "_askUserQuestionCustomAnswer";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Read a list of choices out of the several shapes a schema can spell them.
 *
 *  `oneOf`/`anyOf` entries are `{const, title, description}`; a bare `enum` is
 *  a list of scalars, optionally labelled by the parallel `enumNames`. */
function readChoices(node: Record<string, unknown> | undefined): ElicitationChoice[] {
  if (!node) return [];
  const branches = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : null;
  if (branches) {
    const out: ElicitationChoice[] = [];
    for (const raw of branches) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      // `const` may legitimately be a number or boolean; the wire value is the
      // scalar itself, so stringify only for identity/labelling.
      if (b.const === undefined || b.const === null) continue;
      const value = String(b.const);
      out.push({ value, label: str(b.title) ?? value, description: str(b.description) });
    }
    return out;
  }
  if (Array.isArray(node.enum)) {
    const names = Array.isArray(node.enumNames) ? node.enumNames : null;
    return node.enum.map((e, i) => {
      const value = String(e);
      return { value, label: (names && str(names[i])) || value };
    });
  }
  return [];
}

/**
 * Project `requestedSchema` (a JSON Schema object) into renderable fields.
 *
 * Anything whose type is unrecognised falls back to a text input rather than
 * being dropped — a field the agent required but Atlas silently omitted would
 * make the whole request unanswerable.
 */
export function parseElicitationSchema(schema: unknown): ElicitationField[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const props = s.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: ElicitationField[] = [];
  for (const [name, rawProp] of Object.entries(props as Record<string, unknown>)) {
    if (!rawProp || typeof rawProp !== "object") continue;
    const prop = rawProp as Record<string, unknown>;
    const type = typeof prop.type === "string" ? prop.type : "";

    // An array of choices is a multi-select; the choices sit on `items`.
    const items =
      prop.items && typeof prop.items === "object"
        ? (prop.items as Record<string, unknown>)
        : undefined;
    const choices = readChoices(prop);
    const itemChoices = choices.length === 0 ? readChoices(items) : [];
    const allChoices = choices.length > 0 ? choices : itemChoices;

    const kind: ElicitationField["kind"] =
      allChoices.length > 0
        ? "enum"
        : type === "boolean"
          ? "boolean"
          : type === "number" || type === "integer"
            ? "number"
            : "string";

    const meta =
      prop._meta && typeof prop._meta === "object"
        ? (prop._meta as Record<string, unknown>)
        : undefined;
    const customMeta =
      meta && meta[CUSTOM_ANSWER_META_KEY] && typeof meta[CUSTOM_ANSWER_META_KEY] === "object"
        ? (meta[CUSTOM_ANSWER_META_KEY] as Record<string, unknown>)
        : undefined;

    out.push({
      name,
      title: str(prop.title) ?? name,
      description: typeof prop.description === "string" ? prop.description : null,
      kind,
      required: required.has(name),
      choices: allChoices,
      multi: type === "array",
      customFor: customMeta ? str(customMeta.questionId) : undefined,
      default:
        typeof prop.default === "string" ||
        typeof prop.default === "number" ||
        typeof prop.default === "boolean"
          ? prop.default
          : null,
    });
  }
  return out;
}

/**
 * Whether every required field has a usable answer.
 *
 * Booleans are always answered (false IS an answer), which is why they are
 * excluded rather than checked for truthiness — treating an unchecked required
 * checkbox as "unanswered" would make it impossible to submit "no".
 */
export function elicitationComplete(
  fields: ElicitationField[],
  values: Record<string, unknown>,
): boolean {
  return fields
    .filter((f) => f.required && f.kind !== "boolean")
    .every((f) => {
      const v = values[f.name];
      return v !== undefined && v !== null && String(v).trim().length > 0;
    });
}

/** Where one question's answer is written back on the wire. */
export interface ElicitationSlot {
  /** The schema field holding the selection. */
  key: string;
  /** Its free-text companion, when the agent offered one. */
  customKey?: string;
  multi: boolean;
  /** Labels are what the card tracks; this maps them back to wire values. */
  valueByLabel: Record<string, string>;
}

export interface ElicitationQuestionForm {
  questions: QuestionSpec[];
  slots: ElicitationSlot[];
}

/**
 * Read the elicitation as multiple-choice questions, or `null` when it is a
 * genuine form (a number, a free string, a boolean) that the question card
 * cannot represent — the caller then renders the form instead.
 *
 * `message` carries the question text when there is only one question; with
 * several, each field carries its own in `description`. That is the adapter's
 * contract, and following it is what stops a single question being printed
 * twice.
 */
export function elicitationQuestionForm(
  fields: ElicitationField[],
  message: string,
): ElicitationQuestionForm | null {
  const asked = fields.filter((f) => !f.customFor);
  if (asked.length === 0) return null;
  // Every asked field must be a choice list; one stray text/number field means
  // this is a form, not a set of questions.
  if (asked.some((f) => f.kind !== "enum" || f.choices.length === 0)) return null;

  const customByTarget = new Map<string, ElicitationField>();
  for (const f of fields) {
    if (f.customFor) customByTarget.set(f.customFor, f);
  }

  const questions: QuestionSpec[] = [];
  const slots: ElicitationSlot[] = [];
  for (const f of asked) {
    const custom = customByTarget.get(f.name);
    questions.push({
      header: f.title === f.name ? undefined : f.title,
      question: f.description ?? (asked.length === 1 ? message : f.title),
      multiSelect: f.multi,
      options: f.choices.map((c) => ({ label: c.label, description: c.description })),
    });
    slots.push({
      key: f.name,
      customKey: custom?.name,
      multi: f.multi,
      valueByLabel: Object.fromEntries(f.choices.map((c) => [c.label, c.value])),
    });
  }
  return { questions, slots };
}

/** One question's answer as the card reports it. */
export interface ElicitationAnswer {
  selected: string[];
  custom: string;
}

/**
 * Fold the card's answers back into elicitation content.
 *
 * A typed custom answer REPLACES the selection for its question — that is the
 * adapter's own precedence rule, and writing both would let a stale radio
 * silently win over what the user typed.
 */
export function elicitationAnswerContent(
  form: ElicitationQuestionForm,
  answers: ElicitationAnswer[],
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  form.slots.forEach((slot, i) => {
    const a = answers[i];
    if (!a) return;
    const custom = a.custom.trim();
    if (custom && slot.customKey) {
      content[slot.customKey] = custom;
      return;
    }
    const values = a.selected.map((label) => slot.valueByLabel[label] ?? label);
    if (values.length === 0) {
      // No pick, but text typed for a question with no custom field: the
      // selection field is a string, so send it there rather than dropping it.
      if (custom && !slot.multi) content[slot.key] = custom;
      return;
    }
    content[slot.key] = slot.multi ? values : values[0];
  });
  return content;
}
