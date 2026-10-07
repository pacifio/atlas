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

```
~/.config/atlas/config.toml
```

The same path on every platform, and `$XDG_CONFIG_HOME/atlas/config.toml`
when that variable is set to an absolute path. A relative value is ignored
rather than resolved against the cwd — a GUI app launched from Finder has an
arbitrary one.

Deliberately **not** Tauri's `app_config_dir()`, which on macOS is
`~/Library/Application Support/dev.atlas.ide/`. This file exists to be opened
and hand-edited, by a person or an agent, and a path they can type is part of
that; a bundle id buried under `Application Support` is not. Zed makes the same
call for the same reason (`~/.config/zed/settings.json` on macOS), and it puts
Atlas's config beside every other tool a developer already keeps in
`~/.config`.

This is a split, not a move. Everything else Atlas persists stays in the
platform data directory, because none of it is a document anyone should be
editing:

| Stays in `app_config_dir()` | Why |
|---|---|
| `state.json` | Projects, recents, orgs — machine-managed. (Its keys still say `workspaces` / `activeWorkspaceId`: storage keys, not the concept.) |
| `device.json` | Telemetry identity; see the exclusions below. |
| `telemetry.json` | Self-hosted PostHog override. |
| `models-pricing.json`, `byok-usage.jsonl` | Caches. |
| `session-chat/`, comms state | Session data. |

In application code, call `ConfigManager::config_path()` (Rust) or the
`get_atlas_config_info` command (frontend) rather than rebuilding the path.

## Format

TOML, edited through `toml_edit` rather than reserialized wholesale, so a
patch from the Settings UI or an agent preserves comments, key order, and any
key Atlas doesn't recognize. Chosen over JSON (no comments) and YAML
(ambiguous scalar parsing for a file humans and agents both hand-edit).

Atlas writes the file **self-documenting**: a header, then a comment above
every key giving what it does, its default, and any constraint on its value.
Those comments come from `SETTINGS_DOCS` in `state/atlas_config.rs` — the same
table `unknown_keys_in` uses to decide what Atlas recognizes — so they can't
drift from what validation accepts.

That is deliberate, and it's why the bundled `atlas-self-configure` skill
carries no key table of its own: an agent reads the real file and gets a
schema that matches the build in front of it, instead of a copy in a skill
that was projected into `~/.agents/skills` at some earlier version. The
`settings_docs_cover_every_setting` and
`the_self_configure_skill_defers_to_the_files_own_comments` tests hold both
halves of that in place.

A generated file looks like this (abridged — every key gets the same
treatment):

```toml
# Atlas configuration.
#
# Every user-facing Atlas preference lives here. Edit this file by hand or use
# Settings — both write to it, and Atlas picks up external edits live, with no
# restart needed for any key below.
#
# Your comments, formatting, and any keys Atlas doesn't recognize survive its
# own writes. An invalid value is rejected whole: Atlas keeps running on the
# last settings that loaded cleanly, shows the error in Settings, and leaves
# this file exactly as you wrote it.

# Format version of this file. Atlas manages it; leave it alone.
schemaVersion = 1

[settings]

# Keep Atlas's directory in each opened git project out of version
# control: `.atlas/` goes into the project's .gitignore (created if
# needed); a dev build's `.atlas-dev/` goes into .git/info/exclude.
# No-op on non-git projects. (default: true)
autoAddAtlasGitignore = true

# Interface zoom, where 1.0 is 100%. Also driven by Cmd +/-/0.
# Must be a number between 0.5 and 2.0. (default: 1.0)
uiScale = 1.0

# Next-step suggestion chips in the agent chat's per-turn card.
# Exactly "agent" or "off", nothing else. (default: "agent")
adaptiveSuggestions = "agent"

# What picking another agent does to a chat that has a conversation:
# "new-tab" keeps it and opens the new agent in a new tab, "handoff"
# switches in place and attaches it to the next message, "reset"
# switches in place and starts over. (default: "reset")
agentSwitchBehavior = "reset"

# updaterIgnoredVersion: a release you chose to skip in the update
# prompt. Absent unless one was ignored — TOML has no null, so "unset"
# means the key simply isn't here. Delete the line to clear it; never
# write an empty string.

# Chat composer send gesture. true = Enter sends and Shift+Enter
# inserts a newline; false = only Cmd/Ctrl+Enter sends. Cmd/Ctrl+Enter
# sends either way. (default: true)
enterToSend = true

# Let Atlas Agent act on the window: open files at a line, switch tabs
# and panels, fill in a chat message, type a command for you to run.
# It never switches projects, sends for you or presses Enter. Off: its
# UI tools are withdrawn and every call is refused. (default: true)
agentUiNavigation = true

# Let Atlas Agent act in your organisation, as you: read the recorded
# sessions, comments, members and conversations of the organisation a
# cloud-bound Project belongs to. Anything that reaches another person
# asks you first. Off: its organisation tools are withdrawn and every
# call is refused. (default: true)
agentOrgAccess = true

# Let agents search this project's code through Atlas: grep for text
# and find files by name, in-process, respecting .gitignore and never
# reading secret files such as .env. Off: the code tools are withdrawn
# and every call is refused; agents use their own shell instead.
# (default: true)
agentCodeTools = true

# Notify when a command succeeds after running longer than
# terminalNotifyMinDurationMs. (The master switch for all notifications
# is notificationsEnabled.) (default: true)
terminalNotifications = true

# A successful command shorter than this many milliseconds never
# notifies. Must be between 0 and 3600000. (default: 10000)
terminalNotifyMinDurationMs = 10000

# Notify on a non-zero exit code regardless of duration. (default: true)
terminalNotifyOnFailure = true

# Notify when a command wants input — a password prompt, a bell, or an
# OSC 9 / OSC 777 notification from the program. (default: true)
terminalNotifyOnAttention = true

# Also raise a macOS notification when the Atlas window is not focused.
# (default: true)
terminalNotifyNative = true

# Play a short chime with terminal notifications. (default: false)
terminalNotifySound = false

# Notifications master switch. Off silences every notification except
# sign-in problems, which always show. (default: true)
notificationsEnabled = true

# OS banner for notifications that need you — a permission request, a
# question, a terminal asking for input. Shown only when you are away.
# (default: true)
notifyNeedsYouNative = true

# Sound for notifications that need you. (default: true)
notifyNeedsYouSound = true

# OS banner when an agent turn or terminal command finishes or fails.
# Shown only when you are away. (default: true)
notifyOutcomeNative = true

# Sound for finished / failed notifications. (default: true)
notifyOutcomeSound = true

# OS banner for warnings — context nearly full, rate limited, retrying,
# agent stopped. (default: false)
notifyWarningNative = false

# Sound for warnings. (default: false)
notifyWarningSound = false

# OS banner for Chat direct messages and @mentions. Shown only when you
# are away. (default: true)
notifyTeamNative = true

# Sound for Chat notifications. (default: true)
notifyTeamSound = true

# Show Allow once / Deny buttons on permission banners. Off: the banner
# only opens the session. (default: true)
notifyPermissionActions = true

# Set once Atlas has folded your earlier terminal and agent notification
# choices into the keys above. Leave it alone. (default: false)
notificationsMigrated = false

# Notification kinds you switched off in Settings > Notifications, by id,
# e.g. ["terminal-done", "git-behind"]. Unknown ids are ignored; a kind
# that must always show (sign-in lost) cannot be silenced. (default: [])
notifyDisabledKinds = []

# Set once Atlas has folded your earlier per-kind notification switches
# into notifyDisabledKinds. Leave it alone. (default: false)
notifyKindsMigrated = false

# An agent turn that finished faster than this many milliseconds stays
# quiet; failures and requests for you are never held back. 0 turns it
# off. Must be between 0 and 3600000. (default: 0)
notifyAgentMinDurationMs = 0

# Models you starred in the composer's model picker, as
# "agentType:modelId", e.g. ["claude-code:opus"]. Starred models open
# the picker on Favorites. Unknown entries are ignored. (default: [])
favoriteModels = []
```

Note `updaterIgnoredVersion`: a key that serializes to nothing still gets its
comment, carried down onto the next key that is present. Otherwise the one key
whose *absence* carries meaning would be the one key nothing explains.

Comments are only ever written into a file Atlas generates — first migration,
or "Recreate defaults". Atlas never injects them into a file a user or agent
wrote; `toml_edit` just preserves whatever comments are already there.

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
| `codeEmbeddingModelId` | string | `"granite-embedding-small-r2"` | non-empty; a code model for semantic code search (memory keeps `embeddingModelId`) |
| `theme` | string | `"atlas"` | known theme id; an unknown id is logged and falls back to `"atlas"` |
| `themeMode` | `"system"` \| `"dark"` \| `"light"` | `"system"` | exactly one of these values; a missing requested variant falls back to the theme's other variant. Light is persisted but hidden in Settings until light-mode QA completes. |
| `themeOverrides` | table | absent | optional `base`, `palette`, and `keys` patch applied after the active theme variant |
| `iconTheme` | string | `"material-icon-theme"` | a plain id (letters, digits, `.`, `-`, `_`) — it names a directory under `~/.config/atlas/icon-themes/`. `"minimal"` keeps Atlas's lucide icons. See `docs/reference/icon-themes.md` |
| `appIcon` | string | `"dark"` | a plain id (letters, digits, `-`, `_`) from `src-tauri/icons/app-icons/app-icons.json` — today `"dark"` or `"light"`. An id this Atlas does not ship shows the default without rewriting the file. macOS only: `"dark"` is the bundle's own Liquid Glass icon; any other replaces the Dock icon and the bundle's Finder/Launchpad icon, re-applied at every launch |
| `adaptiveSuggestions` | `"agent"` \| `"off"` | `"agent"` | exactly one of these two strings |
| `agentSwitchBehavior` | `"new-tab"` \| `"handoff"` \| `"reset"` | `"reset"` | exactly one of these three strings. An empty chat always switches in place and a running one always gets a new tab, whatever this says |
| `gitBlameInline` | boolean | `true` | — |
| `gitAutoFetch` | boolean | `true` | — |
| `keepAwakeWhileRunning` | boolean | `false` | no effect on Windows |
| `autoUpdate` | boolean | `true` | — |
| `curatedPluginSync` | boolean | `false` | — |
| `instructionSync` | boolean | `false` | — . See [Mirrored instructions](#mirrored-instructions-instructionsync) |
| `rememberBeforeSwitch` | boolean | `false` | — . Acts only on a chat with a conversation whose agent advertises `/remember` (the bundled `remember` skill); waits at most 3 minutes, and the user can switch at once |
| `updaterIgnoredVersion` | string, or absent | absent | — |
| `enterToSend` | boolean | `true` | — |
| `agentUiNavigation` | boolean | `true` | — |
| `agentOrgAccess` | boolean | `true` | — |
| `agentCodeTools` | boolean | `true` | — |
| `terminalNotifications` | boolean | `true` | — |
| `terminalNotifyMinDurationMs` | integer | `10000` | 0 ≤ n ≤ 3600000 |
| `terminalNotifyOnFailure` | boolean | `true` | — |
| `terminalNotifyOnAttention` | boolean | `true` | — |
| `terminalNotifyNative` | boolean | `true` | — |
| `terminalNotifySound` | boolean | `false` | — |
| `notificationsEnabled` | boolean | `true` | — |
| `notifyNeedsYouNative` | boolean | `true` | — |
| `notifyNeedsYouSound` | boolean | `true` | — |
| `notifyOutcomeNative` | boolean | `true` | — |
| `notifyOutcomeSound` | boolean | `true` | — |
| `notifyWarningNative` | boolean | `false` | — |
| `notifyWarningSound` | boolean | `false` | — |
| `notifyTeamNative` | boolean | `true` | — |
| `notifyTeamSound` | boolean | `true` | — |
| `notifyPermissionActions` | boolean | `true` | — |
| `notificationsMigrated` | boolean | `false` | — |
| `notifyDisabledKinds` | array of strings | `[]` | — |
| `notifyKindsMigrated` | boolean | `false` | — |
| `notifyAgentMinDurationMs` | integer | `0` | 0 ≤ n ≤ 3600000 |
| `favoriteModels` | array of strings | `[]` | — |

Any other key under `[settings]` is left on disk untouched and reported as an
`unknownKeys` entry in `get_atlas_config_info` — never treated as an error,
never deleted.

### Theme migration

`atlasTheme` and `codeEditorTheme` are legacy keys. The first schema-1 load
replaces them with the single `theme` setting and deletes both old keys. When
the old editor selection was not the matching editor half of the old interface
theme, its `editor.*`, `syntax.*`, and `diff.*` values become `themeOverrides`
so the user keeps that deliberate combination. There is no separate editor
theme after this migration.

### Mirrored instructions (`instructionSync`)

Some agents read a project's instructions from `CLAUDE.md` and
`.claude/rules/*.md`; others read only `AGENTS.md`. With `instructionSync` on,
Atlas keeps one marked block in the active project's `AGENTS.md` holding
`CLAUDE.md`, `.claude/CLAUDE.md` and each rule file, every one followed by the
project files it imports, for any agent that reads `AGENTS.md`, and rewrites it
whenever any of those files change. The sources stay the place to edit
a rule. The block sits between these two lines, each on a line of its own:

```
<!-- atlas:mirrored-instructions START -->
<!-- atlas:mirrored-instructions END -->
```

- **Which projects.** Switching it on syncs and watches the project open in
  each window, and no other. A project you switch to later is synced when it
  becomes active. An `AGENTS.md` is created only when there is something to
  mirror.
- **Switching it off** stops the watching and takes the block back out of
  every project Atlas wrote it into, open or not, under the same checks as a
  sync below. Atlas remembers those projects in `instruction-sync.json` in its
  app config directory. An `AGENTS.md` that Atlas created and that held
  nothing but the block is deleted; one you made yourself is kept, even when
  removing the block leaves it empty. A sync never deletes `AGENTS.md`.
- **Your text is never changed.** Every byte outside the block, line endings
  included, stays as it was. The block takes the line ending of the line just
  before it. Atlas leaves `AGENTS.md` alone, and logs why, when the markers
  are not exactly one START line followed by one END line (an edited,
  indented, duplicated or deleted marker), when `CLAUDE.md` or a rule has a
  marker on a line of its own, when `AGENTS.md` or `CLAUDE.md` is a link or
  the two are the same file, when `CLAUDE.md` only imports `@AGENTS.md`, when
  `AGENTS.md` is read-only, and when `AGENTS.md` changes while it is being
  written (that write is retried from the new text). The last check and the
  write are two steps, so a save that lands in the instant between them is
  still overwritten; no portable file operation closes that gap. Links are
  detected on macOS, Linux and Windows, hard links included.
- **Pack rules.** A rule a pack projected into `.claude/rules/` is left out
  when `AGENTS.md` already carries it as that pack's own
  `<!-- atlas-pack:{pack}:{rule} START -->` block.
- **Imports.** An `@path` import in any of those files is followed the way
  Claude Code follows it: relative to the importing file, not inside a code
  span or code block, up to 5 hops deep. Each imported file gets its own
  section after the file that imports it, the first time it is imported. Only
  files inside the project are copied in: an import of `~/…` or of a path
  outside the project stays as written and is not expanded, since
  `AGENTS.md` is usually committed. An `@AGENTS.md` import line is left out
  of the block, where it would point `AGENTS.md` at itself.
- Some agents stop reading `AGENTS.md` past a size limit (32 KiB is a common
  default), and the block sits at the end of the file. Atlas logs a warning
  when a sync leaves `AGENTS.md` larger than that.
- A rule's `paths:` frontmatter becomes an "applies when working on" line, since
  `AGENTS.md` has no path scoping. Hooks and permission lists
  (`.claude/settings.json`) are not instructions and are not mirrored.

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

Any status other than `"ok"` reaches the user as a banner at the top of
Settings → General, with "Open config" and "Recreate defaults" beside it.
Both the boot-time status (carried on `bootstrap_app_state`'s
`configStatus`) and later hot-reload failures (`atlas:config-error`) land
there, so a config that failed to load at startup can't quietly serve
defaults — including flipping `shareTelemetry` back on — without saying so.

A file that exists but cannot be *read* at all (permissions, a transient I/O
fault) is treated as `"usingDefaults"`, not as an absent file — as is a
config directory that can't be resolved, and a migration write that fails.
The distinction matters for migration: see below.

"Defaults" there means *compiled* defaults only once migration has been
recorded. Before that, a broken or unwritable `config.toml` falls back to the
legacy `state.json` settings instead, so the user keeps their real
preferences (their telemetry opt-out included) for the session rather than
silently reverting while those preferences sit unused on disk.

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
4. Re-check that the file still holds exactly the content step 1 read. If it
   moved, the merge base is stale: nothing is written and the whole sequence
   restarts on the fresh content (up to three times, then the write is
   refused with "config.toml is being written by something else"). This
   narrows — it cannot fully close, short of an advisory file lock — the
   window between the re-read and the swap, in which a concurrent external
   edit would otherwise be clobbered along with its comments.
5. Write to a uniquely-named temp file in the same directory, `fsync` it,
   then rename it over `config.toml` and `fsync` the directory. The sync
   before the rename is what makes the atomicity real: without it the rename
   can reach disk ahead of the bytes it points at, so power loss just after
   "Settings saved" could leave an empty or half-written file. Temp files are
   removed on every failure path rather than left beside the real config.

The Settings UI additionally passes an `expectedGeneration` — a stale value
(something else changed the file first) is reported back as a conflict. The
store adopts the fresh generation and retries the same patch, up to three
attempts in total, before surfacing an error; one retry wasn't enough to
survive a burst of rapid changes (dragging the zoom slider, say).

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

The marker is set **only** once `config.toml` demonstrably holds the
settings: it either loaded cleanly or was just created. If the file exists
but is malformed or unreadable, migration is deliberately left unrecorded,
because `state.json`'s `settings` object is still the only surviving copy of
the user's preferences at that point.

That copy is protected from the other end too. The typed `AppState` has no
`settings` field any more, so serializing it over `state.json` wholesale
would delete the legacy object — and `state.json` gets saved for reasons
that have nothing to do with settings (a rotated telemetry id, a project
change). `AppState::save` therefore merges over whatever the file already
holds rather than replacing it, and drops the legacy `settings` key only
once `settingsConfigMigrated` is `true`. It writes through a uniquely-named
temp file, `fsync`ed before the rename, for the same reasons `config.toml`
does.

And the preserved copy is actually used: while the marker is `false` and
`config.toml` is unreadable, unparseable, or couldn't be written, those
legacy settings become the effective ones. "Recreate defaults" still writes
compiled defaults — that is what the button says — so it discards them; the
banner offers "Open config" first for exactly that reason.

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
  Also: the compare-and-swap that refuses a write on a stale base, temp-file
  cleanup, external-edit adoption (generation bump + dedup on re-read),
  `ConfigStatus`'s wire shape, and that a malformed or unreadable
  `config.toml` never reports migration as done.
- Rust: `src-tauri/src/state/app_state.rs` — a legacy `settings` key in
  `state.json` doesn't break parsing of the rest of the file, survives a save
  made before migration is recorded, and is dropped once it is.
