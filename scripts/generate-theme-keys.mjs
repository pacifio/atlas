#!/usr/bin/env node
/**
 * Generates every derived copy of the theme-key registry from the one
 * hand-edited source, `crates/atlas-theme/keys.toml`.
 *
 *   node scripts/generate-theme-keys.mjs           rewrite the generated files
 *   node scripts/generate-theme-keys.mjs --check    fail if any is stale
 *
 * Outputs:
 *   src/features/theme/theme-key-registry.ts    the TS registry the resolver reads
 *   crates/atlas-theme/theme-keys.txt           key + description, read by Rust
 *   crates/atlas-theme/base-rules.txt           the `[[base]]` rules, run by Rust
 *   crates/atlas-theme/schema/theme-v1.json     the `keys` property of a variant
 *   docs/reference/theme-keys.md                the generated block only
 *
 * The schema is the one output Rust writes rather than this script: its other
 * 100 lines come from `schemars` over the `Theme` struct, and re-serialising
 * them here would mean a second JSON printer that has to agree with serde_json
 * byte for byte. So `atlas_theme::json_schema()` injects the key properties
 * from the generated `theme-keys.txt`, and a write run shells out to
 * `cargo run -p atlas-theme --example generate_schema`. `--check` needs no
 * cargo: it compares the committed schema's key properties against this file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(REPO_ROOT, "crates", "atlas-theme", "keys.toml");
const SOURCE_REL = "crates/atlas-theme/keys.toml";
const COMMAND = "bun run theme:keys";

export const OUTPUTS = {
  registry: "src/features/theme/theme-key-registry.ts",
  keyList: "crates/atlas-theme/theme-keys.txt",
  baseRules: "crates/atlas-theme/base-rules.txt",
  schema: "crates/atlas-theme/schema/theme-v1.json",
  docs: "docs/reference/theme-keys.md",
};

/** The eight palette hues a key may name. Mirrored in `atlas-theme`. */
const PALETTE_KEYS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

/**
 * The closed operation vocabulary. The value is how the transform is spelled in
 * the generated TS; `resolve-theme.ts` applies it to whichever source supplied
 * the colour. Adding an entry here means adding one to the registry preamble
 * below and, if it needs new inputs, to `DerivationContext` — and, because
 * base rules run in Rust too, to `crates/atlas-theme/src/derive.rs`.
 * `amount: false` marks an operation that takes none.
 */
const OPERATIONS = {
  alpha: { call: "alpha", docs: (n) => `alpha ${n}`, prose: (n) => `alpha ${n}` },
  lighten: { call: "lighter", docs: (n) => `lighten ${n}`, prose: (n) => `lighten ${n}` },
  toward_background: {
    call: "towardBackground",
    docs: (n) => `mix ${n} → B:background`,
    prose: (n) => `mix ${n} toward base.background`,
  },
  toward_foreground: {
    call: "towardForeground",
    docs: (n) => `mix ${n} → B:foreground`,
    prose: (n) => `mix ${n} toward base.foreground`,
  },
  readable: {
    call: "readableOn",
    amount: false,
    docs: () => "readable: B:foreground or B:background",
    prose: () =>
      "whichever of base.foreground and base.background reads better on it (white or black while foreground itself is derived)",
  },
};

/** `op`/`amount` problems for a key, a derived variable or a base rule. */
function checkOperation(entry, at, problems, { required = false } = {}) {
  if (entry.op === undefined) {
    if (required) problems.push(`${at}: missing \`op\``);
    if (entry.amount !== undefined) problems.push(`${at}: \`amount\` without an \`op\``);
    return;
  }
  const operation = OPERATIONS[entry.op];
  if (!operation) {
    problems.push(
      `${at}: unknown op \`${entry.op}\`; one of ${Object.keys(OPERATIONS).join(", ")}`,
    );
    return;
  }
  if (operation.amount === false) {
    if (entry.amount !== undefined) problems.push(`${at}: \`${entry.op}\` takes no \`amount\``);
    return;
  }
  const amount = Number(entry.amount?.number);
  if (!(amount > 0 && amount <= 1)) problems.push(`${at}: \`amount\` must be in (0, 1]`);
}

/** How a transform is spelled in the generated TS. */
const transformCall = (entry) => `${OPERATIONS[entry.op].call}(${entry.amount ?? ""})`;

const DOCS_BEGIN = "<!-- generated:theme-keys -->";
const DOCS_END = "<!-- /generated:theme-keys -->";

// ─── A very small TOML reader ────────────────────────────────────────────────
// Deliberately not a dependency: `keys.toml` is ours and machine-shaped, and a
// parser for the handful of constructs it uses is shorter than the argument for
// adding a package. It is strict on purpose — anything it does not understand
// is an error with a line number rather than a silently dropped field.

class TomlError extends Error {}

function parseKeysToml(text) {
  const lines = text.split("\n");
  const top = {};
  const arrays = {};
  let table = top;
  let index = 0;

  const fail = (message) => {
    throw new TomlError(`${SOURCE_REL}:${index + 1}: ${message}`);
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const arrayTable = trimmed.match(/^\[\[([a-z_]+)\]\]$/);
    if (arrayTable) {
      table = {};
      (arrays[arrayTable[1]] ??= []).push(table);
      index += 1;
      continue;
    }
    if (trimmed.startsWith("[")) fail(`only [[array]] tables are supported, got ${trimmed}`);
    const assignment = trimmed.match(/^([a-z_]+)\s*=\s*(.*)$/);
    if (!assignment) fail(`expected \`name = value\`, got ${trimmed}`);
    const [, name, rest] = assignment;
    if (name in table) fail(`duplicate field \`${name}\``);
    if (rest.startsWith('"""')) {
      if (rest !== '"""') fail('a multi-line string must open with `"""` alone on the line');
      const body = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== '"""') {
        body.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) fail("unterminated multi-line string");
      table[name] = body.join("\n").trim();
      index += 1;
      continue;
    }
    table[name] = parseScalar(rest, fail);
    index += 1;
  }
  return { ...top, ...arrays };
}

function parseScalar(rest, fail) {
  if (rest.startsWith('"')) {
    let out = "";
    let at = 1;
    for (;;) {
      if (at >= rest.length) fail("unterminated string");
      const char = rest[at];
      if (char === '"') break;
      if (char === "\\") {
        const escape = { n: "\n", t: "\t", '"': '"', "\\": "\\" }[rest[at + 1]];
        if (escape === undefined) fail(`unsupported escape \\${rest[at + 1]}`);
        out += escape;
        at += 2;
        continue;
      }
      out += char;
      at += 1;
    }
    const trailing = rest.slice(at + 1).trim();
    if (trailing !== "" && !trailing.startsWith("#"))
      fail(`trailing text after string: ${trailing}`);
    return out;
  }
  const value = rest.split("#")[0].trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) fail(`unsupported value \`${value}\``);
  // Kept as the source lexeme: the generated TS reproduces it verbatim, so
  // `0.30` would never silently become `0.3`.
  return { number: value };
}

// ─── Reading and validating the source ───────────────────────────────────────

/** Base tokens, read from the crate so a typo'd `base` is caught here. */
function baseTokens() {
  const source = readFileSync(
    path.join(REPO_ROOT, "crates", "atlas-theme", "src", "lib.rs"),
    "utf8",
  );
  const block = source.match(/const BASE_TOKENS: &\[&str\] = &\[([\s\S]*?)\];/);
  if (!block) throw new Error("could not find BASE_TOKENS in crates/atlas-theme/src/lib.rs");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export function readSource() {
  const parsed = parseKeysToml(readFileSync(SOURCE, "utf8"));
  const groups = parsed.group ?? [];
  const keys = parsed.key ?? [];
  const derived = parsed.derived ?? [];
  const baseRules = parsed.base ?? [];
  const tokens = new Set(baseTokens());
  const problems = [];
  const seen = new Set();
  const groupNames = groups.map((group) => group.name);

  if (groups.length === 0) problems.push("no [[group]] tables");
  for (const group of groups) {
    for (const field of ["name", "description"]) {
      if (typeof group[field] !== "string")
        problems.push(`group ${group.name}: missing \`${field}\``);
    }
  }
  if (new Set(groupNames).size !== groupNames.length) problems.push("duplicate group names");

  let groupIndex = -1;
  for (const key of keys) {
    const at = `key \`${key.name ?? "?"}\``;
    for (const field of ["name", "group", "description", "dark"]) {
      if (typeof key[field] !== "string") problems.push(`${at}: missing \`${field}\``);
    }
    if (typeof key.name !== "string") continue;
    if (seen.has(key.name)) problems.push(`${at}: defined twice`);
    seen.add(key.name);
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(key.name)) {
      problems.push(`${at}: not a dotted lower-case role name`);
    }
    const position = groupNames.indexOf(key.group);
    if (position === -1) problems.push(`${at}: unknown group \`${key.group}\``);
    else if (position < groupIndex)
      problems.push(`${at}: group \`${key.group}\` is not contiguous`);
    else groupIndex = position;
    if (key.palette !== undefined && !PALETTE_KEYS.includes(key.palette)) {
      problems.push(`${at}: unknown palette hue \`${key.palette}\``);
    }
    if (key.base !== undefined && !tokens.has(key.base)) {
      problems.push(`${at}: unknown base token \`${key.base}\``);
    }
    if (key.palette === undefined && key.base === undefined) {
      problems.push(`${at}: needs a \`palette\` or a \`base\` source`);
    }
    checkOperation(key, at, problems);
    for (const field of ["dark", "light", "note"]) {
      if (key[field] !== undefined && typeof key[field] !== "string") {
        problems.push(`${at}: \`${field}\` must be a string`);
      }
    }
  }

  // A derived variable is a colour Atlas still writes but no theme may set:
  // it is a pure transform of a key that IS settable. Validated here so a
  // dangling `from` fails the build rather than resolving to `undefined`.
  for (const entry of derived) {
    const at = `derived \`${entry.name ?? "?"}\``;
    for (const field of ["name", "description"]) {
      if (typeof entry[field] !== "string") problems.push(`${at}: missing \`${field}\``);
    }
    if (typeof entry.name !== "string") continue;
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(entry.name)) {
      problems.push(`${at}: not a dotted lower-case role name`);
    }
    if (seen.has(entry.name)) problems.push(`${at}: is also a settable key`);
    if ((entry.from === undefined) === (entry.base === undefined)) {
      problems.push(`${at}: needs exactly one of \`from\` (a key) or \`base\` (a base token)`);
    }
    if (entry.from !== undefined && !seen.has(entry.from)) {
      problems.push(`${at}: \`from\` names no key`);
    }
    if (entry.base !== undefined && !tokens.has(entry.base)) {
      problems.push(`${at}: unknown base token \`${entry.base}\``);
    }
    checkOperation(entry, at, problems, { required: true });
  }

  // Base rules: exactly `BASE_TOKENS`, in its order, each sourcing only an
  // earlier rule — which is what lets both interpreters resolve in one pass.
  const tokenOrder = [...tokens];
  const ruleNames = baseRules.map((rule) => rule.name);
  if (ruleNames.join(" ") !== tokenOrder.join(" ")) {
    problems.push(
      `[[base]] must list exactly BASE_TOKENS (crates/atlas-theme/src/lib.rs), in its order`,
    );
  }
  const earlier = new Set();
  for (const rule of baseRules) {
    const at = `base rule \`${rule.name ?? "?"}\``;
    for (const field of ["name", "description"]) {
      if (typeof rule[field] !== "string") problems.push(`${at}: missing \`${field}\``);
    }
    if (rule.palette !== undefined && !PALETTE_KEYS.includes(rule.palette)) {
      problems.push(`${at}: unknown palette hue \`${rule.palette}\``);
    }
    if (rule.base !== undefined && !earlier.has(rule.base)) {
      problems.push(`${at}: \`base\` must name an earlier rule, got \`${rule.base}\``);
    }
    if (rule.base === undefined && typeof rule.dark !== "string") {
      problems.push(`${at}: needs a \`base\` source or a \`dark\` default`);
    }
    for (const field of ["dark", "light"]) {
      if (rule[field] !== undefined && typeof rule[field] !== "string") {
        problems.push(`${at}: \`${field}\` must be a string`);
      }
      if (typeof rule[field] === "string" && /[\t\n]/.test(rule[field])) {
        problems.push(`${at}: \`${field}\` may not hold a tab or newline`);
      }
    }
    checkOperation(rule, at, problems);
    earlier.add(rule.name);
  }

  // `.` and `_` both become `-`, so `a.b_c` and `a.b.c` would write the same
  // CSS variable and the second would silently win. Cheap to check, invisible
  // otherwise, and exactly the kind of thing a phase-2 rename could introduce.
  // Keys carry no prefix (ADR-0027), so they share one namespace with the
  // derived variables and with the shadcn base tokens (`--border`, `--ring`, …,
  // and the `--font-*` stacks): a key that wrote `--border` would overwrite the
  // base token for every consumer.
  const byVar = new Map();
  for (const token of [...tokens, "font-sans", "font-serif", "font-mono"]) {
    byVar.set(`--${token}`, `base.${token}`);
  }
  for (const key of [...keys, ...derived]) {
    if (typeof key.name !== "string") continue;
    const existing = byVar.get(cssVar(key.name));
    if (existing) problems.push(`keys \`${existing}\` and \`${key.name}\` share one CSS variable`);
    byVar.set(cssVar(key.name), key.name);
  }

  if (problems.length > 0) {
    throw new TomlError(`${SOURCE_REL} is invalid:\n  ${problems.join("\n  ")}`);
  }

  return {
    groups,
    baseRules: baseRules.map((rule) => ({
      name: rule.name,
      description: rule.description,
      palette: rule.palette,
      base: rule.base,
      op: rule.op,
      amount: rule.amount?.number,
      dark: rule.dark,
      light: rule.light ?? rule.dark,
    })),
    derived: derived.map((entry) => ({
      name: entry.name,
      description: entry.description,
      from: entry.from,
      base: entry.base,
      op: entry.op,
      amount: entry.amount?.number,
    })),
    keys: keys.map((key) => ({
      name: key.name,
      group: key.group,
      description: key.description,
      palette: key.palette,
      base: key.base,
      op: key.op,
      amount: key.amount?.number,
      dark: key.dark,
      light: key.light ?? key.dark,
      note: key.note,
    })),
  };
}

// ─── Shared derivation vocabulary ────────────────────────────────────────────

/** `--…`, matching `define()` in the generated registry. */
export function cssVar(name) {
  return `--${name.replaceAll(".", "-").replaceAll("_", "-")}`;
}

/** Compact source chain for the docs table: `P:green → B:destructive → D`. */
function sourceChainShort(key) {
  return [key.palette && `P:${key.palette}`, key.base && `B:${key.base}`, "D"]
    .filter(Boolean)
    .join(" → ");
}

/** Spelled-out source chain, for hovers and the key list. */
function sourceChainLong(key) {
  return [key.palette && `palette.${key.palette}`, key.base && `base.${key.base}`, "Atlas default"]
    .filter(Boolean)
    .join(" → ");
}

/**
 * The one-line hover an author sees on a key in a TOML editor, and column 2 of
 * `theme-keys.txt`. Composed here so Rust never has to build it.
 */
export function keyDescription(key) {
  const transform = key.op ? ` Transform: ${OPERATIONS[key.op].prose(key.amount)}.` : "";
  return `${key.description} Source: ${sourceChainLong(key)}.${transform}`;
}

// ─── The generated files ─────────────────────────────────────────────────────

function banner(comment) {
  const lines = [
    `Generated from ${SOURCE_REL} — do not edit.`,
    `Run \`${COMMAND}\` after editing that file.`,
  ];
  return lines.map((line) => `${comment} ${line}`.trimEnd()).join("\n");
}

const REGISTRY_PREAMBLE = `${banner("//")}

import { withAlpha, lighten, mix, readable } from "./color";

export const PALETTE_KEYS = [
${PALETTE_KEYS.map((hue) => `  "${hue}",`).join("\n")}
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Appearance = "dark" | "light";
export type ColorTransform = (color: string, context: DerivationContext) => string;

export interface DerivationContext {
  base: Record<string, string>;
  palette: Record<string, string>;
  appearance: Appearance;
}

export interface ThemeKeyRule {
  /** First derivation source after an explicit theme key. */
  palette?: PaletteKey;
  /** Second derivation source after the palette. */
  base?: string;
  /** Per-appearance Atlas default, used only when both sources are absent. */
  atlasDefault: Record<Appearance, string>;
  transform?: ColorTransform;
  description: string;
}

export interface ThemeKeyDefinition<Key extends string = string> {
  key: Key;
  cssVar: \`--\${string}\`;
  rule: ThemeKeyRule;
}

const alpha =
  (amount: number): ColorTransform =>
  (color) =>
    withAlpha(color, amount);
const lighter =
  (amount: number): ColorTransform =>
  (color) =>
    lighten(color, amount);
const towardBackground =
  (amount: number): ColorTransform =>
  (color, { base }) =>
    mix(color, base.background ?? "#000000", amount);
const towardForeground =
  (amount: number): ColorTransform =>
  (color, { base }) =>
    mix(color, base.foreground ?? "#ffffff", amount);
const readableOn =
  (): ColorTransform =>
  (color, { base }) =>
    // Until \`foreground\` exists — only while deriving it — the choice is
    // white or black, since \`background\` cannot be read on itself.
    base.foreground === undefined
      ? readable(color, "#ffffff", "#000000")
      : readable(color, base.foreground, base.background ?? "#000000");

export interface BaseRule {
  token: string;
  palette?: PaletteKey;
  /** An earlier base token this one follows. */
  base?: string;
  /** Per-appearance default, for when neither source answers. */
  atlasDefault?: Record<Appearance, string>;
  transform?: ColorTransform;
  description: string;
}

function rule(
  token: string,
  definition: Omit<BaseRule, "token" | "atlasDefault"> & { dark?: string; light?: string },
): BaseRule {
  const { dark, light = dark, ...rest } = definition;
  return { token, ...rest, ...(dark ? { atlasDefault: { dark, light: light! } } : {}) };
}

/**
 * How each shadcn base token a theme leaves out is derived (ADR-0022), in
 * \`BASE_TOKENS\` order: a rule's \`base\` is always an earlier rule, so one
 * pass resolves the set.
 */
export const BASE_RULE_REGISTRY: readonly BaseRule[] = [
BASE_RULES_BODY
];

function define<const Key extends string>(
  key: Key,
  rule: Omit<ThemeKeyRule, "atlasDefault"> & {
    dark: string;
    light?: string;
  },
): ThemeKeyDefinition<Key> {
  const { dark, light = dark, ...rest } = rule;
  return {
    key,
    cssVar: \`--\${key.replaceAll(".", "-").replaceAll("_", "-")}\`,
    rule: { ...rest, atlasDefault: { dark, light } },
  };
}

/**
 * The public schema-1 theme-key registry. Every key appears once and carries
 * exactly one explicit → palette → base → Atlas-default derivation rule.
 */
export const THEME_KEY_REGISTRY = [`;

const REGISTRY_EPILOGUE = `] as const;

export type ThemeKey = (typeof THEME_KEY_REGISTRY)[number]["key"];

export const THEME_KEY_DEFINITION_BY_KEY = Object.fromEntries(
  THEME_KEY_REGISTRY.map((definition) => [definition.key, definition]),
) as Record<ThemeKey, (typeof THEME_KEY_REGISTRY)[number]>;

export interface DerivedVarDefinition<Name extends string = string> {
  name: Name;
  cssVar: \`--\${string}\`;
  /** The settable key this transforms, or null when it transforms a base token. */
  from: ThemeKey | null;
  /** The base token this transforms, or null when it transforms a key. */
  base: string | null;
  transform: ColorTransform;
  description: string;
}

function derive<const Name extends string>(
  name: Name,
  rule: Omit<DerivedVarDefinition<Name>, "name" | "cssVar">,
): DerivedVarDefinition<Name> {
  return {
    name,
    cssVar: \`--\${name.replaceAll(".", "-").replaceAll("_", "-")}\`,
    ...rule,
  };
}

/**
 * Colours Atlas still writes as CSS custom properties, but that no
 * theme may set: each is a pure transform of a key that IS settable, so a
 * theme author steers it through that key and never restates it. They are
 * deliberately absent from \`theme-keys.txt\` and from the JSON Schema, which is
 * what makes writing one in a theme file an unknown-key warning.
 */
export const DERIVED_VAR_REGISTRY = [
DERIVED_BODY
] as const;

export type DerivedVar = (typeof DERIVED_VAR_REGISTRY)[number]["name"];

export function describeDerivation(definition: ThemeKeyDefinition): string {
  const sources = [
    definition.rule.palette ? \`palette.\${definition.rule.palette}\` : null,
    definition.rule.base ? \`base.\${definition.rule.base}\` : null,
    "Atlas appearance default",
  ].filter(Boolean);
  return sources.join(" → ");
}
`;

function renderBaseRules(baseRules) {
  return baseRules
    .flatMap((entry) => {
      const fields = [];
      if (entry.palette) fields.push(`palette: "${entry.palette}"`);
      if (entry.base) fields.push(`base: "${entry.base}"`);
      if (entry.op) fields.push(`transform: ${transformCall(entry)}`);
      if (entry.dark) fields.push(`dark: "${entry.dark}"`);
      if (entry.dark && entry.light !== entry.dark) fields.push(`light: "${entry.light}"`);
      fields.push(`description: "${entry.description.replaceAll('"', '\\"')}"`);
      return [`  rule("${entry.name}", {`, ...fields.map((field) => `    ${field},`), "  }),"];
    })
    .join("\n");
}

function renderRegistry({ keys, derived, baseRules }) {
  const body = [];
  let group = null;
  for (const key of keys) {
    if (key.group !== group) {
      if (group !== null) body.push("");
      group = key.group;
    }
    if (key.note) {
      body.push("  /**");
      // `trimEnd`: a blank line inside a TOML note would otherwise emit `   * `
      // with a trailing space, which `oxfmt` strips — putting `format:check` and
      // `theme:keys:check` permanently at odds.
      for (const line of key.note.split("\n")) body.push(`   * ${line}`.trimEnd());
      body.push("   */");
    }
    body.push(`  define("${key.name}", {`);
    if (key.palette) body.push(`    palette: "${key.palette}",`);
    if (key.base) body.push(`    base: "${key.base}",`);
    if (key.op) body.push(`    transform: ${transformCall(key)},`);
    body.push(`    dark: "${key.dark}",`);
    body.push(`    light: "${key.light}",`);
    body.push(`    description: "${key.description.replaceAll('"', '\\"')}",`);
    body.push("  }),");
  }
  const derivedBody = derived.flatMap((entry) => [
    `  derive("${entry.name}", {`,
    `    from: ${entry.from ? `"${entry.from}"` : "null"},`,
    `    base: ${entry.base ? `"${entry.base}"` : "null"},`,
    `    transform: ${transformCall(entry)},`,
    `    description: "${entry.description.replaceAll('"', '\\"')}",`,
    "  }),",
  ]);
  return `${REGISTRY_PREAMBLE.replace("BASE_RULES_BODY", renderBaseRules(baseRules))}\n${body.join("\n")}\n${REGISTRY_EPILOGUE.replace(
    "DERIVED_BODY",
    derivedBody.join("\n"),
  )}`;
}

function renderKeyList({ keys }) {
  const rows = keys.map((key) => `${key.name}\t${keyDescription(key)}`);
  return `${banner("#")}\n#\n# One key per line: the role name, a tab, and the hover text an author sees.\n${rows.join("\n")}\n`;
}

/**
 * One rule per line, tab-separated, for `crates/atlas-theme/src/derive.rs`:
 * token, palette, base, op, amount, dark, light — `-` where a field is absent.
 */
function renderBaseRuleList({ baseRules }) {
  const rows = baseRules.map((entry) =>
    [entry.name, entry.palette, entry.base, entry.op, entry.amount, entry.dark, entry.light]
      .map((field) => field ?? "-")
      .join("\t"),
  );
  return `${banner("#")}\n#\n# token, palette, base, op, amount, dark, light; \`-\` where absent.\n${rows.join("\n")}\n`;
}

function renderDocs({ groups, keys, derived, baseRules }, current) {
  const begin = current.indexOf(DOCS_BEGIN);
  const end = current.indexOf(DOCS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${OUTPUTS.docs} must contain the ${DOCS_BEGIN} … ${DOCS_END} markers around the generated block`,
    );
  }

  const out = [
    DOCS_BEGIN,
    `<!-- Generated from ${SOURCE_REL} by \`${COMMAND}\`. Edit that file, not this block. -->`,
    "",
    "## How a missing base token is derived",
    "",
    "Every base token is optional. One a theme leaves out comes from its rule:",
    "`P:x` is `palette.x`, `B:x` is another base token, and `D` is the Atlas",
    "default (dark / light). `background`, `foreground` and `primary` are the",
    "seeds; a theme that sets only those still sets every token.",
    "",
    "| Token | Source | Transform | D (dark / light) | What it is |",
    "|---|---|---|---|---|",
    ...baseRules.map((entry) => {
      const source = [
        entry.palette && `P:${entry.palette}`,
        entry.base && `B:${entry.base}`,
        entry.dark && "D",
      ]
        .filter(Boolean)
        .join(" → ");
      const transform = entry.op ? OPERATIONS[entry.op].docs(entry.amount) : "—";
      const fallback = !entry.dark
        ? "—"
        : entry.dark === entry.light
          ? `\`${entry.dark}\``
          : `\`${entry.dark}\` / \`${entry.light}\``;
      return `| \`${entry.name}\` | ${source} | ${transform} | ${fallback} | ${entry.description} |`;
    }),
    "",
    "## Full key list and derivation sources",
    "",
    `All **${keys.length}** keys, in the order and grouping of \`${SOURCE_REL}\`.`,
    "**Source** is the first thing Atlas tries after an explicit `keys` value:",
    "`P:x` is `palette.x`, `B:x` is `base.x`, and `D` is the Atlas default for the",
    "active appearance, shown here as dark / light. **Transform** is applied to",
    "whichever of those three supplied the colour, and never to an explicit value.",
    "",
  ];

  for (const group of groups) {
    const members = keys.filter((key) => key.group === group.name);
    if (members.length === 0) continue;
    out.push(`### ${group.name}`, "", group.description, "");
    out.push("| Key | Source | Transform | D (dark / light) | What it colours |");
    out.push("|---|---|---|---|---|");
    for (const key of members) {
      const transform = key.op ? OPERATIONS[key.op].docs(key.amount) : "—";
      const fallback =
        key.dark === key.light ? `\`${key.dark}\`` : `\`${key.dark}\` / \`${key.light}\``;
      out.push(
        `| \`${key.name}\` | ${sourceChainShort(key)} | ${transform} | ${fallback} | ${key.description} |`,
      );
    }
    out.push("");
  }

  if (derived.length > 0) {
    out.push(
      "## Derived variables",
      "",
      `Atlas writes these **${derived.length}** custom properties too, but`,
      "they are **not** theme keys: each is a pure transform of a key that is, so a",
      "theme steers it through that key. Writing one in a theme file is an",
      "unknown-key warning.",
      "",
      "| Variable | Derived from | Transform | What it colours |",
      "|---|---|---|---|",
    );
    for (const entry of derived) {
      const source = entry.from ? `\`${entry.from}\`` : `\`base.${entry.base}\``;
      out.push(
        `| \`${entry.name}\` | ${source} | ${OPERATIONS[entry.op].docs(entry.amount)} | ${entry.description} |`,
      );
    }
    out.push("");
  }

  out.push(DOCS_END);
  return current.slice(0, begin) + out.join("\n") + current.slice(end + DOCS_END.length);
}

/**
 * What `atlas_theme::json_schema()` must put on `ThemeVariant.properties.keys`.
 * `--check` compares this against the committed schema; the schema file itself
 * is written by the cargo example, which builds the same value from
 * `theme-keys.txt`.
 */
function expectedSchemaKeys({ keys }) {
  const properties = {};
  for (const key of keys) {
    properties[key.name] = {
      allOf: [{ $ref: "#/definitions/ThemeKeyValue" }],
      description: keyDescription(key),
    };
  }
  return { additionalProperties: false, default: {}, properties, type: "object" };
}

// ─── Driver ──────────────────────────────────────────────────────────────────

function read(relative) {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, sortValue(value[name])]),
    );
  }
  return value;
}

function schemaKeysOf(text) {
  const schema = JSON.parse(text);
  return schema?.definitions?.ThemeVariant?.properties?.keys;
}

/** @returns {{ path: string, hint: string }[]} the outputs that are out of date. */
export function staleOutputs() {
  const source = readSource();
  const stale = [];
  const compare = (relative, expected) => {
    if (read(relative) !== expected) stale.push({ path: relative, hint: COMMAND });
  };
  compare(OUTPUTS.registry, renderRegistry(source));
  compare(OUTPUTS.keyList, renderKeyList(source));
  compare(OUTPUTS.baseRules, renderBaseRuleList(source));
  compare(OUTPUTS.docs, renderDocs(source, read(OUTPUTS.docs)));

  const committed = JSON.stringify(sortValue(schemaKeysOf(read(OUTPUTS.schema))));
  const expected = JSON.stringify(sortValue(expectedSchemaKeys(source)));
  if (committed !== expected) {
    stale.push({
      path: OUTPUTS.schema,
      hint: `${COMMAND}, which regenerates it via cargo run -p atlas-theme --example generate_schema`,
    });
  }
  return stale;
}

function write() {
  const source = readSource();
  const written = [];
  const put = (relative, contents) => {
    const full = path.join(REPO_ROOT, relative);
    if (existsSync(full) && readFileSync(full, "utf8") === contents) return;
    writeFileSync(full, contents);
    written.push(relative);
  };
  put(OUTPUTS.registry, renderRegistry(source));
  put(OUTPUTS.keyList, renderKeyList(source));
  put(OUTPUTS.baseRules, renderBaseRuleList(source));
  put(OUTPUTS.docs, renderDocs(source, read(OUTPUTS.docs)));

  // The schema must be regenerated after `theme-keys.txt`, which it reads.
  const cargo = spawnSync(
    "cargo",
    ["run", "--quiet", "-p", "atlas-theme", "--example", "generate_schema"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (cargo.error || cargo.status !== 0) {
    console.error(cargo.stderr ?? cargo.error?.message ?? "");
    console.error(
      `cargo could not regenerate ${OUTPUTS.schema}. Run it yourself:\n` +
        `  cargo run -p atlas-theme --example generate_schema > ${OUTPUTS.schema}`,
    );
    process.exitCode = 1;
    return;
  }
  put(OUTPUTS.schema, cargo.stdout);

  console.log(
    written.length === 0
      ? `${source.keys.length} theme keys; every generated file was already current.`
      : `${source.keys.length} theme keys; rewrote:\n  ${written.join("\n  ")}`,
  );
}

function check() {
  const stale = staleOutputs();
  if (stale.length === 0) {
    console.log("theme keys: every generated file matches " + SOURCE_REL + ".");
    return;
  }
  console.error(`Stale, ${SOURCE_REL} has moved on:`);
  for (const { path: relative, hint } of stale) console.error(`  ${relative}  — run \`${hint}\``);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv.includes("--check")) check();
    else write();
  } catch (error) {
    console.error(error instanceof TomlError ? error.message : error);
    process.exitCode = 1;
  }
}
