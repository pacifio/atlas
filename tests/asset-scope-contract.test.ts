import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the asset-protocol scope in `src-tauri/tauri.conf.json`: the set of
 * directories the webview may read through `convertFileSrc`.
 *
 * Rust caches files it wants the webview to render — the signed-in user's and
 * every organisation member's avatar (`src-tauri/src/auth/avatar.rs`, under
 * `app_config_dir()`), Spaces media, pasted images, comms attachments and
 * call recordings (all under `app_cache_dir()`) — and hands the frontend a
 * local path, which `<img src={convertFileSrc(path)}>` fetches over the asset
 * protocol. Tauri answers 403 for any path outside this scope, the `<img>`
 * fires `onError`, and every consumer is written to fall back quietly
 * (initials, a placeholder). Nothing in the toolchain sees it.
 *
 * `$HOME/**` looks like it covers all of that, and on macOS it does:
 * `~/Library/Application Support/dev.atlas.ide/`. On Linux the same calls
 * resolve to `~/.config/dev.atlas.ide/` and `~/.cache/dev.atlas.ide/`, and
 * Tauri matches scope globs with `require_literal_leading_dot` on every Unix
 * (`tauri/src/scope/fs.rs`): a wildcard never matches a path component that
 * starts with `.`, so that `~/**` cannot expose `~/.ssh`. A dot that is
 * written *literally* in the pattern does match, which is what `$APPCONFIG`
 * and `$APPCACHE` expand to. That rule is the right one — turning it off with
 * `requireLiteralLeadingDot: false` would open every dotfile under `$HOME` to
 * the webview — so the app's own directories are listed instead.
 *
 * Symptom when this drifts: the Linux build shows initials for every avatar
 * while the cached file sits on disk, and the only trace is a
 * `tauri::protocol::asset` error in the log.
 *
 * The allow list is broad, so the same directories also hold credentials the
 * webview never renders and must never read: the session file
 * (`auth/store.rs`, under the app config dir, plus its `.tmp` during an
 * atomic save), and under the app *data* dir the memory bridge's per-launch
 * token files (`agents.rs` roots `mcp-bridge/` there) and the built-in
 * browser's cookie profile (`browser.rs`). On macOS config and data are the
 * same folder, reached through `$HOME/**` as well; on Linux they differ, so
 * each pattern must name the base dir the Rust code actually uses. Tauri checks
 * `deny` before `allow`, so listing them there is what keeps a script running
 * in the webview from fetching them over the asset protocol.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Json = Record<string, unknown>;

function readJson(rel: string): Json {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")) as Json;
}

function assetScope(conf: Json): Json {
  const app = conf.app as Json;
  const security = app.security as Json;
  const protocol = security.assetProtocol as Json;
  return protocol.scope as Json;
}

describe("asset protocol scope", () => {
  const scope = assetScope(readJson("src-tauri/tauri.conf.json"));
  const allow = scope.allow as string[];

  it("spells out the app config dir, where avatars are cached", () => {
    expect(allow).toContain("$APPCONFIG/**");
  });

  it("spells out the app cache dir, where media and attachments are cached", () => {
    expect(allow).toContain("$APPCACHE/**");
  });

  it.each([
    ["the session file and its atomic-save temp", "$APPCONFIG/atlas-session.*"],
    ["the memory bridge's token files", "$APPDATA/mcp-bridge/**"],
    ["the built-in browser's cookie profile", "$APPDATA/browser-profile/**"],
  ])("denies %s", (_what, pattern) => {
    expect(scope.deny as string[]).toContain(pattern);
  });

  it("keeps hidden directories hidden rather than widening the whole home", () => {
    // Unset means Tauri's Unix default (true). `false` would be the tempting
    // one-line fix for the Linux symptom, and it exposes `~/.ssh`, `~/.aws`
    // and every other dotfile to the webview.
    expect(scope.requireLiteralLeadingDot).not.toBe(false);
    expect(scope["require-literal-leading-dot"]).not.toBe(false);
  });

  it("is not replaced by a platform overlay", () => {
    // Tauri merges platform configs as a JSON merge patch: objects merge,
    // arrays replace. A `security` block in an overlay would swap this allow
    // list out on that platform only, which is exactly the drift above.
    for (const overlay of [
      "src-tauri/tauri.linux.conf.json",
      "src-tauri/tauri.macos.conf.json",
      "src-tauri/tauri.windows.conf.json",
      "src-tauri/tauri.dev.conf.json",
    ]) {
      const app = readJson(overlay).app as Json | undefined;
      expect(app?.security, `${overlay} overrides app.security`).toBeUndefined();
    }
  });
});
