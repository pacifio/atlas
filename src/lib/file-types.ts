/**
 * Classify a file path by its extension to decide which tab handler should
 * own it: the text editor (CodeMirror), the media viewer (img/video/audio),
 * or the unsupported-file fallback ("open in Finder").
 *
 * Anything not explicitly listed here falls through to "unsupported" — that's
 * intentional. We'd rather say "can't open this" up front than dump random
 * binary bytes into CodeMirror.
 */

export type FileKind = "text" | "image" | "svg" | "video" | "audio" | "pdf" | "notebook" | "unsupported";

// Extensions the CodeMirror editor handles (or can usefully attempt — even
// without a language extension, plaintext display is fine).
const TEXT_EXTS = new Set([
  // Code
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "rb", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp", "hh",
  "cs", "fs", "ml", "scala", "clj", "ex", "exs",
  "php", "lua", "r", "jl", "dart", "zig", "nim",
  // Web
  "html", "htm", "css", "scss", "sass", "less",
  "vue", "svelte", "astro",
  // Data / config
  "json", "jsonc", "yaml", "yml", "toml", "ini", "env",
  "xml", "csv", "tsv",
  // Shell / scripts
  "sh", "zsh", "bash", "fish", "ps1", "bat", "cmd",
  // Docs
  "md", "mdx", "txt", "rst", "tex", "org",
  // Misc
  "sql", "graphql", "gql", "proto", "thrift",
  "dockerfile", "makefile", "gitignore", "gitattributes",
  "editorconfig", "prettierrc", "eslintrc", "babelrc",
  "log", "lock",
]);

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "tif", "heic",
]);

const VIDEO_EXTS = new Set([
  "mp4", "mov", "webm", "mkv", "avi", "m4v",
]);

const AUDIO_EXTS = new Set([
  "mp3", "wav", "flac", "aac", "ogg", "oga", "opus", "m4a",
]);

const PDF_EXTS = new Set(["pdf"]);

// Jupyter notebooks are JSON but need cell-aware rendering (markdown/code
// cells + outputs), not raw JSON in CodeMirror, so they get their own kind.
const NOTEBOOK_EXTS = new Set(["ipynb"]);

// SVG is both renderable (it's an image) AND text (copyable source), so it gets
// its own viewer instead of the code editor or the raster image viewer.
const SVG_EXTS = new Set(["svg"]);

const EXTENSIONLESS_TEXT_NAMES = new Set([
  "readme", "license", "licence", "notice", "authors", "contributors",
  "changelog", "copying", "install", "todo", "makefile", "dockerfile",
  "gemfile", "rakefile", "procfile", "vagrantfile", "pipfile",
]);

export function classifyFile(path: string): FileKind {
  const last = path.split("/").pop() ?? path;
  const dot = last.lastIndexOf(".");
  const ext = (dot >= 0 ? last.slice(dot + 1) : "").toLowerCase();
  const base = (dot >= 0 ? last.slice(0, dot) : last).toLowerCase();
  const lower = last.toLowerCase();

  // `.env` and its variants (`.env.local`, `.env.production`, `.env.*`). The
  // dot-split above treats the trailing segment (`local`, `production`) as the
  // "extension", so these never match TEXT_EXTS — match the whole name here.
  if (lower === ".env" || lower.startsWith(".env.")) return "text";

  if (ext) {
    if (SVG_EXTS.has(ext)) return "svg";
    if (TEXT_EXTS.has(ext)) return "text";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (PDF_EXTS.has(ext)) return "pdf";
    if (NOTEBOOK_EXTS.has(ext)) return "notebook";
  }
  // Extensionless files like LICENSE, Makefile, Dockerfile.
  if (!ext && EXTENSIONLESS_TEXT_NAMES.has(base)) return "text";
  return "unsupported";
}
