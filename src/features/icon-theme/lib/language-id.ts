/**
 * A file's language id, as an icon theme's `languageIds` table names it.
 *
 * Icon themes (VS Code's format) can key an icon on the language a file is in
 * rather than on its extension; this is the extension → language half of that
 * lookup. Syntax highlighting does not read it: the file view's highlighter
 * infers its grammar from the file name itself.
 *
 * Extensions mapped to `PLAINTEXT` are listed on purpose, so a reader can tell
 * a considered "no language" from an oversight.
 */

/** A file with no language id: the icon theme's file-extension and
 *  file-name tables still apply. */
export const PLAINTEXT = "plaintext";

export const LANGUAGE_IDS = [
  "typescript",
  "javascript",
  "rust",
  "python",
  "go",
  "java",
  "c",
  "cpp",
  "json",
  "yaml",
  "markdown",
  "html",
  "css",
  "scss",
  "xml",
  "sql",
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** A language id, or explicit plaintext. */
export type EditorLanguage = LanguageId | typeof PLAINTEXT;

/** Extensions deliberately given no language id. */
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
  jsonc: PLAINTEXT,
};

/** Extension → language. Typed as `EditorLanguage`, so an entry naming an
 *  unknown id fails `bun run typecheck`. */
export const EXTENSION_LANGUAGE: Record<string, EditorLanguage> = {
  // Spread first so an explicit entry below wins rather than being shadowed.
  ...UNSUPPORTED,

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
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  xml: "xml",
  svg: "xml",
  sql: "sql",
};

/**
 * The lowercased extension of a path, or `""` when there is none. Reads the
 * basename first so a dot in a parent directory (`~/v1.2/README`) can't be
 * mistaken for the file's extension, and treats a leading dot as part of the
 * name — `.env` is a dotfile, not an `env` file.
 */
function fileExtension(path: string): string {
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

/** The language id of `path`; anything unrecognised is plaintext. */
export function detectLanguage(path: string): EditorLanguage {
  return EXTENSION_LANGUAGE[fileExtension(path)] ?? PLAINTEXT;
}
