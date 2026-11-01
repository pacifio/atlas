import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Universal RC's wire fixtures live in two repositories: the server's
 * `packages/contracts/fixtures/rc-*.json` (the authority — the TypeScript
 * schemas are tested against them there) and this repo's
 * `crates/atlas-remote-control/tests/fixtures/` (tested against the Rust
 * codec in `tests/contract.rs`). They are hand-copied, so each side proves
 * only that it agrees with its own copy; nothing in CI can see both.
 *
 * This is the one check that can, and only where it can: on a machine that has
 * the server checkout beside this one (`../server`), the two copies must be
 * byte-identical. Elsewhere — CI included — it passes trivially; the point is
 * that a developer re-copying one fixture and not the other hears about it
 * before the drift ships. Any mismatch is fixed by re-copying from the server.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = path.join(REPO_ROOT, "crates", "atlas-remote-control", "tests", "fixtures");
const SERVER = path.resolve(REPO_ROOT, "..", "server", "packages", "contracts", "fixtures");

const FIXTURES = ["rc-frames-v1.json", "rc-wire-v1.json"];

describe("RC wire fixtures are the server's, byte for byte", () => {
  const serverPresent = FIXTURES.every((f) => existsSync(path.join(SERVER, f)));

  it.skipIf(!serverPresent)("every fixture matches its server copy", () => {
    for (const f of FIXTURES) {
      const ours = readFileSync(path.join(LOCAL, f), "utf8");
      const theirs = readFileSync(path.join(SERVER, f), "utf8");
      expect(ours, `${f} differs from the server's — re-copy it`).toBe(theirs);
    }
  });

  it("every fixture the Rust codec is tested against exists", () => {
    for (const f of FIXTURES) expect(existsSync(path.join(LOCAL, f)), f).toBe(true);
  });
});
