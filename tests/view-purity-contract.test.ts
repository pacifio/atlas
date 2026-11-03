import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A file under a `views/` directory renders from its props alone.
 *
 * Desktop features are split into containers and views (ADR-0027, spec D14). A
 * container reads stores, calls `invoke()` and listens for events, then hands a
 * view plain props. A view only renders. That is what lets a view move into
 * `@tryatlas/design`, be shown with fixtures, and be redesigned without touching
 * the data path.
 *
 * Nothing else in the toolchain can see the line being crossed: a view that
 * imports a store type-checks, lints and renders exactly like a pure one. So the
 * rule is checked here, on every file under `src/**\/views/`:
 *
 * - no import from a `stores/` module, from a `*-api` IPC wrapper, or from
 *   `@tauri-apps/*`;
 * - no call to a `use…Store` hook, `.getState()` or `invoke(`.
 *
 * The check is on direct imports, not the whole import graph. A view may render
 * shared helpers (markdown, icons, `src/ui`) that do their own wiring. A view
 * that needs data should get it as a prop or a callback from its container.
 *
 * The only exit is a `view-purity-allow: <reason>` comment in the file, with a
 * reason of at least 40 characters. It should be rare: if a view needs a store,
 * it is a container, and belongs outside `views/`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");
const MIN_REASON = 40;

const FORBIDDEN_IMPORT = [
  { re: /\/stores\//, why: "imports a store module" },
  { re: /-api(?:\.ts)?$/, why: "imports an IPC wrapper (*-api)" },
  { re: /^@tauri-apps\//, why: "imports @tauri-apps" },
];

const FORBIDDEN_CALL = [
  { re: /\buse(?!SyncExternalStore\b)[A-Z]\w*Store\b/, why: "reads a Zustand store hook" },
  { re: /\.getState\s*\(/, why: "calls .getState()" },
  { re: /\binvoke\s*(?:<[^>]*>)?\s*\(/, why: "calls invoke()" },
];

const IMPORT_RE =
  /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const ALLOW_MARKER = /view-purity-allow:\s*(.*)$/m;

/** Source with comments blanked, so prose about stores doesn't count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function walk(dir: string, inViews = false): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, inViews || entry.name === "views"));
    else if (inViews && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  why: string;
}

export function violationsIn(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    for (const rule of FORBIDDEN_IMPORT) if (rule.re.test(spec)) found.push(`${rule.why}: ${spec}`);
  }
  for (const rule of FORBIDDEN_CALL) if (rule.re.test(code)) found.push(rule.why);
  return found;
}

const viewFiles = walk(SRC);

describe("view purity contract", () => {
  it("catches each forbidden form (the rule is not vacuous)", () => {
    expect(
      violationsIn(`import { useChatStore } from "@/features/chat/stores/chat-store";`),
    ).toHaveLength(2);
    expect(violationsIn(`import { listFiles } from "../lib/files-api";`)).toHaveLength(1);
    expect(
      violationsIn(`import { invoke } from "@tauri-apps/api/core"; invoke("x");`),
    ).toHaveLength(2);
    expect(violationsIn(`const s = useLayoutStore.getState();`)).toHaveLength(2);
    expect(
      violationsIn(`// useChatStore is read by the container\nexport function V() {}`),
    ).toEqual([]);
    expect(violationsIn(`import { Button } from "@/ui/button";`)).toEqual([]);
    expect(violationsIn(`const v = useSyncExternalStore(sub, get);`)).toEqual([]);
  });

  it("no file under a views/ directory reads stores or IPC", () => {
    const violations: Violation[] = [];
    const badAllows: string[] = [];
    for (const file of viewFiles) {
      const raw = readFileSync(file, "utf8");
      const where = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      const allow = ALLOW_MARKER.exec(raw);
      if (allow) {
        if (allow[1].trim().length < MIN_REASON) badAllows.push(where);
        continue;
      }
      for (const why of violationsIn(raw)) violations.push({ file: where, why });
    }
    expect(badAllows, "view-purity-allow needs a real reason (40+ chars)").toEqual([]);
    expect(violations).toEqual([]);
  });
});
