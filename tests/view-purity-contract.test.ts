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
 * - no import from a `stores/` module, from a `*-api` IPC wrapper, from
 *   `agent-meta.ts` (its `agentMeta()` reads the registry store), or from
 *   `@tauri-apps/*`;
 * - no call to a `use…Store` hook, `.getState()` or `invoke(`.
 *
 * The check is on direct imports, not the whole import graph. A view may render
 * shared helpers (markdown, icons, `@tryatlas/design`) that do their own wiring. A view
 * that needs data should get it as a prop or a callback from its container.
 *
 * The only exit is a `view-purity-allow: <reason>` comment in the file, with a
 * reason of at least 40 characters. It should be rare: if a view needs a store,
 * it is a container, and belongs outside `views/`.
 *
 * **Pure shared modules.** A few modules outside `views/` are rendered or called
 * by views everywhere: agent identity and the agent marks, and the Timeline and
 * Usage derivations that label agents. For those the direct check is not
 * enough, since the store used to arrive one import away (`agentMeta()` read the
 * registry store). `PURE_SHARED_MODULES` is therefore walked transitively: every
 * value import that resolves into `src/` is followed and held to the same rules,
 * and a violation is reported with the chain that reached it. Type-only imports
 * are not followed; they vanish at compile time.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");
const MIN_REASON = 40;

const FORBIDDEN_IMPORT = [
  { re: /\/stores\//, why: "imports a store module" },
  { re: /-api(?:\.ts)?$/, why: "imports an IPC wrapper (*-api)" },
  { re: /^@tauri-apps\//, why: "imports @tauri-apps" },
  // Not under `stores/`, but `agentMeta()` reads the registry store. A view
  // calls `useAgentMeta(id)` instead; types come from `agent-identity.ts`.
  {
    re: /(?:^|\/)agent-meta(?:\.ts)?$/,
    why: "imports agent-meta (reads the registry store; use useAgentMeta)",
  },
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

/**
 * Modules views lean on, checked through their whole value-import graph. A view
 * that needs agent identity calls `useAgentMeta(id)` (agent-meta-context.ts) or
 * takes an `AgentMeta` or a label as a prop; a container hands the pure libs a
 * resolver from `useAgentMetaResolver()`.
 */
const PURE_SHARED_MODULES = [
  "src/features/agents/lib/agent-identity.ts",
  "src/features/agents/lib/agent-meta-context.ts",
  "src/components/brand-marks/agent-mark.tsx",
  "src/features/artifacts/components/agent-glyph.tsx",
  "src/features/artifacts/lib/board.ts",
  "src/features/usage/lib/derive.ts",
];

/** `import type …`, `export type … from`, and `import { type A, type B }`: erased at
 *  compile time, so they neither count as a violation nor get followed. */
const TYPE_ONLY_IMPORT_RE = [
  /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s*["'][^"']+["'];?/g,
  /\bimport\s*\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}\s*from\s*["'][^"']+["'];?/g,
];

/** Source with comments and type-only imports blanked: what survives into JS. */
function valueSource(src: string): string {
  return TYPE_ONLY_IMPORT_RE.reduce((code, re) => code.replace(re, " "), stripComments(src));
}

const ASSET = /\.(?:svg|png|jpe?g|gif|webp|css|json)$|\?(?:url|raw)$/;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** A `./`, `../` or `@/` specifier as a file under `src/`; `null` for a package or an asset. */
function resolveSpecifier(spec: string, from: string): string | null {
  if (ASSET.test(spec)) return null;
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../"))
    base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  throw new Error(`cannot resolve "${spec}" from ${from}: fix the resolver`);
}

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/** Breadth-first over `entry`'s value imports; every violation, with the chain to it. */
export function transitiveViolations(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set([entry]);
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [rel(entry)] }];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    const code = valueSource(readFileSync(file, "utf8"));
    const why = violationsIn(code);
    if (why.length > 0) {
      // Do not descend into a module that is already forbidden.
      for (const w of why) found.push(`${w} via ${chain.join(" > ")}`);
      continue;
    }
    for (const m of code.matchAll(IMPORT_RE)) {
      const next = resolveSpecifier(m[1] ?? m[2], file);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push({ file: next, chain: [...chain, rel(next)] });
    }
  }
  return found;
}

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
    expect(violationsIn(`import { Button } from "@tryatlas/design";`)).toEqual([]);
    expect(violationsIn(`const v = useSyncExternalStore(sub, get);`)).toEqual([]);
    expect(
      violationsIn(`import { agentMeta } from "@/features/agents/lib/agent-meta";`),
    ).toHaveLength(1);
    expect(
      violationsIn(`import { useAgentMeta } from "@/features/agents/lib/agent-meta-context";`),
    ).toEqual([]);
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

  it("type-only imports are erased before the check", () => {
    expect(violationsIn(valueSource(`import type { S } from "../stores/s-store";`))).toEqual([]);
    expect(
      violationsIn(valueSource(`import { type S, type T as U } from "../stores/s-store";`)),
    ).toEqual([]);
    expect(
      violationsIn(valueSource(`export type { E } from "../lib/agent-registry-api";`)),
    ).toEqual([]);
    // A type alias is not an import: the value import after it still counts.
    expect(
      violationsIn(
        valueSource(`export type X = {\n  a: string\n}\nexport { y } from "../stores/y";`),
      ),
    ).toEqual(["imports a store module: ../stores/y"]);
    // A mixed import still brings a value in.
    expect(violationsIn(valueSource(`import { type S, useS } from "../stores/s-store";`))).toEqual([
      "imports a store module: ../stores/s-store",
    ]);
  });

  it("the shared-module walk reaches a store one import away (the rule is not vacuous)", () => {
    const meta = path.join(SRC, "features/agents/lib/agent-meta.ts");
    expect(transitiveViolations(meta).join("\n")).toContain("stores/agent-registry-store");
    const provider = path.join(SRC, "features/agents/components/agent-meta-provider.tsx");
    // The provider is the one container that binds identity to the live
    // registry: it subscribes to the registry's signature and reads agentMeta.
    expect(transitiveViolations(provider)).toEqual([
      "imports a store module: ../stores/agent-registry-store via src/features/agents/components/agent-meta-provider.tsx",
      "imports agent-meta (reads the registry store; use useAgentMeta): ../lib/agent-meta via src/features/agents/components/agent-meta-provider.tsx",
      "reads a Zustand store hook via src/features/agents/components/agent-meta-provider.tsx",
    ]);
  });

  it("pure shared modules reach no store or IPC through any import", () => {
    const violations: string[] = [];
    for (const module of PURE_SHARED_MODULES) {
      const file = path.join(REPO_ROOT, module);
      expect(existsSync(file), `${module} is listed but missing`).toBe(true);
      for (const v of transitiveViolations(file)) violations.push(`${module}: ${v}`);
    }
    expect(
      violations,
      "a pure shared module must take data or a resolver from its caller, not read a store",
    ).toEqual([]);
  });
});
