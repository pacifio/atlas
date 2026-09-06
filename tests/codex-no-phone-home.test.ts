import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The vendored engine phones home nowhere (issue #43, spec D2 / Phase 1).
 *
 * Two paths shipped inside the closure upstream, and D2 is explicit that they
 * are "removed (not just configured off) before any build leaves developers'
 * machines":
 *
 *   1. **OTLP metrics to Statsig.** `codex-otel` carried a built-in exporter
 *      posting to `https://ab.chatgpt.com/otlp/v1/metrics` with a **hardcoded
 *      client key**, and `codex-core` *defaulted* the metrics exporter to it
 *      (`core/src/config/otel.rs`). Upstream gated it on `cfg!(debug_assertions)`
 *      — which means it was live in exactly the builds that ship.
 *   2. **Per-session analytics to the ChatGPT backend.** `codex-analytics`
 *      POSTed to `{chatgpt_base_url}/codex/analytics-events/events`, was
 *      constructed for **every** session, was on unless config said otherwise,
 *      and sent a subset of events *even under plain API-key auth*.
 *
 * Research: `docs/research/codex-fork-seam.md` §3 and its identity table.
 *
 * **Why a text test.** Neither path fails a build, a type-check, or a test when
 * it comes back. Both are reachable by an ordinary-looking edit — restoring an
 * enum variant, handing a base URL to a constructor — and the only symptom is
 * traffic leaving a user's machine. That is precisely the class cargo will
 * never announce, so it is asserted here instead.
 *
 * This is the permanent one. `codex-quarantine.test.ts` guards a condition that
 * ends when #45 rewires the seam; nothing ever makes this acceptable again.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(REPO_ROOT, "vendor", "codex");

/** Source-ish files worth scanning. Excludes lockfiles and binary fixtures. */
const SCANNED = new Set([".rs", ".toml", ".json", ".md", ".bazel", ".sh", ".py", ".ts"]);

function sourceFiles(dir = VENDOR): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (SCANNED.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

/**
 * Test code, which is held to a different rule than shipping code.
 *
 * Upstream's own suites mount **local wiremock servers** on the paths the
 * engine used to POST to, then assert what was sent. A mock bound to
 * `127.0.0.1` cannot phone home no matter what path it answers on, so a test
 * naming the old endpoint is not a leak — and rewriting eight upstream test
 * files would churn a tree #42 deliberately keeps byte-identical to upstream,
 * in crates Atlas does not ship.
 *
 * Those suites now assert behaviour that no longer exists, which is real debt
 * — recorded on #43 and cleared in Phase 5, where these crates are slimmed
 * anyway. What must hold *now* is that nothing shipping knows the endpoint.
 */
function isTestCode(file: string): boolean {
  const rel = path.relative(REPO_ROOT, file);
  const base = path.basename(rel);
  return (
    rel.includes(`${path.sep}tests${path.sep}`) ||
    base === "tests.rs" ||
    base.endsWith("_tests.rs") ||
    base.endsWith(".test.ts")
  );
}

/**
 * Strip prose, so a file may explain what was removed without re-tripping the
 * check that removed it.
 *
 * Apache-2.0 §4(b) wants modified files marked, and a reader who finds a hole
 * where a feature used to be is owed the reason — so the removals here are
 * commented, and those comments name the thing. Only the code is scanned.
 */
function codeOnly(file: string, src: string): string {
  const ext = path.extname(file);
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      if (ext === ".rs") return !t.startsWith("//");
      if (ext === ".md") return !t.startsWith(">");
      // TOML comments start with `#`; Rust-style `#[attr]` never does here.
      if (ext === ".toml") return !t.startsWith("#");
      return true;
    })
    .join("\n");
}

/** Like `filesMatching`, but blind to comments and markdown blockquotes. */
function codeMatching(needle: RegExp): string[] {
  return sourceFiles()
    .filter((f) => !isTestCode(f))
    .filter((f) => needle.test(codeOnly(f, readFileSync(f, "utf8"))))
    .map((f) => path.relative(REPO_ROOT, f));
}

/** Every scanned production file whose text matches `needle`, repo-relative. */
function filesMatching(needle: RegExp): string[] {
  return sourceFiles()
    .filter((f) => !isTestCode(f))
    .filter((f) => needle.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(REPO_ROOT, f));
}

describe("the engine's egress surface (parser health)", () => {
  it("scans a plausible number of vendored files", () => {
    // A traversal that silently stopped would make every assertion below pass
    // by finding nothing. The engine is ~4k files.
    expect(sourceFiles().length).toBeGreaterThan(1000);
  });

  it("still finds the engine's ordinary network code", () => {
    // Proves the scanner reads content, not just names: the engine legitimately
    // talks to whatever model provider the user configured, and that must
    // survive. A test that forbade all HTTP would be wrong, not strict.
    expect(filesMatching(/reqwest/).length).toBeGreaterThan(10);
  });
});

describe("the Statsig metrics exporter is gone", () => {
  it("has no hardcoded client key", () => {
    // The literal that shipped upstream. Split so this file is not itself a
    // hit for anyone grepping the repo for the key.
    const key = ["client-MkRuleRQBd6qakfnDYqJVR9", "JuXcY57Ljly3vi5JVUIO"].join("");
    expect(filesMatching(new RegExp(key))).toEqual([]);
  });

  it("has no Statsig ingestion endpoint", () => {
    expect(filesMatching(/ab\.chatgpt\.com/)).toEqual([]);
    expect(filesMatching(/otlp\/v1\/metrics/)).toEqual([]);
  });

  it("has no Statsig code path at all", () => {
    // The name, anywhere: the enum variants (`OtelExporter::Statsig`,
    // `OtelExporterKind::Statsig`), the settings struct that ferried the
    // resolved config to another process, the config-schema enum value, and
    // the README section documenting it. A variant left in place is a variant
    // something can select.
    expect(codeMatching(/statsig/i)).toEqual([]);
  });
});

describe("the ChatGPT analytics client is gone", () => {
  it("has no analytics ingestion endpoint", () => {
    expect(filesMatching(/analytics-events\/events/)).toEqual([]);
  });

  it("builds no analytics URL from a base URL", () => {
    // The upstream shape was `format!("{base_url}/codex/analytics-events/events")`.
    // Catches a rebuild of the path from pieces.
    expect(filesMatching(/codex\/analytics-events/)).toEqual([]);
  });

  it("sends no HTTP request from the analytics crate", () => {
    // The crate keeps its public surface — core calls ~35 `track_*` methods —
    // but nothing behind them may reach the network. No client, no POST.
    const analytics = sourceFiles(path.join(VENDOR, "analytics"));
    expect(analytics.length, "analytics crate not found").toBeGreaterThan(3);

    const offenders = analytics
      .filter((f) => /reqwest|\.post\(|\.send\(\)\s*$/m.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("declares no HTTP client dependency", () => {
    const manifest = readFileSync(path.join(VENDOR, "analytics", "Cargo.toml"), "utf8");
    expect(manifest).not.toMatch(/^\s*reqwest/m);
  });
});

describe("the Sentry feedback uploader is gone", () => {
  it("has no Sentry DSN", () => {
    // The fourth phone-home path (#63): `codex-feedback` shipped a hardcoded
    // ingest DSN and built a client around it inside `upload_feedback` — a
    // path the in-process app-server would honour on a `feedback/upload`
    // request. The key is split so this file is not itself a hit.
    const dsn = ["ae32ed50620d7a", "7792c1ce5df38b3e3e"].join("");
    expect(filesMatching(new RegExp(dsn))).toEqual([]);
    expect(filesMatching(/o33249\.ingest/)).toEqual([]);
  });

  it("parses no DSN and builds no Sentry client", () => {
    expect(codeMatching(/Dsn::from_str|sentry::init/)).toEqual([]);
  });
});

describe("no telemetry ingest marker anywhere in vendored code", () => {
  // The removals above are point checks against sites already known. The
  // fourth path (#63) shipped precisely because only known sites were
  // asserted: the guard could not fail on one it had never heard of. This is
  // the structural half — any ingest-service marker in vendored CODE fails
  // here (comments explaining a removal don't count), so a fifth site fails
  // rather than passes.
  it("matches no known telemetry vendor", () => {
    const markers =
      /sentry\.io|statsig|posthog\.com|segment\.io|datadoghq|bugsnag|honeycomb\.io|o33249/i;
    expect(codeMatching(markers)).toEqual([]);
  });
});
