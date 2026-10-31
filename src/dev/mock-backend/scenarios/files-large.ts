// A project big enough to measure the review panel's Files view against: about
// 53,000 entries outside `node_modules` (100 packages × 20 modules × 25
// files, plus tests and docs) and 3,000 ignored packages inside it, with 300
// uncommitted changes spread through it. Listings are generated per path on
// demand, so nothing is materialized until the tree asks.
//
// Opens the Files surface. `fileindex_search` answers from every file outside
// `node_modules`, as the real index would, so the tree's search has the whole
// project to look in. Actions:
//   __atlasMock.actions.filesAddOne()   — a file appears on disk; the watcher fires
//   __atlasMock.actions.filesRemoveOne() — the last one added goes away again

import { emit } from "@tauri-apps/api/event";
import type { DirectoryListing, ProjectEntry } from "@/features/explorer/lib/fs-api";
import type { Scenario } from "../types";
import { diffPreviewOf, type PreviewChange } from "../fixtures/diff";
import { MOCK_PROJECT } from "../project";

const PACKAGES = 100;
const MODULES = 20;
const FILES = 25;
const TESTS = 10;
const DOCS = 200;
const DEPENDENCIES = 3_000;

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const dir = (path: string, ignored = false): ProjectEntry =>
  ignored ? { path, kind: "directory", ignored } : { path, kind: "directory" };
const file = (path: string, ignored = false): ProjectEntry =>
  ignored ? { path, kind: "file", ignored } : { path, kind: "file" };

/** Files that appeared at runtime (`filesAddOne`), per directory. */
const added = new Map<string, ProjectEntry[]>();

function generated(path: string): ProjectEntry[] | null {
  if (path === "") {
    return [
      dir("docs"),
      dir("node_modules", true),
      dir("packages"),
      file(".gitignore"),
      file("package.json"),
      file("README.md"),
    ];
  }
  if (path === "docs") {
    return Array.from({ length: DOCS }, (_, i) => file(`docs/guide-${pad(i, 3)}.md`));
  }
  if (path === "node_modules") {
    return Array.from({ length: DEPENDENCIES }, (_, i) =>
      dir(`node_modules/dep-${pad(i, 4)}`, true),
    );
  }
  const dep = /^node_modules\/dep-\d{4}$/.exec(path);
  if (dep) {
    return [
      dir(`${path}/lib`, true),
      file(`${path}/index.js`, true),
      file(`${path}/package.json`, true),
    ];
  }
  if (/^node_modules\/dep-\d{4}\/lib$/.test(path)) return [file(`${path}/main.js`, true)];
  if (path === "packages") {
    return Array.from({ length: PACKAGES }, (_, i) => dir(`packages/pkg-${pad(i, 3)}`));
  }
  if (/^packages\/pkg-\d{3}$/.test(path)) {
    return [
      dir(`${path}/src`),
      dir(`${path}/test`),
      file(`${path}/package.json`),
      file(`${path}/README.md`),
      file(`${path}/tsconfig.json`),
    ];
  }
  if (/^packages\/pkg-\d{3}\/src$/.test(path)) {
    return [
      ...Array.from({ length: MODULES }, (_, i) => dir(`${path}/mod-${pad(i, 2)}`)),
      file(`${path}/index.ts`),
    ];
  }
  if (/^packages\/pkg-\d{3}\/test$/.test(path)) {
    return Array.from({ length: TESTS }, (_, i) => file(`${path}/case-${pad(i, 2)}.test.ts`));
  }
  if (/^packages\/pkg-\d{3}\/src\/mod-\d{2}$/.test(path)) {
    return Array.from({ length: FILES }, (_, i) => file(`${path}/file-${pad(i, 3)}.ts`));
  }
  return null;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Every file the index would hold: all of them but `node_modules`, which a
 *  `.gitignore`-respecting walk skips. Built on the first search. */
let indexed: { rel: string; lower: string }[] | null = null;
function indexedFiles() {
  if (indexed) return indexed;
  const out: string[] = [];
  const walk = (path: string) => {
    for (const entry of listing(path).entries) {
      if (entry.ignored) continue;
      if (entry.kind === "directory") walk(entry.path);
      else out.push(entry.path);
    }
  };
  walk("");
  indexed = out.map((rel) => ({ rel, lower: rel.toLowerCase() }));
  return indexed;
}

/** The index's search, roughly: substring hits rank above subsequence ones. */
function searchIndex(query: string, limit: number) {
  const q = query.trim().toLowerCase();
  const exact: string[] = [];
  const loose: string[] = [];
  for (const { rel, lower } of indexedFiles()) {
    if (lower.includes(q)) exact.push(rel);
    else if (exact.length < limit) {
      let i = 0;
      for (const ch of lower) if (ch === q[i]) i++;
      if (i === q.length) loose.push(rel);
    }
    if (exact.length >= limit) break;
  }
  return [...exact, ...loose]
    .slice(0, limit)
    .map((rel) => ({ path: `${MOCK_PROJECT.path}/${rel}`, rel }));
}

function listing(path: string): DirectoryListing {
  const base = generated(path);
  if (!base) return { path, entries: [], error: `No such directory: ${path}` };
  const extra = added.get(path);
  if (!extra?.length) return { path, entries: base };
  const entries = [...base, ...extra].sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      nameOf(a.path).toLowerCase().localeCompare(nameOf(b.path).toLowerCase()),
  );
  return { path, entries };
}

/** 300 changes: every third package, the first five modules, two files each. */
const CHANGES: PreviewChange[] = [];
for (let p = 0; p < PACKAGES; p += 3) {
  for (let m = 0; m < 5; m++) {
    for (const f of [0, 7]) {
      const path = `packages/pkg-${pad(p, 3)}/src/mod-${pad(m, 2)}/file-${pad(f, 3)}.ts`;
      const before = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join("\n");
      const after = before.replace("v3 = 3", `v3 = ${p + m + f}`).replace("v8 = 8", "v8 = 80");
      CHANGES.push({
        path,
        before: f === 7 && m === 4 ? null : `${before}\n`,
        after: `${after}\n`,
        status: f === 7 && m === 4 ? "untracked" : "modified",
      });
    }
  }
}
const PREVIEW = diffPreviewOf(CHANGES, { baseRef: "origin/main", mergeBase: "0".repeat(40) });
const byPath = new Map(CHANGES.map((c) => [c.path, c]));

const ADD_DIR = "packages/pkg-000/src/mod-00";
let addedCount = 0;

export const filesLarge: Scenario = {
  name: "files-large",
  description: "The review panel's Files view on ~56,000 entries with 300 changes.",
  commands: {
    read_directories: ({ paths }) => ((paths ?? []) as string[]).map(listing),
    fileindex_open_project: () => indexedFiles().length,
    fileindex_search: ({ query, limit }) => searchIndex(String(query ?? ""), Number(limit ?? 100)),
    git_diff_preview: () => PREVIEW,
    git_diff_file_contents: ({ filePath }) => {
      const change = byPath.get(String(filePath));
      return {
        oldText: change?.before ?? "",
        newText: change?.after ?? "",
        truncated: false,
        binary: false,
      };
    },
  },
  setup: async () => {
    const { revealFiles } = await import("@/features/layout/lib/files-surface");
    revealFiles();
  },
  actions: {
    filesAddOne: () => {
      addedCount++;
      const list = added.get(ADD_DIR) ?? [];
      list.push(file(`${ADD_DIR}/new-${pad(addedCount, 3)}.ts`));
      added.set(ADD_DIR, list);
      void emit("atlas:explorer:changed", {
        workspaceId: MOCK_PROJECT.id,
        dirs: [`${MOCK_PROJECT.path}/${ADD_DIR}`],
        fullRefresh: false,
      });
    },
    filesRemoveOne: () => {
      const list = added.get(ADD_DIR);
      if (!list?.length) return "Nothing added to remove.";
      list.pop();
      void emit("atlas:explorer:changed", {
        workspaceId: MOCK_PROJECT.id,
        dirs: [`${MOCK_PROJECT.path}/${ADD_DIR}`],
        fullRefresh: false,
      });
    },
  },
};
