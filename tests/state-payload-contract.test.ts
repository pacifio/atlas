import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the `save_app_state` / `bootstrap_app_state` payload **keys** — the
 * seam `tests/ipc-contract.test.ts` and `tests/event-contract.test.ts` leave
 * open. Those two check command and channel *names*; nothing checked the field
 * names inside a payload, and `tsc` cannot: `invoke()` takes `unknown`, and on
 * the Rust side `AppStatePatch` has no `deny_unknown_fields` while every
 * optional field is `#[serde(default)]`. A frontend key Rust does not know is
 * therefore not an error — it is silently dropped, the field deserializes to
 * its default, and `apply_patch` commits that default over the user's data.
 *
 * The bug that prompted this: the workspace→project rename froze the
 * *top-level* storage keys (`workspaces`, `activeWorkspaceId`) but not the
 * `activeWorkspaceId` nested one level down inside each `organisations[]` row,
 * which the frontend had renamed to `activeProjectId`. Every install would
 * have lost its per-org last-active project on the first save after upgrade.
 * Writing the test immediately turned up a second instance of the same class:
 * a project's `pinned` flag existed only on the frontend, so pinning a
 * project never survived a restart.
 *
 * ## What it does
 *
 * Parses the serde field names out of the Rust payload structs (honouring
 * `rename_all`, `rename`, `flatten`, `skip` and `default`) and the property
 * names out of the paired TypeScript interfaces, then compares the two sets in
 * whichever directions the payload actually travels:
 *
 * - **`in`** (frontend → Rust): every TS key must be a key Rust accepts, or it
 *   is dropped on the floor; and every Rust field without `#[serde(default)]`
 *   must be non-optional in TS, or the command rejects the payload outright.
 * - **`out`** (Rust → frontend): every Rust key must appear in the TS type, or
 *   the frontend is blind to state Rust persists.
 *
 * ## Why source text and not codegen
 *
 * Same trade as `ipc-contract.test.ts`: `tauri-specta` would check argument and
 * return *types* as well, but costs a build-time codegen step and a checked-in
 * generated file. This costs milliseconds and no build. Keys are where the
 * silent data loss lives; types are where `tsc` already helps.
 *
 * ## Adding a payload
 *
 * Add a row to `PAIRS`. Nothing else here needs updating — both sides are
 * derived from source.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Rust files searched for payload structs. */
const RUST_FILES = [
  path.join(REPO_ROOT, "src-tauri", "src", "state", "app_state.rs"),
  path.join(REPO_ROOT, "src-tauri", "src", "commands", "app_state.rs"),
];

const TS_APP_STORE = path.join(REPO_ROOT, "src", "features", "app", "stores", "app-store.ts");
const TS_ORG_TYPES = path.join(REPO_ROOT, "src", "features", "organisations", "types.ts");
const TS_PROJECT_STORE = path.join(
  REPO_ROOT,
  "src",
  "features",
  "projects",
  "stores",
  "project-store.ts",
);

// ---------------------------------------------------------------------------
// Rust parsing
// ---------------------------------------------------------------------------

interface RustField {
  /** serde wire name, after `rename_all` / `rename`. */
  wire: string;
  /** `#[serde(default)]` or `#[serde(default = "…")]`. */
  hasDefault: boolean;
  /** `#[serde(flatten)]` — the field's own type's keys are inlined instead. */
  flattenInto: string | null;
}

interface RustStruct {
  name: string;
  fields: RustField[];
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Minimal serde-aware struct reader. Deliberately not a Rust parser: it
 * recognises the exact shape every struct in these two files uses — attribute
 * lines, `pub struct Name {`, `pub field: Type,` — and the floors below fail
 * loudly if that stops being true.
 */
function parseRustStructs(source: string): Map<string, RustStruct> {
  const out = new Map<string, RustStruct>();
  const lines = source.split("\n");

  let attrs: string[] = [];
  let current: RustStruct | null = null;
  let fieldAttrs: string[] = [];
  let renameAll: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (current === null) {
      if (line.startsWith("#[")) {
        attrs.push(line);
        continue;
      }
      const start = /^pub struct (\w+)\s*\{$/.exec(line);
      if (start) {
        const joined = attrs.join(" ");
        const ra = /rename_all\s*=\s*"([^"]+)"/.exec(joined);
        renameAll = ra ? ra[1] : null;
        current = { name: start[1], fields: [] };
        fieldAttrs = [];
        attrs = [];
        continue;
      }
      // Anything else resets the attribute buffer (e.g. a `fn` or `impl`).
      if (line !== "" && !line.startsWith("//")) attrs = [];
      continue;
    }

    // Inside a struct body.
    if (line === "}") {
      out.set(current.name, current);
      current = null;
      renameAll = null;
      continue;
    }
    if (line.startsWith("//")) continue;
    if (line.startsWith("#[")) {
      fieldAttrs.push(line);
      continue;
    }
    const field = /^pub (\w+):\s*(.+?),?$/.exec(line);
    if (!field) {
      fieldAttrs = [];
      continue;
    }
    const [, name, ty] = field;
    const joined = fieldAttrs.join(" ");
    fieldAttrs = [];

    if (/\bserde\([^)]*\bskip\b/.test(joined)) continue;

    const renamed = /\brename\s*=\s*"([^"]+)"/.exec(joined);
    const wire = renamed ? renamed[1] : renameAll === "camelCase" ? toCamel(name) : name;

    current.fields.push({
      wire,
      hasDefault: /\bdefault\b/.test(joined),
      flattenInto: /\bflatten\b/.test(joined) ? ty.replace(/,$/, "").trim() : null,
    });
  }

  return out;
}

/** Wire keys of a struct, inlining `#[serde(flatten)]` fields. */
function rustKeys(
  structs: Map<string, RustStruct>,
  name: string,
): { all: Set<string>; required: Set<string> } {
  const s = structs.get(name);
  if (!s) throw new Error(`Rust struct ${name} not found — the parser or the source moved`);
  const all = new Set<string>();
  const required = new Set<string>();
  for (const f of s.fields) {
    if (f.flattenInto) {
      const nested = rustKeys(structs, f.flattenInto);
      for (const k of nested.all) all.add(k);
      for (const k of nested.required) required.add(k);
      continue;
    }
    all.add(f.wire);
    if (!f.hasDefault) required.add(f.wire);
  }
  return { all, required };
}

// ---------------------------------------------------------------------------
// TypeScript parsing
// ---------------------------------------------------------------------------

/** Strip comments without disturbing brace depth. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function parseTsInterface(
  source: string,
  name: string,
): { all: Set<string>; required: Set<string> } {
  const clean = stripComments(source);
  const header = new RegExp(`\\binterface\\s+${name}\\s*(?:extends[^{]+)?\\{`).exec(clean);
  if (!header) throw new Error(`TS interface ${name} not found — the parser or the source moved`);

  let depth = 0;
  let end = -1;
  const bodyStart = header.index + header[0].length;
  for (let i = bodyStart - 1; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`TS interface ${name} is unterminated`);
  const body = clean.slice(bodyStart, end);

  const all = new Set<string>();
  const required = new Set<string>();
  let nest = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const prop = nest === 0 ? /^(\w+)(\??)\s*:/.exec(line) : null;
    if (prop) {
      all.add(prop[1]);
      if (prop[2] === "") required.add(prop[1]);
    }
    for (const ch of line) {
      if (ch === "{") nest++;
      else if (ch === "}") nest--;
    }
  }
  return { all, required };
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

interface Pair {
  rust: string;
  ts: { file: string; name: string };
  /**
   * `in` — the frontend sends it (`save_app_state`).
   * `out` — Rust sends it (`bootstrap_app_state`).
   * `both` — the type is nested inside a payload that travels both ways.
   */
  direction: "in" | "out" | "both";
  /** Rust keys deliberately absent from the TS type, each with a reason. */
  rustOnly?: Record<string, string>;
  /** TS keys deliberately absent from the Rust type, each with a reason. */
  tsOnly?: Record<string, string>;
}

const PAIRS: Pair[] = [
  {
    rust: "BootstrapPayload",
    ts: { file: TS_APP_STORE, name: "AppStateWire" },
    direction: "out",
    rustOnly: {
      telemetryAnonId:
        "Rust-owned. Minted and persisted by `lib.rs` setup; the frontend must never see or echo it (see the `AppStatePatch` doc).",
    },
  },
  {
    rust: "AppStatePatch",
    ts: { file: TS_APP_STORE, name: "AppStatePatchWire" },
    direction: "in",
    tsOnly: {
      currentProject:
        "Legacy v1 field. The frontend still sends an explicit `null`; `AppStatePatch` deliberately does not accept it, and `apply_patch` hardcodes `None` so it can never be re-adopted.",
    },
  },
  {
    rust: "Organisation",
    ts: { file: TS_ORG_TYPES, name: "OrganisationWire" },
    direction: "both",
  },
  { rust: "Project", ts: { file: TS_PROJECT_STORE, name: "Project" }, direction: "both" },
  { rust: "RecentProject", ts: { file: TS_APP_STORE, name: "RecentProject" }, direction: "both" },
  { rust: "ProjectRef", ts: { file: TS_APP_STORE, name: "ProjectRef" }, direction: "both" },
];

const rustStructs = (() => {
  const merged = new Map<string, RustStruct>();
  for (const file of RUST_FILES) {
    for (const [name, s] of parseRustStructs(readFileSync(file, "utf8"))) merged.set(name, s);
  }
  return merged;
})();

const tsSources = new Map<string, string>();
function tsSource(file: string): string {
  let s = tsSources.get(file);
  if (s === undefined) {
    s = readFileSync(file, "utf8");
    tsSources.set(file, s);
  }
  return s;
}

describe("app-state payload contract", () => {
  /**
   * Floor against a vacuous pass: if a parser silently stops matching, every
   * derived set comes back empty and each `expect` below passes trivially.
   */
  it("parses both sides (no vacuous pass)", () => {
    expect(rustStructs.size).toBeGreaterThanOrEqual(PAIRS.length);
    for (const pair of PAIRS) {
      expect(rustKeys(rustStructs, pair.rust).all.size, `Rust ${pair.rust}`).toBeGreaterThanOrEqual(
        2,
      );
      expect(
        parseTsInterface(tsSource(pair.ts.file), pair.ts.name).all.size,
        `TS ${pair.ts.name}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(PAIRS)("$rust ↔ $ts.name", (pair) => {
    const rust = rustKeys(rustStructs, pair.rust);
    const ts = parseTsInterface(tsSource(pair.ts.file), pair.ts.name);
    const rustOnly = new Set(Object.keys(pair.rustOnly ?? {}));
    const tsOnly = new Set(Object.keys(pair.tsOnly ?? {}));

    // Every documented exception must still be real, or the note is stale.
    expect(
      [...rustOnly].filter((k) => !rust.all.has(k)),
      "stale rustOnly entries",
    ).toEqual([]);
    expect(
      [...tsOnly].filter((k) => !ts.all.has(k)),
      "stale tsOnly entries",
    ).toEqual([]);

    if (pair.direction !== "out") {
      // A TS key Rust does not accept is not an error at runtime — serde drops
      // it and `apply_patch` writes the default over the user's value.
      expect([...ts.all].filter((k) => !rust.all.has(k) && !tsOnly.has(k)).sort()).toEqual([]);
      // A Rust field with no `#[serde(default)]` that TS marks optional means
      // the whole command can reject the payload.
      expect([...rust.required].filter((k) => ts.all.has(k) && !ts.required.has(k)).sort()).toEqual(
        [],
      );
    }

    if (pair.direction !== "in") {
      // A Rust key missing from the TS type is state the frontend cannot read.
      expect([...rust.all].filter((k) => !ts.all.has(k) && !rustOnly.has(k)).sort()).toEqual([]);
    }
  });

  /**
   * The specific regression. Spelled out separately from the derived checks so
   * the failure message names the bug rather than a set difference.
   */
  it("keeps the frozen storage keys, including the nested one", () => {
    const patch = rustKeys(rustStructs, "AppStatePatch").all;
    expect(patch.has("workspaces")).toBe(true);
    expect(patch.has("activeWorkspaceId")).toBe(true);

    const org = rustKeys(rustStructs, "Organisation").all;
    expect(org.has("activeWorkspaceId")).toBe(true);
    expect(org.has("activeProjectId")).toBe(false);

    const wire = parseTsInterface(tsSource(TS_ORG_TYPES), "OrganisationWire").all;
    expect(wire.has("activeWorkspaceId")).toBe(true);
    expect(wire.has("activeProjectId")).toBe(false);

    // …and the store-side type keeps the app's own vocabulary, so the seam is
    // a real translation rather than the rename having been reverted.
    const store = parseTsInterface(tsSource(TS_ORG_TYPES), "Organisation").all;
    expect(store.has("activeProjectId")).toBe(true);
    expect(store.has("activeWorkspaceId")).toBe(false);
  });
});
