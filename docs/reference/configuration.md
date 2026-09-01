# Atlas configuration (`config.toml`)

Reference for Atlas's user-facing preferences file. Written for both humans
hand-editing the file and agents using the `atlas-self-configure` skill
(`src-tauri/resources/skills/atlas-self-configure/SKILL.md`) — the skill's
key table is a copy of the one below, and both are compiled into the test
binary via `include_str!` so a Rust test (`every_known_setting_key_is_*` in
`state/atlas_config.rs`) fails the build the moment either one drops a key;
see [Testing](#testing).

- **Source of truth (Rust):** `src-tauri/src/state/atlas_config.rs`
  (schema, defaults, validation, migration) and
  `src-tauri/src/commands/atlas_config.rs` (Tauri commands + file watcher).
- **Frontend wrapper:** `src/features/settings/lib/atlas-config-api.ts`.
- **Design context:** GitHub issue #64.

## Location

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/dev.atlas.ide/config.toml` |
| Linux | `~/.config/dev.atlas.ide/config.toml` |
| Windows | `%APPDATA%\dev.atlas.ide\config.toml` |

Resolved exclusively through Tauri's `app.path().app_config_dir()` — never
hard-code an OS-specific path in application code; call
`ConfigManager::config_path` (Rust) or the `get_atlas_config_info` command
(frontend/agents) instead.

## Format

TOML, edited through `toml_edit` rather than reserialized wholesale, so a
patch from the Settings UI or an agent preserves comments, key order, and any
key Atlas doesn't recognize. Chosen over JSON (no comments) and YAML
(ambiguous scalar parsing for a file humans and agents both hand-edit).

```toml
schemaVersion = 1

[settings]
autoAddAtlasGitignore = true
enableAtlasLogs = true
showHiddenFiles = true
uiScale = 1.0
shareTelemetry = true
linkTelemetryToAccount = true
embeddingModelId = "all-MiniLM-L6-v2"
codeEditorTheme = "atlas"
atlasTheme = "atlas-black"
adaptiveSuggestions = "agent"
gitBlameInline = true
autoUpdate = true
# updaterIgnoredVersion is absent unless a version was ignored — TOML has no
# null, so "unset" means the key doesn't appear at all.
enterToSend = true
```

## Schema

| Key | Type | Default | Validation |
|---|---|---|---|
| `autoAddAtlasGitignore` | boolean | `true` | — |
| `enableAtlasLogs` | boolean | `true` | — |
| `showHiddenFiles` | boolean | `true` | — |
| `uiScale` | number | `1.0` | finite, `0.5`–`2.0` inclusive |
| `shareTelemetry` | boolean | `true` | — |
| `linkTelemetryToAccount` | boolean | `true` | — |
| `embeddingModelId` | string | `"all-MiniLM-L6-v2"` | non-empty |
| `codeEditorTheme` | string | `"atlas"` | non-empty (not checked against the frontend theme catalog — see [Non-goals](#non-goals-for-validation)) |
| `atlasTheme` | string | `"atlas-black"` | non-empty (same caveat) |
| `adaptiveSuggestions` | `"agent"` \| `"off"` | `"agent"` | exactly one of these two strings |
| `gitBlameInline` | boolean | `true` | — |
| `autoUpdate` | boolean | `true` | — |
| `updaterIgnoredVersion` | string, or absent | absent | — |
| `enterToSend` | boolean | `true` | — |

Any other key under `[settings]` is left on disk untouched and reported as an
`unknownKeys` entry in `get_atlas_config_info` — never treated as an error,
never deleted.

### Non-goals for validation

`codeEditorTheme`/`atlasTheme` are checked for non-emptiness, not membership
in the frontend's theme catalogs (`src/features/theme/themes.ts`,
`src/features/editor/themes/themes.ts`). Duplicating that catalog into Rust
would create a second list that has to stay in sync with the frontend one —
trading one drift bug for another. An unrecognized-but-well-formed theme id
is accepted here and handled the same way the frontend already handles one
from a newer Atlas version.

## Schema versioning

`config.toml`'s `schemaVersion` is independent of `state.json`'s
`AppState::SCHEMA_VERSION` — the two files describe different domains and
evolve on separate timelines. Current: `CONFIG_SCHEMA_VERSION = 1`
(`state/atlas_config.rs`).

- A file with a *lower* version is meant to run through sequential, idempotent
  migrations, the same pattern `AppState::migrate()` already uses for
  `state.json`. **Not yet implemented as code** — `CONFIG_SCHEMA_VERSION` is
  still `1`, so there is nothing to migrate from today; a real v1→v2 bump is
  what will exercise this path for the first time. Field-level
  `#[serde(default = ...)]` already covers the common case (a new key added
  within v1) without needing a version bump at all.
- A file with a *higher* version than this Atlas build supports is rejected
  outright — last-known-good settings stay active, the file is left alone.
  (This is what happens when a newer Atlas version's config is opened by an
  older build.)

## Precedence and scope

```
compiled defaults  <  validated config.toml
```

Global only. There is no project-level override and no durable UI/session
layer — a Settings UI change **is** a `config.toml` write, immediately.
"Project scope" is explicitly out of scope for this design; a future project-
level preference would need its own design (ownership, eligible keys,
location, precedence), not silent inheritance of this mechanism.

## Loading, validation, and failure behavior

Every read — cold start, a UI patch, an external edit picked up by the
watcher — validates the **complete candidate** before it replaces anything.
A malformed or invalid file never partially applies and never gets
auto-repaired, renamed, or overwritten by Atlas on its own:

- **Cold start, file missing:** normal (pre-migration, or the user deleted
  it on purpose) — served compiled defaults, `status: "ok"`.
- **Cold start, file malformed:** served compiled defaults in memory,
  `status: "usingDefaults"` with the parse/validation error. The file itself
  is never touched.
- **Hot reload (external edit) is malformed:** the previous, already-
  validated settings stay effective, `status: "usingLastKnownGood"` with the
  error. The malformed file is left exactly as written.
- **A UI/agent patch would produce an invalid candidate:** rejected outright
  (`update_atlas_settings` returns an error); nothing is written.
- **A UI/agent patch arrives while the on-disk file is currently
  malformed:** also rejected — a patch is never allowed to paper over a
  file it didn't validate first.

The only path allowed to overwrite a malformed (or just unwanted) file is
"Recreate defaults" (`reset_atlas_config`), which backs the previous content
up to `config.toml.bak-<unix-seconds>` next to it before writing fresh
defaults.

## Live reload

Atlas watches `config.toml`'s parent directory (not the file itself — an
atomic save replaces the inode) and re-validates on any change. Every
setting in the schema is hot-reloadable; none requires a restart. A
successful reload emits `atlas:config-changed` with the new settings and a
`generation` counter; a rejected one emits `atlas:config-error` without
changing anything.

## Writing

The Settings UI and any agent both write through the same
read-modify-validate-atomic-write path:

1. Re-read the file from disk (closes the race with a concurrent external
   edit).
2. Merge only the changed key(s) into the parsed document via `toml_edit` —
   every other key, comment, and ordering is left untouched.
3. Validate the complete resulting candidate.
4. Write to a uniquely-named temp file in the same directory, then rename it
   over `config.toml` (atomic; a crash mid-write can't leave a torn file).

The Settings UI additionally passes an `expectedGeneration` — a stale value
(something else changed the file first) is reported back as a conflict
rather than silently overwritten.

## Migration from `state.json`

Before issue #64, these settings lived in `state.json`'s `AppState.settings`
(schema v3 and earlier). On first launch after upgrading:

1. `state.json` is bumped to schema v4, which adds
   `settingsConfigMigrated: bool`.
2. If `config.toml` doesn't exist yet and the marker is `false`, the legacy
   `settings` object is extracted field-by-field (a value that doesn't parse
   is skipped, not fatal to the rest) and written as the new `config.toml`.
3. The marker is then set `true` — this is what stops Atlas from
   resurrecting stale `state.json` settings if the user later deletes
   `config.toml` on purpose.

One extra field, `adaptiveSuggestions`, existed on the frontend but had no
Rust-side counterpart before this migration; it's now part of the schema
above, closing that drift. Legacy values `"parse"`/`"llm"` (from before it
was a closed enum) normalize to `"agent"` during migration only — the live
schema accepts only `"agent"` or `"off"`.

## What's explicitly NOT in this file

- **API keys / credentials.** Atlas doesn't store these itself at all — see
  `src-tauri/src/commands/byok.rs`; they live in the user's shell profile.
- **Telemetry identity** (`device.json`) and the **self-hosted PostHog
  override** (`telemetry.json`) — deliberately separate files. Their split
  from coarse settings writes fixed a real bug (a settings save used to wipe
  the telemetry anonymous id); folding them back in would reverse that fix.
  `shareTelemetry`/`linkTelemetryToAccount` (the on/off preferences) stay in
  `config.toml` — only the identity/override files are excluded.
- **Session history, transcripts, per-project `.atlas/` state.** File-backed,
  but not a "setting," and out of scope until an explicit ownership design
  says otherwise.
- **Any "is a credential configured" presence flag.** Even a boolean is
  security-sensitive derived state; the BYOK UI computes availability at
  runtime from the environment instead of persisting it here.

## Testing

- Rust: `src-tauri/src/state/atlas_config.rs` (`#[cfg(test)] mod tests`) —
  defaults, missing-key fallback, comment/unknown-key preservation across a
  patch, invalid values, unsupported future schema, malformed cold-start and
  hot-reload behavior, generation conflicts, reset/backup, and the legacy
  migration extraction (including the `adaptiveSuggestions` normalization).
- Rust: `src-tauri/src/state/app_state.rs` — a legacy `settings` key in
  `state.json` doesn't break parsing of the rest of the file.
