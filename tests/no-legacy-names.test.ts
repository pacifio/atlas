import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The retired names stay retired (ADR-0011).
 *
 * Two names left the tree in one sweep and this test keeps them out. They
 * are not the same kind of word, so they get two regimes:
 *
 * - **The experimental SDK the native agent was once named after.** Nothing
 *   legitimate spells it any more. Banned everywhere, in any case, except the
 *   one migration that deletes rows recorded under it and the historical
 *   record (ADRs, archived docs, the rename spec).
 *
 * - **The upstream product the engine was forked from.** Its name is also
 *   the name of a *different* product Atlas runs as a third-party ACP agent
 *   (OpenAI's Codex CLI), which the app layer may talk about by name. So in
 *   the engine's own territory — the vendored tree, the seam crate, the
 *   manifests, CI, the contract tests, the living docs — the word is banned
 *   outright; everywhere else only its engine-shaped spellings are: crate
 *   and module identifiers, its env vars, its dot-directory, the old vendor
 *   path, and prose that calls the engine by it.
 *
 * Lines the licence or the wire own are allowed anywhere: the §4(b) notice,
 * URLs, upstream model ids, the bundled licence filenames.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_SDK = /cersei/i;
const UPSTREAM = /codex/i;
/** How the engine spelled its upstream name: identifiers, env, paths, prose. */
const ENGINE_SHAPED = new RegExp(
  [
    String.raw`vendor/codex`,
    String.raw`\bcodex[-_](?:core|protocol|api|config|login|app[-_]server|exec[-_]server|models[-_]manager|model[-_]provider|otel|feedback|analytics|arg0|rollout|sandboxing|home|mcp|client|utils|shell[-_]command|hooks|state|file[-_]search|apply[-_]patch|linux[-_]sandbox|windows[-_]sandbox|features|git[-_]utils|http[-_]client|rmcp[-_]client|skills|plugin|core[-_]plugins|thread[-_]store|history|tools|prompts|execpolicy|process[-_]hardening|network[-_]proxy|keyring[-_]store|secrets|uds|backend[-_]client|cloud[-_]config|connectors|chatgpt|agent[-_]identity|workload[-_]identity|aws[-_]auth|diagnostics|memories|guardian|goal|queue|web[-_]search|image[-_]generation|external[-_]agent[-_]migration|collaboration[-_]mode|context[-_]fragments|install[-_]context|terminal[-_]detection|response[-_]debug|rollout[-_]trace|async[-_]utils|file[-_]system|file[-_]watcher|websocket[-_]client|code[-_]mode|experimental[-_]api|backend[-_]openapi|app[-_]test|test[-_]binary)\b`,
    String.raw`codexHome`,
    String.raw`\bCodex(?:Err|Auth|Feedback|Home|Api|Delegate|Conversation)\b`,
    String.raw`(?:ported|vendored|native|Atlas's|the)\s+Codex\s+engine`,
    String.raw`Codex\s+(?:engine|fork)\b`,
  ].join("|"),
);

/** Where the upstream name is banned outright. */
const ENGINE_TERRITORY = [
  /^vendor\//,
  /^crates\/atlas-native-agent\//,
  /^Cargo\.toml$/,
  /^src-tauri\/Cargo\.toml$/,
  /^\.github\//,
  /^\.husky\//,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^clippy\.toml$/,
  /^scripts\/(?!one-off\/)/,
  /^tests\/(?!no-legacy-names\.test\.ts$|vendor-licensing\.test\.ts$)/,
  /^docs\/(?!adr\/|archive\/)/,
];

/** Files the retired SDK name may still appear in, each with its reason. */
const RETIRED_SDK_RESIDUE: [pattern: RegExp, reason: string][] = [
  [
    /^crates\/atlas-thread-metadata\/src\/schema\.rs$/,
    "the V3 migration deletes the rows recorded under the retired id",
  ],
  [/^docs\/adr\//, "decision records are history"],
  [/^docs\/archive\//, "archived specs and research predate the rename"],
  [/^tests\/no-legacy-names\.test\.ts$/, "this file"],
  [
    /^scripts\/one-off\/rename-engine\.py$/,
    "the one-off sweep script; delete it once the rename has landed",
  ],
];

/** Files the upstream name may still appear in outright, even in engine territory. */
const UPSTREAM_RESIDUE: [pattern: RegExp, reason: string][] = [
  [
    /^vendor\/atlas-engine\/(LICENSE|NOTICE)$/,
    "Apache-2.0 §4(a)/(d): upstream's licence and notice travel verbatim",
  ],
  [
    /^vendor\/atlas-engine\/core\/gpt[^/]*codex[^/]*_prompt\.md$/,
    "model-keyed prompt files: the model id belongs to the model's vendor",
  ],
  [
    /^vendor\/atlas-engine\/core\/templates\/[^/]+\/gpt-5\.2-codex_[^/]+\.md$/,
    "model-keyed prompt files: the model id belongs to the model's vendor",
  ],
  [
    /^tests\/vendor-licensing\.test\.ts$/,
    "names the path the engine was vendored under, where its git history lives",
  ],
  [/^tests\/no-legacy-names\.test\.ts$/, "this file"],
  [
    /^scripts\/one-off\/rename-engine\.py$/,
    "the one-off sweep script; delete it once the rename has landed",
  ],
  [/^docs\/adr\//, "decision records are history"],
  [/^docs\/archive\//, "archived specs and research predate the rename"],
];

/** Lines that legitimately spell the upstream name wherever they appear. */
const ALLOWED_LINES: [pattern: RegExp, reason: string][] = [
  [
    /Modified by Atlas from upstream OpenAI Codex/,
    "the Apache-2.0 §4(b) notice names the upstream work",
  ],
  [/https?:\/\/\S*codex/i, "URLs are never renamed"],
  [/gpt[-_][\w.-]*codex|codex-auto-review|codex-mini/, "OpenAI model ids are wire values"],
  [/OpenAI-Codex-(LICENSE|NOTICE)/, "the bundled licence filenames"],
  [
    /atlas-agent-codex-port-spec|docs\/(archive|adr)\/[\w-]*codex/,
    "archived documents and decision records keep their filenames",
  ],
  [/codex-acp|@openai\/codex|codex-(darwin|linux|win32)/, "third-party Codex CLI packages"],
  [/`codex-login`/, "the third-party Codex CLI's slash command"],
];

/** Files whose bytes are not text; never read. */
const BINARY = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".icns",
  ".webp",
  ".svg",
  ".zst",
  ".gz",
  ".zip",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pem",
  ".sqlite",
  ".db",
  ".wasm",
  ".mp4",
  ".mov",
  ".pdf",
  ".lock",
]);

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Every tracked file's text, read once. Three assertions below scan the whole
 * tree; re-reading it each time put them over vitest's 5s default whenever a
 * build loaded the machine (a pre-commit run beside `cargo test`), a timeout
 * that looked like a naming regression. The read happens in `beforeAll`, with
 * a budget of its own, so each test's 5s covers only its assertion.
 */
const texts = new Map<string, string | null>();
function readText(rel: string): string | null {
  if (texts.has(rel)) return texts.get(rel) ?? null;
  let text: string | null = null;
  if (!BINARY.has(path.extname(rel))) {
    try {
      text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      text = null;
    }
  }
  texts.set(rel, text);
  return text;
}

describe("the retired names stay out of the tree", () => {
  const files = tracked();
  beforeAll(() => {
    for (const rel of files) readText(rel);
  }, 120_000);

  it("the engine no longer lives under its upstream name", () => {
    expect(existsSync(path.join(REPO_ROOT, "vendor", "codex"))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "vendor", "atlas-engine", "NOTICE"))).toBe(true);
  });

  it("nothing spells the retired SDK name", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (RETIRED_SDK_RESIDUE.some(([p]) => p.test(rel))) continue;
      const text = readText(rel);
      if (text === null || !RETIRED_SDK.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (RETIRED_SDK.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, `retired SDK name found:\n${offenders.slice(0, 80).join("\n")}`).toEqual([]);
  });

  it("nothing spells the upstream name the way the engine did", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (UPSTREAM_RESIDUE.some(([p]) => p.test(rel))) continue;
      const text = readText(rel);
      if (text === null || !UPSTREAM.test(text)) continue;
      const strict = ENGINE_TERRITORY.some((p) => p.test(rel));
      text.split("\n").forEach((line, i) => {
        if (!UPSTREAM.test(line)) return;
        if (ALLOWED_LINES.some(([p]) => p.test(line))) return;
        if (!strict && !ENGINE_SHAPED.test(line)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, `upstream name found:\n${offenders.slice(0, 80).join("\n")}`).toEqual([]);
  });

  it("every residue entry still earns its place", () => {
    // A dead allowlist entry is a hole waiting for something to fall through.
    for (const [p, reason] of [...RETIRED_SDK_RESIDUE, ...UPSTREAM_RESIDUE]) {
      expect(
        files.some((rel) => p.test(rel)),
        `no tracked file matches ${p} (${reason})`,
      ).toBe(true);
    }
    const haystack = files.map((rel) => readText(rel) ?? "").join("\n");
    for (const [p, reason] of ALLOWED_LINES) {
      expect(p.test(haystack), `no line matches ${p} (${reason})`).toBe(true);
    }
  });
});
