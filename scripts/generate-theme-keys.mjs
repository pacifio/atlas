#!/usr/bin/env node
/**
 * Brings the theme engine's data in from `@tryatlas/design` and generates the
 * files only desktop needs from it.
 *
 *   node scripts/generate-theme-keys.mjs           copy and rewrite
 *   node scripts/generate-theme-keys.mjs --check    fail if anything is stale
 *
 * `keys.toml` and the built-in themes are the package's (ADR-0027): it owns
 * the derivation rules and generates the TS registry, the Rust rule tables and
 * the golden fixture from them. Desktop's Rust build must stay hermetic — cargo
 * never reads `node_modules` — so this COPIES those files, byte for byte, into
 * `crates/atlas-theme/`, where they are committed:
 *
 *   keys.toml, themes/*.toml, theme-rules/{theme-keys,base-rules}.txt
 *     → crates/atlas-theme/ (the rule tables at the crate root, as before)
 *   theme-rules/base-derivation.json
 *     → crates/atlas-theme/tests/fixtures/ (the golden fixture Rust runs)
 *
 * Never edit a copy: change the package, release it, bump the pin, run this.
 * `tests/design-package-copies.test.ts` fails the moment a copy and the
 * installed package disagree.
 *
 * Generated here, from the copies, because they describe desktop's own
 * surfaces:
 *
 *   crates/atlas-theme/schema/theme-v1.json            the `keys` property of a variant
 *   docs/reference/theme-keys.md                       the generated block only
 *   src/dev/mock-backend/fixtures/builtin-themes.json  the mock's built-in themes
 *
 * The schema and the mock's built-ins are written by Rust rather than this
 * script: the schema's other 100 lines come from `schemars` over the `Theme`
 * struct, and the built-ins are the themes as Rust's parser hands them to the
 * frontend. So a write run shells out to `cargo run -p atlas-theme --example
 * generate_schema` and `generate_builtins`. `--check` needs no cargo: it
 * compares the committed schema's key properties against this file.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(REPO_ROOT, "crates", "atlas-theme", "keys.toml");
const SOURCE_REL = "crates/atlas-theme/keys.toml";
const COMMAND = "bun run theme:keys";
const PACKAGE = "@tryatlas/design";

export const OUTPUTS = {
  keyList: "crates/atlas-theme/theme-keys.txt",
  baseRules: "crates/atlas-theme/base-rules.txt",
  schema: "crates/atlas-theme/schema/theme-v1.json",
  docs: "docs/reference/theme-keys.md",
  builtins: "src/dev/mock-backend/fixtures/builtin-themes.json",
};

/** The installed package's root, resolved the way Node resolves an import. */
export function packageRoot() {
  const require = createRequire(path.join(REPO_ROOT, "package.json"));
  return path.dirname(require.resolve(`${PACKAGE}/package.json`));
}

/**
 * Every file desktop copies from the package, as `[from, to]`: `from` relative
 * to the package root, `to` relative to this repo. The themes are listed from
 * the package, so a theme it adds is copied and one it drops shows up in
 * `strayThemes`.
 */
export function packageCopies() {
  const themes = readdirSync(path.join(packageRoot(), "themes"))
    .filter((name) => name.endsWith(".toml"))
    .sort();
  return [
    ["keys.toml", SOURCE_REL],
    ...themes.map((name) => [`themes/${name}`, `crates/atlas-theme/themes/${name}`]),
    ["theme-rules/theme-keys.txt", OUTPUTS.keyList],
    ["theme-rules/base-rules.txt", OUTPUTS.baseRules],
    ["theme-rules/base-derivation.json", "crates/atlas-theme/tests/fixtures/base-derivation.json"],
  ];
}

/** Committed theme files the package no longer ships. */
export function strayThemes() {
  const shipped = new Set(packageCopies().map(([, to]) => to));
  return readdirSync(path.join(REPO_ROOT, "crates", "atlas-theme", "themes"))
    .map((name) => `crates/atlas-theme/themes/${name}`)
    .filter((relative) => !shipped.has(relative));
}

/** The eight palette hues a key may name. Mirrored in `atlas-theme`. */
const PALETTE_KEYS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

/**
 * The closed operation vocabulary, as the docs table and the schema's hover
 * text spell it. The package's generator owns the operations themselves; this
 * only has to recognise them, so an op it adds fails validation here until
 * desktop learns to describe it. `amount: false` marks an operation that takes
 * none.
 */
const OPERATIONS = {
  alpha: { docs: (n) => `alpha ${n}`, prose: (n) => `alpha ${n}` },
  lighten: { docs: (n) => `lighten ${n}`, prose: (n) => `lighten ${n}` },
  toward_background: {
    docs: (n) => `mix ${n} → B:background`,
    prose: (n) => `mix ${n} toward base.background`,
  },
  toward_foreground: {
    docs: (n) => `mix ${n} → B:foreground`,
    prose: (n) => `mix ${n} toward base.foreground`,
  },
  readable: {
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

/** `--…`, matching `define()` in the package's generated registry. */
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
  const stale = [];
  const root = packageRoot();
  for (const [from, to] of packageCopies()) {
    const full = path.join(REPO_ROOT, to);
    const expected = readFileSync(path.join(root, from), "utf8");
    if (!existsSync(full) || readFileSync(full, "utf8") !== expected) {
      stale.push({ path: to, hint: `${COMMAND}, which copies it from ${PACKAGE}` });
    }
  }
  for (const stray of strayThemes()) {
    stale.push({ path: stray, hint: `delete it: ${PACKAGE} no longer ships it` });
  }

  const source = readSource();
  if (read(OUTPUTS.docs) !== renderDocs(source, read(OUTPUTS.docs))) {
    stale.push({ path: OUTPUTS.docs, hint: COMMAND });
  }
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

/** `cargo run -p atlas-theme --example <name>`'s stdout, or null after saying why. */
function cargoExample(name, output) {
  const cargo = spawnSync("cargo", ["run", "--quiet", "-p", "atlas-theme", "--example", name], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (cargo.error || cargo.status !== 0) {
    console.error(cargo.stderr ?? cargo.error?.message ?? "");
    console.error(
      `cargo could not regenerate ${output}. Run it yourself:\n` +
        `  cargo run -p atlas-theme --example ${name} > ${output}`,
    );
    process.exitCode = 1;
    return null;
  }
  return cargo.stdout;
}

function write() {
  const written = [];
  const root = packageRoot();
  for (const [from, to] of packageCopies()) {
    const full = path.join(REPO_ROOT, to);
    const contents = readFileSync(path.join(root, from), "utf8");
    if (existsSync(full) && readFileSync(full, "utf8") === contents) continue;
    copyFileSync(path.join(root, from), full);
    written.push(to);
  }
  const strays = strayThemes();
  if (strays.length > 0) {
    console.error(`${PACKAGE} no longer ships these; delete them:\n  ${strays.join("\n  ")}`);
    process.exitCode = 1;
  }

  const source = readSource();
  const put = (relative, contents) => {
    const full = path.join(REPO_ROOT, relative);
    if (existsSync(full) && readFileSync(full, "utf8") === contents) return;
    writeFileSync(full, contents);
    written.push(relative);
  };
  put(OUTPUTS.docs, renderDocs(source, read(OUTPUTS.docs)));

  // Both read the copies above through `include_str!`, so they run after them.
  const schema = cargoExample("generate_schema", OUTPUTS.schema);
  if (schema === null) return;
  put(OUTPUTS.schema, schema);
  const builtins = cargoExample("generate_builtins", OUTPUTS.builtins);
  if (builtins === null) return;
  put(OUTPUTS.builtins, builtins);

  console.log(
    written.length === 0
      ? `${source.keys.length} theme keys; every copied and generated file was already current.`
      : `${source.keys.length} theme keys; rewrote:\n  ${written.join("\n  ")}`,
  );
}

function check() {
  const stale = staleOutputs();
  if (stale.length === 0) {
    console.log(`theme keys: every copy matches ${PACKAGE}, and every generated file its copy.`);
    return;
  }
  console.error(`Stale against ${PACKAGE}:`);
  for (const { path: relative, hint } of stale) console.error(`  ${relative}  — ${hint}`);
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
