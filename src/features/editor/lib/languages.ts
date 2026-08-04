import type { Extension } from "@codemirror/state";

/**
 * The editor's language registry — the single source of truth for both halves
 * of syntax highlighting.
 *
 * CodeMirror needs TWO things to highlight a file: a language extension (which
 * parses the text into a syntax tree) and a `syntaxHighlighting` style (which
 * colors the tree's tags). Atlas always installs the style, so a file that
 * renders as flat text is always a *missing language extension*.
 *
 * That used to be possible to get wrong silently: the file-extension table and
 * the loader `switch` lived in different files, so mapping `.rb` to a `"ruby"`
 * id that no loader handled produced an editor which reported the language as
 * Ruby and rendered it as plain text. The two are one structure here, and
 * `EXTENSION_LANGUAGE` is typed against `LANGUAGE_LOADERS`' own keys — a
 * mapping to a language with no loader is a `tsc` error, not a runtime shrug.
 *
 * Extensions we cannot parse map to `PLAINTEXT` explicitly (see
 * `UNSUPPORTED`), so "no highlighting" is always a recorded decision rather
 * than an accident.
 */

/** A file with no grammar: rendered as readable, unhighlighted text. */
export const PLAINTEXT = "plaintext";

type LanguageLoader = () => Promise<Extension>;

/**
 * Lazy per-language imports. Every entry is a dynamic `import()` so Rollup
 * splits each grammar into its own chunk — opening a `.py` file never pays for
 * the Java parser.
 */
const LANGUAGE_LOADERS = {
  typescript: async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ typescript: true, jsx: true });
  },
  javascript: async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ jsx: true });
  },
  rust: async () => {
    const { rust } = await import("@codemirror/lang-rust");
    return rust();
  },
  python: async () => {
    const { python } = await import("@codemirror/lang-python");
    return python();
  },
  go: async () => {
    const { go } = await import("@codemirror/lang-go");
    return go();
  },
  java: async () => {
    const { java } = await import("@codemirror/lang-java");
    return java();
  },
  c: async () => {
    const { cpp } = await import("@codemirror/lang-cpp");
    return cpp();
  },
  cpp: async () => {
    const { cpp } = await import("@codemirror/lang-cpp");
    return cpp();
  },
  json: async () => {
    const { json } = await import("@codemirror/lang-json");
    return json();
  },
  yaml: async () => {
    const { yaml } = await import("@codemirror/lang-yaml");
    return yaml();
  },
  markdown: async () => {
    const { markdown } = await import("@codemirror/lang-markdown");
    return markdown();
  },
  html: async () => {
    const { html } = await import("@codemirror/lang-html");
    return html();
  },
  css: async () => {
    const { css } = await import("@codemirror/lang-css");
    return css();
  },
  // SCSS is highlighted with the CSS grammar. Selectors, properties, values,
  // strings and comments — the bulk of any stylesheet — are shared, so the
  // approximation reads correctly; only Sass-only constructs (`$var`, `@mixin`)
  // fall back to unstyled text. Kept as its own id so the buffer still reports
  // what the file actually is.
  scss: async () => {
    const { css } = await import("@codemirror/lang-css");
    return css();
  },
  xml: async () => {
    const { xml } = await import("@codemirror/lang-xml");
    return xml();
  },
  sql: async () => {
    const { sql } = await import("@codemirror/lang-sql");
    return sql();
  },
} satisfies Record<string, LanguageLoader>;

/** A language Atlas can actually parse — one of `LANGUAGE_LOADERS`' keys. */
export type LanguageId = keyof typeof LANGUAGE_LOADERS;

/** What a buffer records: a parseable language, or explicit plaintext. */
export type EditorLanguage = LanguageId | typeof PLAINTEXT;

/**
 * File extensions we deliberately open as plaintext, and why. Listing them is
 * the point: without it, a reader can't tell a considered decision from an
 * oversight, which is how `.sh` and `.rb` ended up claiming a language they
 * never had.
 *
 * Every one of these needs `@codemirror/legacy-modes` (a `StreamLanguage`
 * grammar for shell/ruby/swift/kotlin/toml). That is a new top-level
 * dependency, which CONTRIBUTING asks be agreed in the issue first — so they
 * degrade honestly for now.
 *
 * TOML is here rather than on the YAML grammar on purpose. The two look alike
 * but disagree structurally (`[table]` is a YAML flow *sequence*; `k = v` is
 * not a YAML mapping), so YAML-parsed TOML is not "partly highlighted" — it is
 * confidently mis-highlighted, which is worse than plain text for a file you
 * are trying to read.
 */
const UNSUPPORTED: Record<string, typeof PLAINTEXT> = {
  sh: PLAINTEXT,
  bash: PLAINTEXT,
  zsh: PLAINTEXT,
  fish: PLAINTEXT,
  rb: PLAINTEXT,
  swift: PLAINTEXT,
  kt: PLAINTEXT,
  kts: PLAINTEXT,
  toml: PLAINTEXT,
  // The JSON grammar rejects comments outright, so `.jsonc` under it is a wall
  // of parse errors rather than a highlighted file.
  jsonc: PLAINTEXT,
};

/**
 * Extension → language. Typed as `EditorLanguage`, so an entry naming a
 * language with no loader fails `bun run typecheck` (and therefore CI) instead
 * of silently opening the file as plain text.
 */
export const EXTENSION_LANGUAGE: Record<string, EditorLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  ...UNSUPPORTED,
};

/**
 * The lowercased extension of a path, or `""` when there is none.
 *
 * Reads the basename first so a dot in a parent directory (`~/v1.2/README`)
 * can't be mistaken for the file's extension, and treats a leading dot as part
 * of the name — `.env` is a dotfile, not an `env` file.
 */
function fileExtension(path: string): string {
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

/**
 * The language to open `path` with. Anything unrecognised is plaintext, which
 * is a legible outcome — the editor's chrome, gutters and theme all still
 * apply, only the grammar is absent.
 */
export function detectLanguage(path: string): EditorLanguage {
  return EXTENSION_LANGUAGE[fileExtension(path)] ?? PLAINTEXT;
}

/** Whether a detected language will be parsed (and therefore highlighted). */
export function isHighlightable(language: EditorLanguage): language is LanguageId {
  return language !== PLAINTEXT;
}

/**
 * Load the CodeMirror extension for a language. Plaintext resolves to an empty
 * extension — no grammar, no highlighting, everything else unchanged.
 */
export function loadLanguageExtension(language: EditorLanguage): Promise<Extension> {
  if (!isHighlightable(language)) return Promise.resolve([]);
  return LANGUAGE_LOADERS[language]();
}

/** Every language with a loader. Exported for the mapping tests. */
export const LANGUAGE_IDS = Object.keys(LANGUAGE_LOADERS) as LanguageId[];
