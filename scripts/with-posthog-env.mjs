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
import { delimiter, dirname, join } from "node:path";
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
// Windows spells the variable `Path`, and `{...process.env}` is a plain object —
// so assigning `env.PATH` there would ADD a second key holding only `.bin` and
// leave the real `Path` behind, and which of the two the child inherits depends
// on how libuv dedupes them. Write back through whatever case is already there.
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

const result = spawnSync(cmd, args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
