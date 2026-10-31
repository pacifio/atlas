// The order the Code tab lists a pull request's files in: the source first,
// each file after the files it imports, then the tests in the order of the
// source they cover, then what was generated (lockfiles, snapshots, build
// output, vendored code). A reader goes down the change the way it was built
// rather than the way the alphabet lays it out.
//
// Only the lines the diff shows are read for imports, so a dependency that
// did not change is no edge at all; a cycle falls back to path order.

import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffFileTier = "source" | "test" | "generated";

const GENERATED_FILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const GENERATED_DIRECTORIES = new Set([
  "__snapshots__",
  "__generated__",
  "dist",
  "build",
  "vendor",
]);
const TEST_DIRECTORIES = new Set(["__tests__", "tests", "test"]);
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function diffFileTier(path: string): DiffFileTier {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (
    GENERATED_FILE_NAMES.has(name) ||
    name.endsWith(".snap") ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    /\.generated\./.test(name) ||
    segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))
  ) {
    return "generated";
  }
  if (
    /\.(?:test|spec)\./.test(name) ||
    segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment))
  ) {
    return "test";
  }
  return "source";
}

/** The last segment of a path. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stripExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

function baseName(path: string): string {
  return stripExtension(fileName(path));
}

function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

function importedPaths(
  path: string,
  lines: readonly string[],
  byModulePath: ReadonlyMap<string, string>,
  byBaseName: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      const specifier = match[1] ?? "";
      const withExtension = specifier.startsWith(".")
        ? resolveRelative(path, specifier)
        : specifier;
      // A specifier may name an extension the module map dropped, and not
      // necessarily the one on disk: TypeScript imports name the `.js`
      // beside a `.ts`.
      const extension = MODULE_EXTENSIONS.find((candidate) => withExtension.endsWith(candidate));
      const resolved =
        extension === undefined ? withExtension : withExtension.slice(0, -extension.length);
      const target =
        byModulePath.get(resolved) ??
        byModulePath.get(`${resolved}/index`) ??
        byBaseName.get(baseName(resolved));
      if (target !== undefined && target !== path) imported.add(target);
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return imported;
}

function orderByImports(
  paths: readonly string[],
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const remaining = new Set(paths);
  const ordered: string[] = [];
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  while (remaining.size > 0) {
    const candidates = sorted.filter((path) => remaining.has(path));
    const next =
      candidates.find((path) =>
        [...(imports.get(path) ?? [])].every((dependency) => !remaining.has(dependency)),
      ) ?? candidates[0]!;
    remaining.delete(next);
    ordered.push(next);
  }
  return ordered;
}

function testedBaseName(path: string): string {
  return fileName(path)
    .replace(/\.(?:test|spec)\..*$/, "")
    .replace(/\.[^.]+$/, "");
}

/** `files` in reading order. `pathOf` names a file; `linesOf` gives the
 *  lines its diff shows (added and removed), where its imports are read. */
export function orderDiffFiles<T>(
  files: readonly T[],
  pathOf: (file: T) => string,
  linesOf: (file: T) => readonly string[],
): T[] {
  const byPath = new Map<string, T>();
  for (const file of files) byPath.set(pathOf(file), file);
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path));

  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const byModulePath = new Map<string, string>();
  const ambiguousBaseNames = new Set<string>();
  const byBaseName = new Map<string, string>();
  for (const path of sourcePaths) {
    byModulePath.set(stripExtension(path), path);
    const base = baseName(path);
    if (byBaseName.has(base)) ambiguousBaseNames.add(base);
    byBaseName.set(base, path);
  }
  for (const base of ambiguousBaseNames) byBaseName.delete(base);

  const imports = new Map<string, ReadonlySet<string>>();
  for (const path of sourcePaths) {
    imports.set(path, importedPaths(path, linesOf(byPath.get(path)!), byModulePath, byBaseName));
  }
  const orderedSource = orderByImports(sourcePaths, imports);

  const sourcePositions = new Map<string, number>();
  orderedSource.forEach((path, index) => {
    const base = baseName(path);
    if (!sourcePositions.has(base)) sourcePositions.set(base, index);
  });
  const orderedTests = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "test")
    .sort((left, right) => {
      const leftPosition = sourcePositions.get(testedBaseName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = sourcePositions.get(testedBaseName(right)) ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.localeCompare(right);
    });

  const orderedGenerated = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "generated")
    .sort((left, right) => left.localeCompare(right));

  return [...orderedSource, ...orderedTests, ...orderedGenerated].map((path) => byPath.get(path)!);
}

/** The lines a parsed diff shows, for `orderDiffFiles`. */
export function fileDiffLines(file: FileDiffMetadata): readonly string[] {
  return [...file.additionLines, ...file.deletionLines];
}
