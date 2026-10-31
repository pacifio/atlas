// Which inline code and link destinations in a session's markdown name a file
// in its project.
//
// Pure and dependency-free: it runs inside the markdown worker
// (`markdown-render.ts`), once per rendered message string, and never touches
// the filesystem. The test is the shape of the text alone, then whether the
// path lands inside the project root. Whether the file EXISTS is a question
// for the click (`open-path-link.ts`), which asks the file index.
//
// Windows roots (`C:\Users\me\proj`) work: both sides are compared with `/`
// separators and an upper-case drive letter, and a resolved path comes back
// in the root's own separators. Inline code naming a drive-letter path is not
// detected (its colon reads as `host:port`); agents write relative paths
// almost all of the time.

/** A file a chip points at. */
export interface FileLinkTarget {
  /** Absolute, normalised: no `.` or `..` segments, no trailing slash. */
  path: string;
  /** 1-based, when the text named one (`a.ts:12`, `a.ts#L12`). */
  line?: number;
  column?: number;
  /** The text named a folder (a link destination ending in `/`). */
  folder: boolean;
}

/** `:12` or `:12:4` at the end. */
const POSITION_SUFFIX = /:(\d+)(?::(\d+))?$/;
/** `#L12` or `#L12C4` at the end. */
const POSITION_HASH = /#L(\d+)(?:C(\d+))?$/i;

/** A relative path that a person would write: dotted or bare segments. */
const RELATIVE_PREFIX = /^(?:\.{1,2}\/)/;
const FILE_EXTENSION = /\.[A-Za-z0-9_-]+$/;
/** `v1.2.3`, `react-19.0.1`: a version, not an extension. */
const VERSION_SUFFIX = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED = /^\d+(?:\.\d+)+$/;
/** Glob and shell metacharacters: `src/**\/*.ts` is a pattern, not a file. */
const GLOB_CHARS = /[*?[\]{}<>|"'$]/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const OTHER_SCHEME = /^(?:mailto|javascript|data|tel):/i;

/** Names that are files with no extension. */
const EXTENSIONLESS_FILES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);

/** Top-level domains a leading segment would end in if it were a host
 *  (`github.com/x/y.ts`, `example.co.uk/a.js`). */
const HOST_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "info",
  "me",
  "sh",
  "xyz",
  "uk",
  "de",
  "fr",
  "jp",
  "cn",
  "us",
  "ca",
  "au",
  "eu",
]);

/**
 * Folders whose names look like files: a macOS bundle (`Foo.app`) or an Xcode
 * project. A click shows them in the file manager rather than opening them as
 * a file — and never runs an app.
 */
const BUNDLE_EXTENSIONS = new Set([
  "app",
  "appex",
  "bundle",
  "framework",
  "xcframework",
  "kext",
  "plugin",
  "dsym",
  "lproj",
  "xcodeproj",
  "xcworkspace",
  "xcassets",
  "playground",
  "photoslibrary",
]);

/** Whether a base name is a bundle: a folder, though it reads like a file. */
export function isBundleName(base: string): boolean {
  const dot = base.lastIndexOf(".");
  return dot > 0 && BUNDLE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Ports a bare `name.ext:N` is far more likely to be (`server.js:8080`) than
 * a line number in a file written without its folder.
 */
const COMMON_PORTS = new Set([
  1080, 1433, 1521, 2375, 2376, 3000, 3001, 3306, 4000, 4200, 4443, 5000, 5001, 5173, 5432, 5672,
  6379, 6443, 7000, 8000, 8008, 8080, 8081, 8443, 8888, 9000, 9090, 9200, 9229, 9443,
]);
/** No file anyone points at has a line past this: `:123456` is not a line. */
const MAX_LINE = 99_999;

/**
 * Whether `name:N` reads as a host and port rather than a line: past any
 * plausible line, or a bare name (no folder) with a common port or a
 * five-digit number.
 */
function looksLikePort(path: string, line: number, column: number | undefined): boolean {
  if (line > MAX_LINE) return true;
  if (path.includes("/") || column !== undefined) return false;
  return COMMON_PORTS.has(line) || line >= 10_000;
}

function looksLikeHost(segment: string): boolean {
  if (segment.startsWith(".")) return false;
  if (segment === "localhost" || NUMERIC_DOTTED.test(segment)) return true;
  const labels = segment.toLowerCase().split(".");
  return labels.length >= 2 && HOST_TLDS.has(labels[labels.length - 1]);
}

/** A path and the position written after it. */
export function splitPosition(text: string): { path: string; line?: number; column?: number } {
  const match = text.match(POSITION_SUFFIX) ?? text.match(POSITION_HASH);
  if (!match || match.index === undefined) return { path: text };
  const line = Number(match[1]);
  const column = match[2] === undefined ? undefined : Number(match[2]);
  return {
    path: text.slice(0, match.index),
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

/**
 * The file path inline code names, or null when it is something else.
 *
 * A candidate needs a slash or a position (`a.ts:12`), must not hold
 * whitespace, a backtick, glob characters or a scheme, and its last segment
 * must look like a file name: an extension that is not a version number, or a
 * well-known extensionless name. Paths written with `./`, `../`, `~/` or a
 * leading `/` are taken at their word for the last segment.
 */
export function inlineCodePathCandidate(code: string): {
  path: string;
  line?: number;
  column?: number;
} | null {
  const text = code.trim();
  if (!text || /[\s`]/.test(text) || text.length > 400) return null;
  if (URL_SCHEME.test(text) || OTHER_SCHEME.test(text)) return null;
  const position = splitPosition(text);
  const { path } = position;
  const hasPosition = position.line !== undefined;
  if (!path || GLOB_CHARS.test(path) || path.includes("//")) return null;
  if (position.line !== undefined && looksLikePort(path, position.line, position.column)) {
    return null;
  }
  // A remaining colon is a scheme or a `host:port`, not a path.
  if (path.includes(":") || path.includes("#")) return null;
  if (!hasPosition && !path.includes("/")) return null;
  if (path.endsWith("/")) return null;

  const explicit = RELATIVE_PREFIX.test(path) || path.startsWith("~/") || path.startsWith("/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base || base === "." || base === "..") return null;
  if (!explicit) {
    const first = path.split("/")[0];
    if (looksLikeHost(first)) return null;
  }
  if (EXTENSIONLESS_FILES.has(base)) return position;
  if (!FILE_EXTENSION.test(base) || VERSION_SUFFIX.test(base)) return null;
  return position;
}

/**
 * A bare file name in inline code (`settings.json`, `Makefile`), with no
 * folder and no position: too loose to be a path on its own, so it is a
 * candidate only where a list of known files can confirm it (a pull request's
 * changed files, `file-chip-hast.ts`). Null for anything else.
 */
export function bareFileNameCandidate(code: string): { path: string } | null {
  const text = code.trim();
  if (!text || text.length > 255 || /[\s`/\\:#]/.test(text) || GLOB_CHARS.test(text)) return null;
  if (text === "." || text === ".." || looksLikeHost(text)) return null;
  if (EXTENSIONLESS_FILES.has(text)) return { path: text };
  if (!FILE_EXTENSION.test(text) || VERSION_SUFFIX.test(text) || NUMERIC_DOTTED.test(text)) {
    return null;
  }
  return { path: text };
}

/**
 * The file a link destination names, or null when it is a URL, an anchor, or
 * not file-shaped. A link may name a folder (`docs/`), and its text may be
 * anything: `[the helper](src/lib/api.ts#L10)`.
 */
export function linkHrefPathCandidate(href: string): {
  path: string;
  line?: number;
  column?: number;
  folder: boolean;
} | null {
  let text = href.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1);
  if (!text || text.startsWith("#") || text.startsWith("//")) return null;
  if (/^file:\/\//i.test(text)) text = text.slice("file://".length);
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) && !POSITION_SUFFIX.test(text)) return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep it as written */
  }
  // A query string is a web thing; a file link has none.
  if (text.includes("?")) return null;
  const position = splitPosition(text);
  let { path } = position;
  if (!path || GLOB_CHARS.test(path) || path.includes(":") || path.includes("#")) return null;
  const folder = path.endsWith("/");
  if (folder) path = path.replace(/\/+$/, "");
  if (!path) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const explicit = RELATIVE_PREFIX.test(path) || path.startsWith("~/") || path.startsWith("/");
  if (!explicit && looksLikeHost(path.split("/")[0])) return null;
  if (!folder && !EXTENSIONLESS_FILES.has(base)) {
    if (!FILE_EXTENSION.test(base) || VERSION_SUFFIX.test(base)) return null;
  }
  return { ...position, path, folder: folder || isBundleName(base) };
}

/** A drive-letter prefix, `C:`, with a separator (or nothing) after it. */
const DRIVE = /^([A-Za-z]):(?=[\\/]|$)/;

/** Whether `path` is absolute: POSIX `/…` or Windows `C:\…` / `C:/…`. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * `path` with `/` separators, `.` and `..` collapsed, no trailing slash, and
 * an upper-case drive letter: the form two paths are compared in. Null when
 * `..` climbs above the top.
 */
export function normalisePath(path: string): string | null {
  let rest = path.replace(/\\/g, "/");
  let prefix = "";
  const drive = rest.match(DRIVE);
  if (drive) {
    prefix = `${drive[1].toUpperCase()}:`;
    rest = rest.slice(2);
  }
  const out: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `${prefix}/${out.join("/")}`;
}

/** Whether `path` is `root` or inside it, whichever separators either uses. */
export function isUnderRoot(path: string, root: string): boolean {
  const p = normalisePath(path);
  const r = normalisePath(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** `path` (normalised) in the separators `root` is written with: `\` for a
 *  Windows root written that way. */
function inRootStyle(path: string, root: string): string {
  return DRIVE.test(root) && root.includes("\\") ? path.replace(/\//g, "\\") : path;
}

/** The home directory a (normalised) project root sits under, for `~/`. */
function homeOf(root: string): string | null {
  const match = root.match(/^(?:[A-Z]:)?\/(?:Users|home)\/[^/]+/);
  return match ? match[0] : null;
}

/**
 * Where `path` lands, if inside `root`: relative paths resolve against the
 * root, `~/` against the home the root sits in, and absolute paths are taken
 * as they are. Anything that ends up outside the root is null. The result is
 * written in the root's separators.
 */
export function resolveInProject(path: string, root: string): string | null {
  const cleanRoot = normalisePath(root);
  if (!cleanRoot || /^(?:[A-Z]:)?\/$/.test(cleanRoot)) return null;
  let absolute: string;
  if (isAbsolutePath(path)) absolute = path;
  else if (path.startsWith("~/")) {
    const home = homeOf(cleanRoot);
    if (!home) return null;
    absolute = `${home}/${path.slice(2)}`;
  } else absolute = `${cleanRoot}/${path}`;
  const resolved = normalisePath(absolute);
  if (!resolved) return null;
  if (resolved !== cleanRoot && !resolved.startsWith(`${cleanRoot}/`)) return null;
  return inRootStyle(resolved, root);
}

/**
 * The root a document's file chips resolve in: the open project when the
 * document is inside it, else the document's own folder. Null without a
 * document path.
 */
export function documentFileRoot(
  docPath: string | null | undefined,
  projectPath: string | null | undefined,
): string | null {
  if (!docPath || !isAbsolutePath(docPath)) return projectPath ?? null;
  if (projectPath && isUnderRoot(docPath, projectPath)) return projectPath;
  const cut = Math.max(docPath.lastIndexOf("/"), docPath.lastIndexOf("\\"));
  return cut > 0 ? docPath.slice(0, cut) : null;
}

/** The last segment of a path, either separator. */
export function baseNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** The project file inline code names, or null. A bundle (`build/Foo.app`)
 *  comes back as a folder. */
export function inlineCodeFileTarget(code: string, root: string): FileLinkTarget | null {
  const candidate = inlineCodePathCandidate(code);
  if (!candidate) return null;
  const path = resolveInProject(candidate.path, root);
  if (!path) return null;
  return { ...candidate, path, folder: isBundleName(baseNameOf(path)) };
}

/** The project file or folder a link destination names, or null. */
export function linkFileTarget(href: string, root: string): FileLinkTarget | null {
  const candidate = linkHrefPathCandidate(href);
  if (!candidate) return null;
  const path = resolveInProject(candidate.path, root);
  if (!path) return null;
  return { ...candidate, path };
}

/** The full path a chip's tooltip shows, with the position when named. */
export function fileChipTitle(target: FileLinkTarget): string {
  if (target.line === undefined) return target.path;
  return `${target.path}:${target.line}${target.column === undefined ? "" : `:${target.column}`}`;
}
