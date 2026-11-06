/**
 * `when` expressions: the condition a shortcut fires under. Variables joined with `!`, `&&`, `||` and parentheses —
 * `!terminalFocus`, `chatFocus && !inputFocus`. Empty means "always".
 *
 * Each action has a default expression (its registry context), and a profile
 * may replace it (`KeybindingProfile.when`). The dispatchers evaluate the
 * expression against `liveWhenContext()` on every keydown.
 *
 * A focus-scoped action's handler lives in its own panel, so its expression
 * can only narrow where it fires: the panel's own variable is taken as true
 * when the panel asks (`evaluateWhen`'s `assume`). `neverMatches` is what lets
 * the editor say so when an expression points somewhere the action can't go.
 */

import { WHEN_LABELS, type When } from "./actions";

export type WhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: WhenNode }
  | { type: "and"; left: WhenNode; right: WhenNode }
  | { type: "or"; left: WhenNode; right: WhenNode };

/** Variables that say which surface has the keyboard. At most one is true at
 *  a time, which is what makes `terminalFocus && chatFocus` impossible. */
export const SURFACE_FOCUS_VARIABLES = [
  "terminalFocus",
  "chatFocus",
  "editorFocus",
  "knowledgeFocus",
  "pdfFocus",
  "canvasFocus",
  "browserFocus",
  "diffFocus",
  "pullRequestFocus",
] as const;

/** Every variable Atlas provides, in the order the editor lists them. */
export const WHEN_VARIABLES: readonly string[] = [
  ...SURFACE_FOCUS_VARIABLES,
  "inputFocus",
  "knowledgeOpen",
  "modelPickerOpen",
  "isMac",
  "isWindows",
  "isLinux",
  "true",
  "false",
];

const KNOWN = new Set(WHEN_VARIABLES);

/** What each variable means, in the words the editor shows under it. */
export const WHEN_VARIABLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  terminalFocus: "The terminal has the keyboard",
  chatFocus: "A chat is the active tab",
  editorFocus: "The code editor is the active tab",
  knowledgeFocus: "Knowledge is the active tab",
  pdfFocus: "A PDF is the active tab",
  canvasFocus: "A canvas or space is the active tab",
  browserFocus: "The browser is the active tab",
  diffFocus: "The review diff is the active tab",
  pullRequestFocus: "A pull request is the active tab",
  inputFocus: "You're typing in a text field",
  knowledgeOpen: "Knowledge is open",
  modelPickerOpen: "The model picker has focus",
  isMac: "Running on macOS",
  isWindows: "Running on Windows",
  isLinux: "Running on Linux",
  true: "Always",
  false: "Never",
};

/** One-click conditions for the editor's empty state: what people reach for
 *  most, in plain words. */
export const WHEN_SUGGESTIONS: readonly { label: string; expression: string }[] = [
  { label: "Not in the terminal", expression: "!terminalFocus" },
  { label: "Not while typing", expression: "!inputFocus" },
  { label: "Only in a chat", expression: "chatFocus" },
  { label: "Only in the editor", expression: "editorFocus" },
];

/** What a new condition in the editor starts as. */
export const DEFAULT_WHEN_VARIABLE = "terminalFocus";

export type WhenContext = Readonly<Record<string, boolean>>;

const MAX_DEPTH = 32;

type Token =
  | { type: "identifier"; value: string }
  | { type: "not" | "and" | "or" | "lparen" | "rparen" };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const c = expression[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (expression.startsWith("&&", i)) {
      tokens.push({ type: "and" });
      i += 2;
    } else if (expression.startsWith("||", i)) {
      tokens.push({ type: "or" });
      i += 2;
    } else if (c === "!") {
      tokens.push({ type: "not" });
      i += 1;
    } else if (c === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
    } else if (c === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
    } else {
      const id = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(i));
      if (!id) return null;
      tokens.push({ type: "identifier", value: id[0] });
      i += id[0].length;
    }
  }
  return tokens;
}

/** Parse a non-empty expression; null when it isn't one. `||` binds looser
 *  than `&&`, and `!` binds tightest. */
export function parseWhen(expression: string): WhenNode | null {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const primary = (depth: number): WhenNode | null => {
    if (depth > MAX_DEPTH) return null;
    const token = tokens[index];
    if (!token) return null;
    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }
    if (token.type === "lparen") {
      index += 1;
      const node = or(depth + 1);
      if (!node || tokens[index]?.type !== "rparen") return null;
      index += 1;
      return node;
    }
    return null;
  };

  const unary = (depth: number): WhenNode | null => {
    let nots = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      if (++nots > MAX_DEPTH) return null;
    }
    let node = primary(depth);
    if (!node) return null;
    while (nots-- > 0) node = { type: "not", node };
    return node;
  };

  const and = (depth: number): WhenNode | null => {
    let left = unary(depth);
    while (left && tokens[index]?.type === "and") {
      index += 1;
      const right = unary(depth);
      left = right ? { type: "and", left, right } : null;
    }
    return left;
  };

  const or = (depth: number): WhenNode | null => {
    let left = and(depth);
    while (left && tokens[index]?.type === "or") {
      index += 1;
      const right = and(depth);
      left = right ? { type: "or", left, right } : null;
    }
    return left;
  };

  const ast = or(0);
  return ast && index === tokens.length ? ast : null;
}

export type WhenDraft = { ok: true; value: WhenNode | undefined } | { ok: false; message: string };

/** The editor's text field: empty is "always", anything else must parse. */
export function parseWhenDraft(expression: string): WhenDraft {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const value = parseWhen(trimmed);
  return value
    ? { ok: true, value }
    : { ok: false, message: "Use variables with !, &&, ||, and parentheses." };
}

/** The canonical text of an expression; "" for none. */
export function whenToExpression(node: WhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrap(node.node)}`;
    case "and":
      return `${wrap(node.left)} && ${wrap(node.right)}`;
    case "or":
      return `${wrap(node.left)} || ${wrap(node.right)}`;
  }
}

function wrap(node: WhenNode): string {
  return node.type === "identifier" || node.type === "not"
    ? whenToExpression(node)
    : `(${whenToExpression(node)})`;
}

export function evaluateWhen(node: WhenNode | undefined, context: WhenContext): boolean {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return context[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

export function whenIdentifiers(node: WhenNode | undefined, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if (node.type === "identifier") out.add(node.name);
  else if (node.type === "not") whenIdentifiers(node.node, out);
  else {
    whenIdentifiers(node.left, out);
    whenIdentifiers(node.right, out);
  }
  return out;
}

export function isKnownWhenVariable(name: string): boolean {
  return KNOWN.has(name);
}

export function unknownWhenVariables(node: WhenNode | undefined): string[] {
  return [...whenIdentifiers(node)].filter((n) => !KNOWN.has(n)).sort();
}

/** The variable a focus-scoped action's panel stands for; null for global. */
export function contextVariable(when: When): string | null {
  return when === "global" ? null : WHEN_LABELS[when];
}

/** `context` as the panel `own` sees it when it asks: its own variable true
 *  and, when that is a surface focus, every other surface focus false. */
export function panelWhenContext(context: WhenContext, own: string | null): WhenContext {
  if (!own) return context;
  const out: Record<string, boolean> = { ...context, [own]: true };
  if ((SURFACE_FOCUS_VARIABLES as readonly string[]).includes(own)) {
    for (const v of SURFACE_FOCUS_VARIABLES) if (v !== own) out[v] = false;
  }
  return out;
}

/** The expression an action fires under unless a profile replaces it. */
export function defaultWhenExpression(when: When): string {
  return contextVariable(when) ?? "";
}

/**
 * True when no state Atlas can be in makes `node` true for an action whose
 * panel is `when`: the panel's own variable is fixed true (and, for a surface
 * focus, every other surface focus false), and every other variable the
 * expression names is tried both ways. Unknown variables are never set, so
 * they count as false — the same as at runtime.
 */
export function neverMatches(node: WhenNode | undefined, when: When): boolean {
  if (!node) return false;
  const fixed = panelWhenContext({}, contextVariable(when));
  const free = [...whenIdentifiers(node)].filter(
    (n) => KNOWN.has(n) && n !== "true" && n !== "false" && !(n in fixed),
  );
  // A dozen or so variables at most: 2^n is small.
  for (let mask = 0; mask < 1 << free.length; mask++) {
    const ctx: Record<string, boolean> = { ...fixed };
    free.forEach((n, i) => (ctx[n] = (mask & (1 << i)) !== 0));
    const focused = SURFACE_FOCUS_VARIABLES.filter((v) => ctx[v]).length;
    if (focused > 1) continue;
    if (evaluateWhen(node, ctx)) return false;
  }
  return true;
}
