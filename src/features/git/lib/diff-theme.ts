// The diff viewer's Shiki theme: every colour is an Atlas theme-variable reference,
// never a value.
//
// Shiki writes a token's colour into the HTML it produces, and the diff viewer
// tokenizes in workers and caches what they return. A theme of literal colours
// would make every theme switch re-tokenize every open diff. A theme of
// variables is tokenized once: the HTML carries `var(--atlas-syntax-keyword)`,
// and the variable resolves through the viewer's shadow root to whatever
// `applyTheme` last wrote on `:root`. A switch repaints and nothing else.
//
// The scopes are the ones `crates/atlas-theme/src/import/vscode.rs` reads a VS
// Code theme through (`SCOPE_TABLE`), turned around: there each Atlas role asks
// which colour a theme gives these scopes; here these scopes get that role.
// Atlas's default syntax colours come from Pierre's own theme by that same
// table, so on the default theme a diff looks as Pierre draws it.

import { registerCustomTheme, type ThemeRegistration, type ThemesType } from "@pierre/diffs";

/**
 * The theme pair the worker pool and every viewer ask for: one name per
 * appearance, never a single name. Given a single theme, the viewer pins its
 * shadow root's `color-scheme` to that theme's registered `type` and ignores
 * `themeType`, so every `light-dark()` in it (its own and `DIFF_VIEW_CSS`'s)
 * resolved dark under a light Atlas theme. Given a pair, `themeType` decides.
 *
 * Both halves are the same variables, so tokens still render once: the pair
 * never changes, and an appearance switch is only a `themeType` change.
 */
export const DIFF_THEME_NAMES = {
  light: "atlas-light",
  dark: "atlas-dark",
} as const satisfies ThemesType;

type Role =
  | "comment"
  | "keyword"
  | "string"
  | "number"
  | "type"
  | "function"
  | "variable"
  | "operator"
  | "tag"
  | "attribute"
  | "constant"
  | "regexp"
  | "escape"
  | "definition"
  | "property";

/** Spelled out in full: a variable named by a template would hide from the
 *  suite that checks every `var(--…)` resolves. */
const ROLE_VAR: Record<Role, string> = {
  comment: "var(--atlas-syntax-comment)",
  keyword: "var(--atlas-syntax-keyword)",
  string: "var(--atlas-syntax-string)",
  number: "var(--atlas-syntax-number)",
  type: "var(--atlas-syntax-type)",
  function: "var(--atlas-syntax-function)",
  variable: "var(--atlas-syntax-variable)",
  operator: "var(--atlas-syntax-operator)",
  tag: "var(--atlas-syntax-tag)",
  attribute: "var(--atlas-syntax-attribute)",
  constant: "var(--atlas-syntax-constant)",
  regexp: "var(--atlas-syntax-regexp)",
  escape: "var(--atlas-syntax-escape)",
  definition: "var(--atlas-syntax-definition)",
  property: "var(--atlas-syntax-property)",
};

const role = (name: Role) => ROLE_VAR[name];

/** Most specific selectors win in TextMate, so a broad scope here only
 *  colours what nothing narrower claimed. */
const SCOPES: ReadonlyArray<readonly [Role, readonly string[]]> = [
  ["comment", ["comment", "punctuation.definition.comment", "string.quoted.docstring"]],
  ["keyword", ["keyword", "keyword.control", "storage.type", "storage.modifier"]],
  ["operator", ["keyword.operator", "punctuation.accessor"]],
  ["string", ["string", "string.quoted", "string.template", "markup.inline.raw"]],
  ["escape", ["constant.character.escape"]],
  ["regexp", ["string.regexp"]],
  ["number", ["constant.numeric"]],
  [
    "constant",
    ["constant", "constant.language", "constant.other", "variable.language", "support.constant"],
  ],
  [
    "type",
    [
      "entity.name.type",
      "entity.name.class",
      "support.type",
      "support.class",
      "entity.other.inherited-class",
    ],
  ],
  [
    "function",
    [
      "entity.name.function",
      "support.function",
      "variable.function",
      "meta.function-call entity.name.function",
      "markup.heading",
    ],
  ],
  ["definition", ["entity.name", "entity.name.namespace", "markup.bold"]],
  ["variable", ["variable", "variable.other.readwrite", "variable.parameter"]],
  [
    "property",
    [
      "variable.other.property",
      "variable.other.object.property",
      "support.type.property-name",
      "meta.object-literal.key",
    ],
  ],
  ["tag", ["entity.name.tag"]],
  ["attribute", ["entity.other.attribute-name", "meta.preprocessor", "keyword.control.directive"]],
];

/** The colours both halves of {@link DIFF_THEME_NAMES} share; only the name
 *  and the `type` differ between them. */
export const DIFF_THEME: Omit<ThemeRegistration, "name" | "type"> = {
  fg: "var(--atlas-editor-foreground)",
  bg: "var(--atlas-editor-background)",
  colors: {
    "editor.foreground": "var(--atlas-editor-foreground)",
    "editor.background": "var(--atlas-editor-background)",
    // The viewer's addition / deletion / modification hues, which its bars,
    // file-type icons and line tints derive from.
    "gitDecoration.addedResourceForeground": "var(--atlas-diff-added-text)",
    "gitDecoration.deletedResourceForeground": "var(--atlas-diff-removed-text)",
    "gitDecoration.modifiedResourceForeground": "var(--atlas-diff-modified-text)",
  },
  tokenColors: [
    ...SCOPES.map(([name, scope]) => ({
      scope: [...scope],
      settings: { foreground: role(name) },
    })),
    { scope: ["markup.italic", "emphasis"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inserted"], settings: { foreground: "var(--atlas-diff-added-text)" } },
    { scope: ["markup.deleted"], settings: { foreground: "var(--atlas-diff-removed-text)" } },
  ],
};

let registered = false;

/** Make both of {@link DIFF_THEME_NAMES} resolvable. Idempotent; must run
 *  before the worker pool is created, which resolves its themes up front. */
export function ensureDiffTheme(): void {
  if (registered) return;
  registered = true;
  for (const type of ["light", "dark"] as const) {
    const name = DIFF_THEME_NAMES[type];
    registerCustomTheme(name, () => Promise.resolve({ ...DIFF_THEME, name, type }));
  }
}
