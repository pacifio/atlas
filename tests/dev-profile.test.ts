import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the dev profile (`crates/atlas-profile`): `bun run dev:app` runs a
 * source build on data of its own, so it never reads or writes the installed
 * Atlas's.
 *
 * The profile is derived from the bundle identifier the app is built with —
 * one switch, `src-tauri/tauri.dev.conf.json`, passed by `dev:app`. Everything
 * that keeps that switch honest is spread across files no compiler relates:
 * the npm script, two Tauri configs, and string constants in Rust. Each of
 * these can drift without a build error, and every drift fails the same quiet
 * way — the dev build silently reads and writes the released app's data:
 *
 *   - `dev:app` stops passing the overlay;
 *   - the overlay's identifier stops matching `DEV_IDENTIFIER`, so Tauri moves
 *     the app dir but `atlas-profile` keeps the default `.atlas` names;
 *   - someone writes a new `.join(".atlas")` instead of going through the
 *     profile.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_RS = path.join(REPO_ROOT, "crates", "atlas-profile", "src", "lib.rs");

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

/** `pub const NAME: &str = "…";` out of the profile crate. */
function rustConst(name: string): string {
  const m = readFileSync(PROFILE_RS, "utf8").match(
    new RegExp(`pub const ${name}: &str = "([^"]+)";`),
  );
  if (!m) throw new Error(`no ${name} in ${PROFILE_RS}`);
  return m[1];
}

/** The two arms of a `match self { Self::Default => "…", Self::Dev => "…" }`
 *  in the body of `fn <name>`. */
function rustArms(fn: string): { default: string; dev: string } {
  const src = readFileSync(PROFILE_RS, "utf8");
  const body = src.match(new RegExp(`fn ${fn}\\(self\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`));
  if (!body) throw new Error(`no fn ${fn} in ${PROFILE_RS}`);
  const def = body[1].match(/Self::Default => "([^"]*)"/);
  const dev = body[1].match(/Self::Dev => "([^"]*)"/);
  if (!def || !dev) throw new Error(`fn ${fn} has no Default/Dev arms`);
  return { default: def[1], dev: dev[1] };
}

describe("dev profile switch", () => {
  it("dev:app builds with the dev overlay", () => {
    const pkg = readJson("package.json") as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:app"]).toMatch(
      /\btauri dev\b.*--config src-tauri\/tauri\.dev\.conf\.json/,
    );
  });

  it("the overlay's identifier is the one atlas-profile reads as the dev profile", () => {
    const overlay = readJson("src-tauri/tauri.dev.conf.json");
    expect(overlay.identifier).toBe(rustConst("DEV_IDENTIFIER"));
    expect(overlay.productName).toBe(rustArms("product_name").dev);
  });

  it("the released config's identifier is the default profile's", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.identifier).toBe(rustConst("DEFAULT_IDENTIFIER"));
    expect(conf.productName).toBe(rustArms("product_name").default);
    expect(rustConst("DEV_IDENTIFIER")).not.toBe(rustConst("DEFAULT_IDENTIFIER"));
  });

  it("the overlay renames the app and changes nothing else", () => {
    // Anything more and a dev-profile build stops being the build under test.
    const keys = Object.keys(readJson("src-tauri/tauri.dev.conf.json")).filter(
      (k) => k !== "$schema",
    );
    expect(keys.sort()).toEqual(["identifier", "productName"]);
  });

  it("the repo ignores both profiles' project directories", () => {
    // Opening this repo in either build writes its directory here.
    const lines = read(".gitignore")
      .split(/\r?\n/)
      .map((l) => l.trim());
    const dirs = rustArms("dir_name");
    expect(lines).toContain(`${dirs.default}/`);
    expect(lines).toContain(`${dirs.dev}/`);
  });
});

/**
 * Files allowed to spell a profile's names out, with the reason. Everything
 * else resolves them through `atlas_profile` (`dir_name()` / `dir_in()` /
 * `config_dir_name()`).
 */
const LITERAL_ALLOWED: Record<string, string> = {
  "src-tauri/src/commands/shared_memory_contract.rs":
    "a test-only module (`#[cfg(test)] mod contract`) seeding a legacy fixture",
};

/** The crate that defines the names, and so may spell them out. */
const PROFILE_CRATE = "crates/atlas-profile/";

function rustSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["target", "tests", "testdata"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rustSources(full));
    else if (entry.name.endsWith(".rs") && entry.name !== "tests.rs") out.push(full);
  }
  return out;
}

interface RustLiteral {
  /** Offset of the first character inside the quotes. */
  start: number;
  /** The literal's source text between its quotes (escapes left as written). */
  text: string;
}

interface LexedRust {
  /** The source with comments and string-literal contents blanked to spaces
   *  (newlines kept), so brace matching and offsets stay true. */
  code: string;
  literals: RustLiteral[];
}

/**
 * Just enough of a Rust lexer to tell code from comments and string literals:
 * line and (nested) block comments, `"…"` with escapes, raw strings
 * (`r#"…"#`, `br"…"`), and char literals versus lifetimes. A regex over raw
 * lines cannot do this: a `//` inside a string, or a `"` or `{` inside a char
 * literal, throws everything after it off.
 */
function lexRust(src: string): LexedRust {
  const out = src.split("");
  const literals: RustLiteral[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? n : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    if ((c === "r" || c === "b" || c === "c") && !/\w/.test(src[i - 1] ?? "")) {
      const raw = /^(?:b|c)?r(#*)"/.exec(src.slice(i, i + 300));
      if (raw) {
        const close = `"${raw[1]}`;
        const start = i + raw[0].length;
        const found = src.indexOf(close, start);
        const end = found < 0 ? n : found;
        literals.push({ start, text: src.slice(start, end) });
        blank(start, end);
        i = end + close.length;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      literals.push({ start: i + 1, text: src.slice(i + 1, j) });
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      if (src[i + 1] === "\\") {
        const found = src.indexOf("'", i + 3);
        const end = found < 0 ? n : found + 1;
        blank(i, end);
        i = end;
        continue;
      }
      const width = (src.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
      if (src[i + 1 + width] === "'") {
        blank(i, i + 2 + width);
        i += 2 + width;
        continue;
      }
      i++; // a lifetime
      continue;
    }
    i++;
  }
  return { code: out.join(""), literals };
}

/** End offset (exclusive) of the bracketed group opening at `open`. */
function matchClose(code: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack: string[] = [];
  for (let j = open; j < code.length; j++) {
    const ch = code[j];
    if (ch in pairs) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return j + 1;
    }
  }
  return code.length;
}

/**
 * Drops every item under `#[cfg(test)]`, and only that item: its own
 * `{ … }` block, brace-matched, or up to its `;`. Production code after a
 * test module is still checked. A file that is test-only as a whole
 * (`#![cfg(test)]`) has nothing left.
 */
function withoutTestItems(lexed: LexedRust): LexedRust {
  const { code } = lexed;
  if (/#!\[cfg\(test\)\]/.test(code)) return { code: "", literals: [] };
  const cut: Array<[number, number]> = [];
  for (const m of code.matchAll(/#\[cfg\(test\)\]/g)) {
    const from = m.index;
    let j = from + m[0].length;
    for (;;) {
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] === "#" && code[j + 1] === "[") j = matchClose(code, j + 1);
      else break;
    }
    let to = code.length;
    for (let k = j; k < code.length; k++) {
      const ch = code[k];
      if (ch === "(" || ch === "[") {
        k = matchClose(code, k) - 1;
      } else if (ch === ";") {
        to = k + 1;
        break;
      } else if (ch === "{") {
        to = matchClose(code, k);
        break;
      }
    }
    cut.push([from, to]);
  }
  const inCut = (at: number) => cut.some(([a, b]) => at >= a && at < b);
  let stripped = code;
  for (const [a, b] of cut) {
    stripped =
      stripped.slice(0, a) + stripped.slice(a, b).replace(/[^\n]/g, " ") + stripped.slice(b);
  }
  return { code: stripped, literals: lexed.literals.filter((l) => !inCut(l.start)) };
}

/** A path segment named exactly `.atlas`, anywhere in a literal: `".atlas"`,
 *  `".atlas/x"` and `format!("{home}/.atlas/x")` alike. */
const ATLAS_DIR_SEGMENT = /(?:^|[/\\])\.atlas(?:$|[/\\])/;
/** `.config/atlas` spelled out in one literal. */
const CONFIG_ATLAS_PATH = /(?:^|[/\\])\.config[/\\]atlas(?:$|[/\\])/;
/** A literal naming the config root: `".config"` or `"XDG_CONFIG_HOME"`. */
const CONFIG_ROOT = /(?:^|[/\\])\.config(?:$|[/\\])|^XDG_CONFIG_HOME$/;
/** A path segment named exactly `atlas`: what gets joined onto that root. */
const ATLAS_SEGMENT = /(?:^|[/\\])atlas(?:$|[/\\])/;

/** The file's top-level items (a `fn`, a `const`, a whole `impl` or `mod`),
 *  as `[start, end)` spans of the blanked code. */
function topLevelItems(code: string): Array<[number, number]> {
  const items: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  for (let k = 0; k < code.length; k++) {
    const ch = code[k];
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0 && ch === "}") {
        items.push([start, k + 1]);
        start = k + 1;
      }
    } else if (ch === ";" && depth === 0) {
      items.push([start, k + 1]);
      start = k + 1;
    }
  }
  items.push([start, code.length]);
  return items;
}

/**
 * Every literal in one file's production code that spells a profile name out:
 *
 * - a `.atlas` path segment, or `.config/atlas`, in any literal;
 * - an `atlas` path segment in the same top-level item as a literal naming the
 *   config root (`".config"`, `"XDG_CONFIG_HOME"`), or in a top-level
 *   `const`/`static` that such an item uses.
 *
 * `atlas` on its own anywhere else is just a word (a theme id, a tool id, a
 * log target).
 */
function profileNameOffenders(src: string): Array<{ line: number; text: string }> {
  const { code, literals } = withoutTestItems(lexRust(src));
  if (!code.trim()) return [];
  const lineOf = (at: number) => src.slice(0, at).split("\n").length;
  const flagged = new Set<RustLiteral>(
    literals.filter((l) => ATLAS_DIR_SEGMENT.test(l.text) || CONFIG_ATLAS_PATH.test(l.text)),
  );
  const items = topLevelItems(code);
  const within = ([a, b]: [number, number]) => literals.filter((l) => l.start >= a && l.start < b);
  // Top-level `const NAME: &str = "atlas…";` / `static`: a name to look for.
  const namedAtlas = items.flatMap((item) => {
    const decl = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/.exec(
      code.slice(item[0], item[1]).replace(/#\[[^\]]*\]/g, ""),
    );
    const lits = within(item).filter((l) => ATLAS_SEGMENT.test(l.text));
    return decl && lits.length ? [{ name: decl[1], lits }] : [];
  });
  for (const item of items) {
    const lits = within(item);
    if (!lits.some((l) => CONFIG_ROOT.test(l.text))) continue;
    for (const l of lits) if (ATLAS_SEGMENT.test(l.text)) flagged.add(l);
    const body = code.slice(item[0], item[1]);
    for (const c of namedAtlas) {
      if (new RegExp(`\\b${c.name}\\b`).test(body)) for (const l of c.lits) flagged.add(l);
    }
  }
  return literals
    .filter((l) => flagged.has(l))
    .map((l) => ({ line: lineOf(l.start), text: l.text }));
}

describe("the profile-name scanner", () => {
  const flagged = (src: string) => profileNameOffenders(src).map((o) => o.text);

  it("catches the directory name however a literal spells it", () => {
    expect(flagged(`let a = root.join(".atlas");`)).toEqual([".atlas"]);
    expect(flagged(`let a = root.join(".atlas/memory");`)).toEqual([".atlas/memory"]);
    expect(flagged(`let a = format!("{home}/.atlas/memory");`)).toEqual(["{home}/.atlas/memory"]);
    expect(flagged(`let a = PathBuf::from(r"C:\\x\\.atlas");`)).toEqual(["C:\\x\\.atlas"]);
    expect(flagged(`let a = r#"~/.atlas"#;`)).toEqual(["~/.atlas"]);
  });

  it("catches `atlas` joined onto the config root", () => {
    expect(flagged(`home.join(".config").join("atlas")`)).toEqual(["atlas"]);
    expect(flagged(`fn r() { let x = var_os("XDG_CONFIG_HOME"); x.join("atlas/themes") }`)).toEqual(
      ["atlas/themes"],
    );
    expect(flagged(`home.join(".config/atlas/themes")`)).toEqual([".config/atlas/themes"]);
    // Through a constant, too.
    const viaConst = [
      `pub const DIR: &str = "atlas";`,
      `fn root(home: &Path) -> PathBuf {`,
      `    if let Some(x) = var_os("XDG_CONFIG_HOME") { return PathBuf::from(x).join(DIR); }`,
      `    home.join(".config").join(DIR)`,
      `}`,
    ].join("\n");
    expect(profileNameOffenders(viaConst)).toEqual([{ line: 1, text: "atlas" }]);
  });

  it("leaves `atlas` alone where it is not joined onto the config root", () => {
    expect(flagged(`let id = "atlas";`)).toEqual([]);
    // A theme id beside, but not inside, the config-root resolver.
    const beside = [
      `pub const DEFAULT_THEME_ID: &str = "atlas";`,
      `fn root(home: &Path) -> PathBuf { home.join(".config").join(profile::config_dir_name()) }`,
      `fn theme() -> &'static str { "atlas" }`,
    ].join("\n");
    expect(flagged(beside)).toEqual([]);
  });

  it("ignores comments, other names and test items", () => {
    expect(flagged(`// root.join(".atlas")\n/* ".atlas" /* nested */ */ let x = 1;`)).toEqual([]);
    expect(flagged(`let id = "dev.atlas.ide"; let o = ".atlas-dev-old";`)).toEqual([]);
    expect(flagged(`#[cfg(test)]\nmod tests {\n  fn f() { root.join(".atlas"); }\n}\n`)).toEqual(
      [],
    );
    expect(flagged(`#![cfg(test)]\nfn f() { root.join(".atlas"); }`)).toEqual([]);
  });

  it("keeps scanning production code after a test module", () => {
    const src = [
      `#[cfg(test)]`,
      `#[allow(dead_code)]`,
      `mod tests {`,
      `  const X: &str = "}";`,
      `  fn f() { let c = '{'; root.join(".atlas"); }`,
      `}`,
      `#[cfg(test)] use foo::bar;`,
      `fn prod() { root.join(".atlas"); }`,
    ].join("\n");
    expect(profileNameOffenders(src)).toEqual([{ line: 8, text: ".atlas" }]);
  });

  it("is not thrown off by quotes in char literals or by lifetimes", () => {
    const src = [
      `fn f<'a>(s: &'a str) -> char { let q = '"'; let e = '\\''; '\\u{22}' }`,
      `fn g() { root.join(".atlas"); }`,
    ].join("\n");
    expect(profileNameOffenders(src)).toEqual([{ line: 2, text: ".atlas" }]);
  });
});

describe("Atlas's on-disk names have one source", () => {
  const files = [
    ...rustSources(path.join(REPO_ROOT, "src-tauri", "src")),
    ...readdirSync(path.join(REPO_ROOT, "crates"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        try {
          return rustSources(path.join(REPO_ROOT, "crates", e.name, "src"));
        } catch {
          return [];
        }
      }),
  ];

  it("finds the Rust sources (parser health)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no production code spells out `.atlas` or `~/.config/atlas`", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (rel in LITERAL_ALLOWED || rel.startsWith(PROFILE_CRATE)) continue;
      for (const o of profileNameOffenders(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${o.line}: "${o.text}"`);
      }
    }
    // Route it through `atlas_profile::dir_name()` / `dir_in(root)` /
    // `config_dir_name()`, so the dev profile's `.atlas-dev` and
    // `~/.config/atlas-dev` reach it too.
    expect(offenders).toEqual([]);
  });
});
