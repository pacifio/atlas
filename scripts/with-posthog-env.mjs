#!/usr/bin/env node
/**
 * Load the repo-root `.env`, normalize the PostHog keys to the build-time names
 * the Rust telemetry reads via `option_env!` (`ATLAS_POSTHOG_KEY` /
 * `ATLAS_POSTHOG_HOST`), then exec the wrapped command (e.g. `tauri dev` /
 * `tauri build`) with that environment. Because the Tauri CLI drives the Rust
 * compile as a child, the keys are inherited and baked into the binary.
 *
 * Usage (from package.json scripts):
 *   node scripts/with-posthog-env.mjs tauri build --bundles app
 *
 * No `.env` / blank key → nothing is embedded and telemetry stays inert. Real
 * process env always wins over `.env`, so CI can set the secrets directly.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

// Minimal .env parser (KEY=VALUE, optional quotes, # comments). Existing process
// env takes precedence so CI-provided secrets are never overwritten.
try {
  const raw = readFileSync(join(root, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (val && env[key] === undefined) env[key] = val;
  }
} catch {
  // no .env — fine; telemetry just won't have an embedded default key.
}

// Accept POSTHOG_KEY/HOST as aliases for the build-time ATLAS_* names.
if (!env.ATLAS_POSTHOG_KEY && env.POSTHOG_KEY) env.ATLAS_POSTHOG_KEY = env.POSTHOG_KEY;
if (!env.ATLAS_POSTHOG_HOST && env.POSTHOG_HOST) env.ATLAS_POSTHOG_HOST = env.POSTHOG_HOST;

// Make locally-installed bins (e.g. `tauri`) resolvable when spawning directly.
//
// The key is found case-insensitively because Windows spells it `Path`, and
// `{ ...process.env }` is a plain object that keeps that spelling. Assigning to
// `env.PATH` there does not extend the search path — it ADDS A SECOND KEY, and
// `env.PATH ?? ""` reads `undefined`, so the new key holds only `node_modules/
// .bin`. The child then receives both `Path` and `PATH`; Windows environment
// blocks are case-insensitive, so which one wins is undefined, and when `PATH`
// won the child lost the system path entirely — `bun is not installed in
// %PATH%` from a shell where bun was plainly on it.
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
env[pathKey] = `${join(root, "node_modules", ".bin")}${delimiter}${env[pathKey] ?? ""}`;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("with-posthog-env: no command given");
  process.exit(2);
}

const embedded = Boolean(env.ATLAS_POSTHOG_KEY);
console.log(
  `[with-posthog-env] PostHog key ${embedded ? "embedded from env/.env" : "not set — telemetry inert"}`,
);

// `tauri dev` is how most people build, and without this nothing ever collects
// their `target/` (target-gc.sh used to run only from `ci:local`). The script
// decides for itself whether anything is due (a Rust upgrade, or the weekly
// sweep), so the usual run costs a couple of process spawns. Best effort: a
// missing bash, a missing cargo-sweep or a failed collection prints one line
// and dev starts anyway.
if (cmd === "tauri" && args[0] === "dev" && process.platform !== "win32") {
  // The directory the build will use: cargo honours CARGO_TARGET_DIR, resolved
  // against the working directory it is invoked from. No timeout: killing bash
  // would leave a `cargo sweep` child deleting artifacts under the compile that
  // follows, so we wait for the collection to finish (it is a no-op most runs).
  const target = resolve(process.cwd(), env.CARGO_TARGET_DIR || join(root, "target"));
  const gc = spawnSync("bash", [join(root, "scripts", "target-gc.sh"), target], {
    stdio: "inherit",
    env,
  });
  if (gc.status !== 0) console.log("[with-posthog-env] target-gc skipped or failed; continuing");
}

// `shell: true` (needed on Windows so `tauri` resolves to `tauri.cmd`) makes
// Node join the command and arguments with bare spaces for cmd.exe, so a part
// containing a space — `C:\Program Files\nodejs\node.exe`, the default install
// path — is split into `C:\Program`. Quote such parts ourselves.
const win = process.platform === "win32";
const quote = (part) => (win && /\s/.test(part) && !/^".*"$/.test(part) ? `"${part}"` : part);
const result = spawnSync(quote(cmd), args.map(quote), {
  stdio: "inherit",
  env,
  shell: win,
});
process.exit(result.status ?? 1);
