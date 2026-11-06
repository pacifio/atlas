#!/usr/bin/env node
/**
 * Generates every derived copy of the settings registry from the one
 * hand-edited source, `src-tauri/settings-registry.toml`.
 *
 *   node scripts/generate-settings.mjs           rewrite the generated files
 *   node scripts/generate-settings.mjs --check    fail if any is stale
 *
 * Outputs:
 *   src-tauri/src/state/settings_docs.gen.rs          SETTINGS_DOCS, include!'d by
 *                                                     `state/atlas_config.rs`
 *   src/features/settings/lib/settings-registry.gen.ts
 *                                                     AppSettings, DEFAULT_SETTINGS
 *                                                     and SETTINGS_REGISTRY
 *   docs/reference/settings.json                      the registry for the docs site
 *   docs/reference/configuration.md                   the generated block only
 *
 * What this cannot reach is the Rust `AppSettings` struct itself: serde
 * attributes, defaults and the patch type stay hand-written, and
 * `the_settings_registry_matches_app_settings` (in `atlas_config.rs`) is what
 * holds them to this file. See the header of `settings-registry.toml` for the format.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_REL = "src-tauri/settings-registry.toml";
const SOURCE = path.join(REPO_ROOT, SOURCE_REL);
const COMMAND = "bun run settings:gen";

export const OUTPUTS = {
  rust: "src-tauri/src/state/settings_docs.gen.rs",
  registry: "src/features/settings/lib/settings-registry.gen.ts",
  json: "docs/reference/settings.json",
  docs: "docs/reference/configuration.md",
};

const DOCS_BEGIN = "<!-- generated:settings -->";
const DOCS_END = "<!-- /generated:settings -->";

export const TYPES = [
  "boolean",
  "integer",
  "number",
  "string",
  "enum",
  "string-list",
  "optional-string",
  "table",
];
export const STATUSES = ["live", "elsewhere", "file-only", "internal"];
const PLATFORMS = ["macos", "windows", "linux"];
/** Types whose default is "the key is absent from the file". */
const ABSENT_BY_DEFAULT = new Set(["optional-string", "table"]);

/** Width of a generated config.toml comment line, `# ` included. */
const COMMENT_WIDTH = 78;

// ─── A very small TOML reader ────────────────────────────────────────────────
// Same reasoning as the one in `generate-theme-keys.mjs`: `settings-registry.toml` is
// ours and machine-shaped, so a strict reader for the constructs it uses is
// shorter than a dependency. Anything it does not understand is an error with
// a line number, never a silently dropped field.

class TomlError extends Error {}

export function parseRegistryToml(text, sourceName = SOURCE_REL) {
  const lines = text.split("\n");
  const arrays = {};
  let table = null;
  let index = 0;

  const fail = (message) => {
    throw new TomlError(`${sourceName}:${index + 1}: ${message}`);
  };

  while (index < lines.length) {
    const trimmed = lines[index].trim();
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
    if (table === null) fail("a field before the first [[table]]");
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
    table[name] = parseValue(rest, fail);
    index += 1;
  }
  return arrays;
}

function parseString(rest, fail) {
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
  return { value: out, rest: rest.slice(at + 1) };
}

function expectEnd(rest, fail) {
  const trailing = rest.trim();
  if (trailing !== "" && !trailing.startsWith("#")) fail(`trailing text: ${trailing}`);
}

function parseValue(rest, fail) {
  if (rest.startsWith('"')) {
    const parsed = parseString(rest, fail);
    expectEnd(parsed.rest, fail);
    return parsed.value;
  }
  if (rest.startsWith("[")) {
    // A one-line array of strings — the only array shape the registry uses.
    const items = [];
    let remaining = rest.slice(1).trimStart();
    while (!remaining.startsWith("]")) {
      if (!remaining.startsWith('"')) fail("arrays may only hold strings");
      const parsed = parseString(remaining, fail);
      items.push(parsed.value);
      remaining = parsed.rest.trimStart();
      if (remaining.startsWith(",")) remaining = remaining.slice(1).trimStart();
      else if (!remaining.startsWith("]")) fail("expected `,` or `]` in array");
    }
    expectEnd(remaining.slice(1), fail);
    return items;
  }
  const value = rest.split("#")[0].trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (!/^-?\d+(\.\d+)?$/.test(value)) fail(`unsupported value \`${value}\``);
  // Kept as the source lexeme so `1.0` stays `1.0` in the generated comment.
  return { number: value };
}

// ─── Reading and validating the source ───────────────────────────────────────

const isNumber = (value) => typeof value === "object" && value !== null && "number" in value;

export function readSource(text = readFileSync(SOURCE, "utf8")) {
  const parsed = parseRegistryToml(text);
  const pages = parsed.page ?? [];
  const settings = parsed.setting ?? [];
  const problems = [];
  const pageIds = pages.map((page) => page.id);

  if (pages.length === 0) problems.push("no [[page]] tables");
  for (const page of pages) {
    for (const field of ["id", "title", "description"]) {
      if (typeof page[field] !== "string") problems.push(`page ${page.id}: missing \`${field}\``);
    }
  }
  if (new Set(pageIds).size !== pageIds.length) problems.push("duplicate page ids");

  const seen = new Set();
  for (const setting of settings) {
    const at = `setting \`${setting.key ?? "?"}\``;
    for (const field of [
      "key",
      "type",
      "status",
      "page",
      "section",
      "title",
      "summary",
      "doc",
      "validation",
    ]) {
      if (typeof setting[field] !== "string") problems.push(`${at}: missing \`${field}\``);
    }
    if (typeof setting.key !== "string") continue;
    if (seen.has(setting.key)) problems.push(`${at}: defined twice`);
    seen.add(setting.key);
    if (!/^[a-z][A-Za-z0-9]*$/.test(setting.key)) problems.push(`${at}: not camelCase`);
    if (!TYPES.includes(setting.type)) problems.push(`${at}: unknown type \`${setting.type}\``);
    if (!STATUSES.includes(setting.status))
      problems.push(`${at}: unknown status \`${setting.status}\``);
    if (!pageIds.includes(setting.page)) problems.push(`${at}: unknown page \`${setting.page}\``);
    if ((setting.title ?? "").endsWith(".")) problems.push(`${at}: title ends with a period`);
    if (!(setting.summary ?? "").endsWith(".")) problems.push(`${at}: summary must be a sentence`);
    if (/^#/m.test(setting.doc ?? "")) problems.push(`${at}: doc must be prose, not comments`);
    if (/\(default:/.test(setting.doc ?? ""))
      problems.push(`${at}: doc restates its default; the generator appends it`);

    const absent = ABSENT_BY_DEFAULT.has(setting.type);
    if (absent && setting.default !== undefined)
      problems.push(`${at}: a ${setting.type} has no default (it is absent)`);
    if (!absent && setting.default === undefined) problems.push(`${at}: missing \`default\``);
    if (!absent && setting.default !== undefined) {
      const fault = defaultFault(setting);
      if (fault) problems.push(`${at}: ${fault}`);
    }
    if ((setting.type === "enum") !== Array.isArray(setting.values))
      problems.push(`${at}: \`values\` is for enums, and enums need it`);
    for (const bound of ["min", "max"]) {
      if (setting[bound] === undefined) continue;
      if (!["integer", "number"].includes(setting.type) || !isNumber(setting[bound]))
        problems.push(`${at}: \`${bound}\` is for numeric settings`);
    }
    if ((setting.status === "elsewhere") !== (typeof setting.set_in === "string"))
      problems.push(`${at}: \`set_in\` is for status "elsewhere", and it needs one`);
    for (const platform of setting.platforms ?? []) {
      if (!PLATFORMS.includes(platform)) problems.push(`${at}: unknown platform \`${platform}\``);
    }
    if ((setting.ts_type === undefined) !== (setting.ts_import === undefined))
      problems.push(`${at}: \`ts_type\` and \`ts_import\` come together`);
    if (setting.type === "table" && setting.ts_type === undefined)
      problems.push(`${at}: a table needs a \`ts_type\``);
    if (setting.project !== undefined && ![true, false, "tighten"].includes(setting.project))
      problems.push(`${at}: \`project\` is true, false or "tighten"`);
    if (setting.project === "tighten" && setting.type !== "boolean")
      problems.push(`${at}: only a boolean can be tighten-only`);
    if (setting.project && setting.status !== "live")
      problems.push(`${at}: only a live setting can be set per project`);
  }

  if (problems.length > 0) {
    throw new Error(`${SOURCE_REL} has problems:\n  ${problems.join("\n  ")}`);
  }
  return { pages, settings };
}

function defaultFault(setting) {
  const value = setting.default;
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "default must be true or false";
    case "integer":
    case "number": {
      if (!isNumber(value)) return "default must be a number";
      if (setting.type === "integer" && value.number.includes("."))
        return "an integer default has no fraction";
      if (setting.type === "number" && !value.number.includes("."))
        return "a number default needs a fraction (1.0, not 1), as TOML writes floats";
      const n = Number(value.number);
      if (setting.min && n < Number(setting.min.number)) return "default is below min";
      if (setting.max && n > Number(setting.max.number)) return "default is above max";
      return null;
    }
    case "string":
      return typeof value === "string" ? null : "default must be a string";
    case "enum":
      return setting.values?.includes(value) ? null : "default must be one of `values`";
    case "string-list":
      return Array.isArray(value) ? null : "default must be an array of strings";
    default:
      return null;
  }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

/** A default as it is written in TOML, and so in a comment. */
export function tomlLiteral(setting) {
  const value = setting.default;
  if (value === undefined) return null;
  if (isNumber(value)) return value.number;
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The comment written above a key in a fresh `config.toml`: its prose, then
 * its default. A key absent by default is named in the comment, because the
 * comment is all a reader finds of it (`annotate` carries it down onto the
 * next key that is present).
 */
export function configComment(setting) {
  let text = setting.doc;
  if (ABSENT_BY_DEFAULT.has(setting.type)) text = `${setting.key}: ${text}`;
  const literal = tomlLiteral(setting);
  if (literal !== null) text = `${text} (default: ${literal})`;
  if (setting.project === "tighten")
    text = `${text} A project can turn it off, never on, in its own .atlas/config.toml.`;
  else if (setting.project)
    text = `${text} A project can override it in its own .atlas/config.toml.`;
  return wrap(text, COMMENT_WIDTH - 2)
    .map((line) => `# ${line}`)
    .join("\n");
}

const GENERATED_NOTE = `Generated from ${SOURCE_REL} — do not edit. Run \`${COMMAND}\` after editing that file.`;

// ─── Outputs ─────────────────────────────────────────────────────────────────

function renderRust({ settings }) {
  const rustString = (text) =>
    `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
  const entries = settings
    .map(
      (setting) =>
        `    (\n        "${setting.key}",\n        ${rustString(configComment(setting))},\n    ),`,
    )
    .join("\n");
  const projectKeys = settings
    .filter((setting) => setting.project)
    .map((setting) => `    "${setting.key}",`)
    .join("\n");
  const tightenKeys = settings
    .filter((setting) => setting.project === "tighten")
    .map((setting) => `    "${setting.key}",`)
    .join("\n");
  return `// ${GENERATED_NOTE}
//
// camelCase key → the comment written directly above it in a generated
// \`config.toml\`, in \`AppSettings\` field order. \`include!\`d by
// \`state/atlas_config.rs\`; see \`SETTINGS_DOCS\` there.

const SETTINGS_DOCS: &[(&str, &str)] = &[
${entries}
];

/// The keys a project's \`.atlas/config.toml\` may override (\`project\` in the
/// registry). Any other key there is ignored and reported.
pub const PROJECT_SETTING_KEYS: &[&str] = &[
${projectKeys}
];

/// Of those, the booleans a project may only turn off (\`project = "tighten"\`):
/// a repository can commit that file, so it never switches on what the user
/// switched off.
pub const PROJECT_TIGHTEN_ONLY_KEYS: &[&str] = &[
${tightenKeys}
];
`;
}

function tsType(setting) {
  if (setting.ts_type) return setting.ts_type;
  switch (setting.type) {
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "enum":
      return setting.values.map((value) => JSON.stringify(value)).join(" | ");
    case "string-list":
      return "string[]";
    case "optional-string":
      return "string | null";
    default:
      throw new Error(`no TS type for ${setting.type}`);
  }
}

function tsDefault(setting) {
  if (setting.ts_default !== undefined) return setting.ts_default;
  if (setting.type === "optional-string") return "null";
  const value = setting.default;
  if (isNumber(value)) return String(Number(value.number));
  return JSON.stringify(value);
}

function jsDoc(text, indent) {
  const lines = wrap(text, 96 - indent.length - 3);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`].join("\n");
}

/** Metadata the Settings UI and its search read; prose for humans stays in `doc`. */
function metaFor(setting) {
  const meta = {
    key: setting.key,
    type: setting.type,
    status: setting.status,
    page: setting.page,
    section: setting.section,
    title: setting.title,
    summary: setting.summary,
  };
  if (setting.values) meta.values = setting.values;
  if (setting.min) meta.min = Number(setting.min.number);
  if (setting.max) meta.max = Number(setting.max.number);
  if (setting.platforms) meta.platforms = setting.platforms;
  if (setting.applies) meta.applies = setting.applies;
  if (setting.set_in) meta.setIn = setting.set_in;
  if (setting.project) meta.project = setting.project;
  return meta;
}

function tsLiteral(value, indent) {
  if (Array.isArray(value)) {
    const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    return inline;
  }
  if (typeof value === "object") {
    const inner = Object.entries(value)
      .map(([name, item]) => `${indent}  ${name}: ${tsLiteral(item, `${indent}  `)},`)
      .join("\n");
    return `{\n${inner}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function renderRegistry({ pages, settings }) {
  const imports = new Map();
  for (const setting of settings) {
    if (!setting.ts_import) continue;
    const names = imports.get(setting.ts_import) ?? new Set();
    names.add(setting.ts_type);
    imports.set(setting.ts_import, names);
  }
  const importLines = [...imports]
    .map(([from, names]) => `import type { ${[...names].sort().join(", ")} } from "${from}";`)
    .join("\n");

  const fields = settings
    .map((setting) => `${jsDoc(setting.doc, "  ")}\n  ${setting.key}: ${tsType(setting)};`)
    .join("\n");
  const defaults = settings.map((setting) => `  ${setting.key}: ${tsDefault(setting)},`).join("\n");
  const pageList = pages.map((page) => `  ${tsLiteral(page, "  ")},`).join("\n");
  const registry = settings.map((setting) => `  ${tsLiteral(metaFor(setting), "  ")},`).join("\n");

  return `// ${GENERATED_NOTE}
${importLines ? `\n${importLines}\n` : ""}
/**
 * Every key under \`[settings]\` in \`config.toml\`, typed. The Rust side is
 * \`AppSettings\` in \`src-tauri/src/state/atlas_config.rs\`; a Rust test holds
 * that struct to the same source this file is generated from.
 */
export interface AppSettings {
${fields}
}

export type SettingKey = keyof AppSettings;

export const DEFAULT_SETTINGS: AppSettings = {
${defaults}
};

export type SettingType = ${TYPES.map((type) => JSON.stringify(type)).join(" | ")};

/**
 * Where a setting is changed: a Settings row (\`live\`), another part of the app
 * (\`elsewhere\`), only by editing the file (\`file-only\`),
 * or by Atlas itself (\`internal\`).
 */
export type SettingStatus = ${STATUSES.map((status) => JSON.stringify(status)).join(" | ")};

export const SETTINGS_PAGES = [
${pageList}
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]["id"];

export interface SettingMeta {
  key: SettingKey;
  type: SettingType;
  status: SettingStatus;
  page: SettingsPageId;
  section: string;
  title: string;
  summary: string;
  values?: readonly string[];
  min?: number;
  max?: number;
  platforms?: readonly ("macos" | "windows" | "linux")[];
  /** When a change takes effect, if not immediately. */
  applies?: string;
  /** For \`elsewhere\`: where in the app it is changed. */
  setIn?: string;
  /** A project's \`.atlas/config.toml\` can override it — \`"tighten"\`: only
   *  turn it off. */
  project?: true | "tighten";
}

export const SETTINGS_REGISTRY: readonly SettingMeta[] = [
${registry}
];
`;
}

function renderJson({ pages, settings }) {
  const body = {
    $comment: GENERATED_NOTE,
    pages,
    settings: settings.map((setting) => ({
      ...metaFor(setting),
      default: tomlLiteral(setting),
      doc: setting.doc.split(/\s+/).join(" "),
      validation: setting.validation,
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function docsType(setting) {
  switch (setting.type) {
    case "enum":
      return setting.values.map((value) => `\`"${value}"\``).join(" \\| ");
    case "string-list":
      return "array of strings";
    case "optional-string":
      return "string, or absent";
    default:
      return setting.type;
  }
}

function docsWhere(setting, pages) {
  const page = pages.find((entry) => entry.id === setting.page);
  switch (setting.status) {
    case "live":
      return `${page.title} › ${setting.section} › ${setting.title}${setting.project === "tighten" ? " (a project can turn it off)" : setting.project ? " (per project too)" : ""}`;
    case "elsewhere":
      return setting.set_in;
    case "file-only":
      return "file only";
    default:
      return "managed by Atlas";
  }
}

function renderDocsBlock({ pages, settings }) {
  const escape = (text) => text.replaceAll("|", "\\|");
  const rows = settings.map((setting) => {
    const literal = tomlLiteral(setting);
    const fallback = setting.type === "table" ? "absent" : "absent";
    const cells = [
      `\`${setting.key}\``,
      docsType(setting),
      literal === null ? fallback : `\`${literal}\``,
      escape(docsWhere(setting, pages)),
      escape(setting.validation),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [
    DOCS_BEGIN,
    `<!-- ${GENERATED_NOTE} -->`,
    "",
    "| Key | Type | Default | Where to change it | Validation |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    DOCS_END,
  ].join("\n");
}

function spliceDocs(current, block) {
  const begin = current.indexOf(DOCS_BEGIN);
  const end = current.indexOf(DOCS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${OUTPUTS.docs} has no ${DOCS_BEGIN} … ${DOCS_END} block`);
  }
  return current.slice(0, begin) + block + current.slice(end + DOCS_END.length);
}

/**
 * The TS output goes through the repo's own formatter rather than a printer
 * here that would have to agree with it byte for byte: `format:check` covers
 * `src/`, and two formatters disagreeing on one line wrap is a red CI either
 * way. `oxfmt` is a pinned dev dependency, so the output is deterministic.
 */
function formatTs(content, relative) {
  // On Windows, `bun install` puts an `oxfmt.exe` in `.bin` and npm an
  // `oxfmt.cmd` shim, which only runs through a shell. Use whichever exists.
  const bin = path.join(REPO_ROOT, "node_modules", ".bin");
  const cmd =
    process.platform !== "win32"
      ? path.join(bin, "oxfmt")
      : ([path.join(bin, "oxfmt.exe"), path.join(bin, "oxfmt.cmd")].find(existsSync) ??
        path.join(bin, "oxfmt.cmd"));
  const result = spawnSync(cmd, [`--stdin-filepath=${relative}`], {
    input: content,
    encoding: "utf8",
    cwd: REPO_ROOT,
    shell: cmd.endsWith(".cmd"),
  });
  if (result.status !== 0) {
    throw new Error(`oxfmt failed on ${relative}: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

/** Every output's expected content, keyed by repo-relative path. */
export function renderAll(source = readSource()) {
  const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
  return [
    { path: OUTPUTS.rust, content: renderRust(source) },
    { path: OUTPUTS.registry, content: formatTs(renderRegistry(source), OUTPUTS.registry) },
    { path: OUTPUTS.json, content: renderJson(source) },
    { path: OUTPUTS.docs, content: spliceDocs(read(OUTPUTS.docs), renderDocsBlock(source)) },
  ];
}

export function staleOutputs(source = readSource()) {
  return renderAll(source).filter((entry) => {
    let current;
    try {
      current = readFileSync(path.join(REPO_ROOT, entry.path), "utf8");
    } catch {
      return true;
    }
    return current !== entry.content;
  });
}

function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const stale = staleOutputs();
    if (stale.length > 0) {
      console.error(
        `Stale settings outputs (run \`${COMMAND}\`):\n  ${stale.map((entry) => entry.path).join("\n  ")}`,
      );
      process.exit(1);
    }
    return;
  }
  for (const entry of renderAll()) {
    writeFileSync(path.join(REPO_ROOT, entry.path), entry.content);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
