# Atlas configuration (`config.toml`)

Reference for Atlas's user-facing preferences file. Written for both humans
hand-editing the file and agents using the `atlas-self-configure` skill
(`src-tauri/resources/skills/atlas-self-configure/SKILL.md`). The skill
deliberately carries no key table: it sends the agent to the file's own
comments, which are generated from the same registry as the schema table
below. See [The settings registry](#the-settings-registry) and
[Testing](#testing).

- **Settings registry:** `src-tauri/settings-registry.toml` — every key's type,
  default, bounds, Settings location and comment. Everything else below is
  generated from it or tested against it.
- **Source of truth (Rust):** `src-tauri/src/state/atlas_config.rs`
  (schema, defaults, validation) and
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
Those comments come from the settings registry, `src-tauri/settings-registry.toml`,
through the generated `SETTINGS_DOCS` table in `state/settings_docs.gen.rs` —
the same table `unknown_keys_in` uses to decide what Atlas recognizes — so they
can't drift from what validation accepts. The complete file a fresh install
gets is committed as [`config.default.toml`](config.default.toml); see
[The settings registry](#the-settings-registry).

That is deliberate, and it's why the bundled `atlas-self-configure` skill
carries no key table of its own: an agent reads the real file and gets a
schema that matches the build in front of it, instead of a copy in a skill
that was projected into `~/.agents/skills` at some earlier version. The
`settings_docs_cover_every_setting` and
`the_self_configure_skill_defers_to_the_files_own_comments` tests hold both
halves of that in place.

A generated file looks like this (abridged — every key gets the same
treatment; `config.default.toml` is the whole thing):

```toml
# Atlas configuration.
#
# Every user-facing Atlas preference lives here. Edit this file by hand or use
# Settings — both write to it, and Atlas picks up external edits live. A change
# takes effect at once unless the key's comment says otherwise.
#
# Your comments, formatting, and any keys Atlas doesn't recognize survive its
# own writes. An invalid value is rejected whole: Atlas keeps running on the
# last settings that loaded cleanly, shows the error in Settings, and leaves
# this file exactly as you wrote it.

# Format version of this file. Atlas manages it; leave it alone.
schemaVersion = 1

[settings]

# Keep Atlas's directory in each opened git project out of version control:
# `.atlas/` goes into the project's .gitignore (created if needed); a dev
# build's `.atlas-dev/` goes into .git/info/exclude. No-op on non-git
# projects. (default: true)
autoAddAtlasGitignore = true

# Record Atlas-internal events (sign-in, agent lifecycle, file and browser
# opens) into the Logs panel. (default: true)
enableAtlasLogs = true

# Show dotfiles and dot-directories in the explorer file tree. (default: true)
showHiddenFiles = true

# Interface zoom, where 1.0 is 100%. Also driven by Cmd +/-/0. Must be a
# number between 0.5 and 2.0. (default: 1.0)
uiScale = 1.0

# … one commented entry per key, in this order, to the end of the file.
```

Note `updaterIgnoredVersion`: a key that serializes to nothing still gets its
comment, carried down onto the next key that is present. Otherwise the one key
whose *absence* carries meaning would be the one key nothing explains.

Comments are only ever written into a file Atlas generates — first run, or
"Recreate defaults" — and above a key Atlas adds to an existing file. Atlas never injects them into a file a user or agent
wrote; `toml_edit` just preserves whatever comments are already there.

## The settings registry

`src-tauri/settings-registry.toml` is the one hand-edited description of every key
under `[settings]`. `bun run settings:gen` writes everything derived from it:

| Output | What it is |
|---|---|
| `src-tauri/src/state/settings_docs.gen.rs` | `SETTINGS_DOCS`, the comment written above each key in a fresh file |
| `src/features/settings/lib/settings-registry.gen.ts` | the TS `AppSettings` type, `DEFAULT_SETTINGS`, and per-key metadata (page, section, title, status) for the Settings UI and its search |
| `docs/reference/settings.json` | the same metadata, read by the docs site (`bun run sync:settings` in `docs-atlas`) |
| the schema table below | between the `generated:settings` markers |

The Rust `AppSettings` struct, its serde defaults and `SettingsPatch` stay
hand-written. `the_settings_registry_matches_app_settings` holds them to the
registry: same keys, same order, same defaults, same bounds, and every enum
value accepted. So adding a setting is a field on the struct, an entry in the
registry, and `bun run settings:gen`; forgetting either half fails a test.

Each entry's `status` says where the key is changed: `live` (a Settings row),
`elsewhere` (another part of the app), `file-only`, or `internal` (Atlas's own
bookkeeping).

## Schema

<!-- generated:settings -->
<!-- Generated from src-tauri/settings-registry.toml — do not edit. Run `bun run settings:gen` after editing that file. -->

| Key | Type | Default | Where to change it | Validation |
|---|---|---|---|---|
| `autoAddAtlasGitignore` | boolean | `true` | General › Files › Keep .atlas out of git | — |
| `enableAtlasLogs` | boolean | `true` | Privacy › Diagnostics › Atlas logs | — |
| `showHiddenFiles` | boolean | `true` | General › Files › Show hidden files | — |
| `preferredEditor` | string | `""` | General › Files › Preferred editor | an editor id; one that isn't installed falls back to the first one found |
| `uiScale` | number | `1.0` | Appearance › Interface › Interface zoom | finite, `0.5`–`2.0` inclusive |
| `shareTelemetry` | boolean | `true` | Privacy › Usage data › Share usage data | — |
| `linkTelemetryToAccount` | boolean | `true` | Privacy › Usage data › Link usage data to my account | — |
| `embeddingModelId` | string | `"all-MiniLM-L6-v2"` | Settings → Memory → Embedding model | non-empty |
| `themeLight` | string | `"atlas"` | Appearance › Themes › Light theme | known theme id; an unknown id is logged and falls back to `"atlas"` |
| `themeDark` | string | `"atlas"` | Appearance › Themes › Dark theme | known theme id; an unknown id is logged and falls back to `"atlas"` |
| `themeMode` | `"system"` \| `"dark"` \| `"light"` | `"system"` | Appearance › Colour scheme › Colour scheme | exactly one of these values; a missing requested variant falls back to the theme's other variant |
| `themeOverrides` | table | absent | file only | optional `base`, `palette`, and `keys` patch applied after the active theme variant; a bad entry is dropped, not fatal |
| `iconTheme` | string | `"material-icon-theme"` | Appearance › File icons › File icon theme | a plain id (letters, digits, `.`, `-`, `_`) — it names a directory under `~/.config/atlas/icon-themes/`. `"minimal"` keeps Atlas's lucide icons. See `docs/reference/icon-themes.md` |
| `appIcon` | string | `"dark"` | Appearance › Interface › App icon | a plain id (letters, digits, `-`, `_`) from `src-tauri/icons/app-icons/app-icons.json` — today `"dark"` or `"light"`. An id this Atlas does not ship shows the default without rewriting the file |
| `adaptiveSuggestions` | `"agent"` \| `"off"` | `"agent"` | Sessions › Conversation › Next-step suggestions | exactly one of these two strings |
| `agentSwitchBehavior` | `"reset"` \| `"new-tab"` \| `"handoff"` | `"reset"` | Sessions › Switching agents › Switching agents in a session | exactly one of these three strings. An empty chat always switches in place and a running one always gets a new tab, whatever this says |
| `rememberBeforeSwitch` | boolean | `false` | Sessions › Switching agents › Save to memory before switching agents | — . Acts only on a chat with a conversation whose agent advertises `/remember` (the bundled `remember` skill); waits at most 3 minutes, and the user can switch at once |
| `gitBlameInline` | boolean | `true` | Source Control › Editor › Inline Git blame (per project too) | — |
| `gitAutoFetch` | boolean | `true` | Source Control › Repositories › Auto-fetch from remote (a project can turn it off) | — |
| `keepAwakeWhileRunning` | boolean | `false` | General › System › Keep awake while an agent is working | no effect on Windows |
| `autoUpdate` | boolean | `true` | Updates › Atlas › Automatic updates | — |
| `curatedPluginSync` | boolean | `false` | Updates › Atlas Agent › Keep Atlas Agent's plugin catalog up to date | — |
| `instructionSync` | boolean | `false` | Memory › Instructions › Mirror CLAUDE.md and .claude/rules into AGENTS.md | — . See [Mirrored instructions](#mirrored-instructions-instructionsync) |
| `updaterIgnoredVersion` | string, or absent | absent | managed by Atlas | — |
| `enterToSend` | boolean | `true` | Sessions › Composer › Enter to send | — |
| `agentUiNavigation` | boolean | `true` | Agents › Atlas Agent permissions › Let Atlas Agent navigate the app (a project can turn it off) | — |
| `agentOrgAccess` | boolean | `true` | Agents › Atlas Agent permissions › Let Atlas Agent act in your organization (a project can turn it off) | — |
| `agentCodeTools` | boolean | `true` | Agents › All agents › Let agents search code with Atlas (a project can turn it off) | — |
| `memoryDreams` | boolean | `false` | Memory › Shared memory › Nightly memory review (a project can turn it off) | — |
| `memoryRepoMirror` | boolean | `false` | Memory › Shared memory › Mirror memory as an Agent Memory Repo (a project can turn it off) | — |
| `atlasOnlyMemory` | boolean | `true` | Memory › Shared memory › Atlas is the only memory in Atlas sessions | — |
| `terminalNotifyMinDurationMs` | integer | `10000` | Notifications › Notifications › Notify on command success after | 0 ≤ n ≤ 3600000 |
| `notificationsEnabled` | boolean | `true` | Notifications › Notifications › Notifications | — |
| `notifyNeedsYouNative` | boolean | `true` | Notifications › Needs you › System notification | — |
| `notifyNeedsYouSound` | boolean | `true` | Notifications › Needs you › Sound | — |
| `notifyOutcomeNative` | boolean | `true` | Notifications › Outcomes › System notification | — |
| `notifyOutcomeSound` | boolean | `true` | Notifications › Outcomes › Sound | — |
| `notifyWarningNative` | boolean | `false` | Notifications › Warnings › System notification | — |
| `notifyWarningSound` | boolean | `false` | Notifications › Warnings › Sound | — |
| `notifyTeamNative` | boolean | `true` | Notifications › Team › System notification | — |
| `notifyTeamSound` | boolean | `true` | Notifications › Team › Sound | — |
| `notifyPermissionActions` | boolean | `true` | Notifications › Needs you › Banner actions on permission requests | — |
| `notifyDisabledKinds` | array of strings | `[]` | Notifications › Kinds › Notification kinds | unknown ids are ignored |
| `notifyAgentMinDurationMs` | integer | `0` | Notifications › Notifications › Notify on agent finish after | 0 ≤ n ≤ 3600000 |
| `favoriteModels` | array of strings | `[]` | the star in the composer's model picker | entries are `agentType:modelId`; unknown entries are ignored |
| `confirmDeleteChat` | boolean | `true` | General › Confirmations › Confirm before deleting a session | — |
| `confirmQuitWhileRunning` | boolean | `true` | General › Confirmations › Confirm before quitting while an agent is running | — |
| `defaultAgent` | string | `"atlas-agent"` | Sessions › New sessions › Default agent (per project too) | a non-empty agent id; one that isn't installed falls back to Atlas Agent |
| `chatWidth` | `"normal"` \| `"wide"` \| `"full"` | `"normal"` | Appearance › Interface › Session width | exactly one of these three strings |
| `wordWrap` | boolean | `true` | Appearance › Interface › Word wrap | — |
| `sidebarSort` | `"recent"` \| `"created"` | `"recent"` | Sessions › Layout › Sort sessions by | exactly one of these two strings |
| `autoSettleAfterDays` | integer | `3` | Sessions › Layout › Settle idle sessions after | 0 ≤ n ≤ 90 |
| `timeFormat` | `"system"` \| `"12h"` \| `"24h"` | `"system"` | General › System › Time format | exactly one of these three strings |
| `uiFontFamily` | string | `""` | Appearance › Typography › Interface font | a CSS font-family list, at most 200 characters, with no `{`, `}`, `;`, `<` or `>`; empty uses the system font |
| `codeFontFamily` | string | `""` | Appearance › Typography › Code font | a CSS font-family list, at most 200 characters, with no `{`, `}`, `;`, `<` or `>`; empty uses the default |
| `composerFontFamily` | string | `""` | Appearance › Typography › Composer font | a CSS font-family list, at most 200 characters, with no `{`, `}`, `;`, `<` or `>`; empty uses the interface font |
| `terminalFontFamily` | string | `""` | Appearance › Typography › Terminal font | a CSS font-family list, at most 200 characters, with no `{`, `}`, `;`, `<` or `>`; empty uses the code font |
| `editorFontSize` | integer | `13` | Appearance › Typography › Editor font size | 8 ≤ n ≤ 32 |
| `terminalFontSize` | integer | `13` | Appearance › Typography › Terminal font size | 8 ≤ n ≤ 32 |
| `diffIgnoreWhitespace` | boolean | `false` | Source Control › Diffs › Hide whitespace changes | — |
| `diffFilesCollapsed` | boolean | `true` | Source Control › Diffs › Start files collapsed | — |
| `diffPalette` | `"theme"` \| `"blue-orange"` | `"theme"` | Appearance › Interface › Diff colours | exactly one of these two strings |
| `interfaceContrast` | integer | `100` | Appearance › Interface › Contrast | 50 ≤ n ≤ 200 |
| `showTurnRail` | boolean | `true` | Appearance › Interface › Turn rail | — |
| `autoSettleOnMerge` | boolean | `true` | Pull Requests › Sessions › Settle sessions when their pull request merges | — |
| `autoSettleKeepPullRequests` | boolean | `true` | Pull Requests › Sessions › Keep sessions with a pull request from settling | — |
| `pullRequestWatchWakes` | boolean | `true` | Pull Requests › Sessions › Let agents act on watched pull requests | — |
| `pullRequestLinksOpenInApp` | boolean | `true` | Pull Requests › Links › Open pull request links in Atlas | — |
| `pullRequestMergeMethod` | `"last"` \| `"merge"` \| `"squash"` \| `"rebase"` | `"last"` | Pull Requests › Merging › Default merge method (per project too) | exactly one of these four strings |
| `removeAgentCreditsOnMerge` | boolean | `false` | Pull Requests › Merging › Remove agent credits when merging (per project too) | — |
| `pullRequestGuideEnabled` | boolean | `true` | Pull Requests › Review guide › Review guides (per project too) | — |
| `pullRequestGuideAgent` | string | `""` | Pull Requests › Review guide › Guide agent (per project too) | an agent id (letters, digits, `-`, `_`, `.`), at most 64 characters; empty uses the default agent |
| `pullRequestGuideModel` | string | `""` | Pull Requests › Review guide › Guide model (per project too) | one line, at most 200 characters; empty keeps the agent's default |
| `pullRequestGuideInstructions` | string | `""` | Pull Requests › Review guide › Guide instructions (per project too) | at most 4000 bytes |

<!-- /generated:settings -->

Any other key under `[settings]` is left on disk untouched and reported as an
`unknownKeys` entry in `get_atlas_config_info` — never treated as an error,
never deleted.

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
compiled defaults  <  config.toml  <  <project>/.atlas/config.toml
```

There is no durable UI or session layer: a Settings change **is** a file
write, immediately.

### Per-project settings

A project can override a few keys in its own `.atlas/config.toml`
(`.atlas-dev/` under the dev profile). The file is sparse — it holds only the
keys that project changes — and lives in the directory Atlas keeps out of
git, so an override normally belongs to the user, not the team.

- **Eligible keys** are the ones the registry marks `project = true`, listed
  in the generated `PROJECT_SETTING_KEYS`. A key qualifies only when every
  reader of it knows which project it is acting in: the three Atlas Agent
  permissions (read per session, from the session's launch directory),
  `gitAutoFetch`, `gitBlameInline`, `memoryDreams` and `memoryRepoMirror`.
  Any other key in a project file is left there, reported as ignored, and
  never applied.
- **Tighten-only keys.** Nothing stops a repository from committing its
  `.atlas/config.toml`, and a clone carries it. So every eligible key that
  grants access or sends data — all of them except `gitBlameInline` — is
  `project = "tighten"` (`PROJECT_TIGHTEN_ONLY_KEYS`): a project can turn it
  off, never on while it is off for all projects. A file that tries is
  refused for that key (`refusedKeys`), and Settings says so; the UI will not
  write one either.
- **Resolution** is one function, `state::project_config::resolve`: the
  global settings with each override laid over them, validated as a whole.
  A file that does not parse or validate is not applied at all, and Settings
  says why.
- **Readers** in Rust go through
  `commands::project_settings::effective_settings_for(app, project_root)`. It
  caches each file and re-reads it when its mtime or size changes, so a hand
  edit applies on the next read and a hot path costs one `stat`.
- **Settings** pages with eligible keys open with "Applying settings for
  [All projects ▾]". Picking a project makes those rows show and edit that
  project's value. A layers icon says whether the value is the project's own
  or inherited, and the reset button removes the override. Rows a project
  cannot override go read-only.
- **Writes** go through `toml_edit`, like the global file: a hand-written
  comment survives, and a key the UI adds arrives with its registry comment.

## Loading, validation, and failure behavior

Every read — cold start, a UI patch, an external edit picked up by the
watcher — validates the **complete candidate** before it replaces anything.
A malformed or invalid file never partially applies and never gets
auto-repaired, renamed, or overwritten by Atlas on its own:

- **Cold start, file missing:** normal (first run, or the user deleted it on
  purpose) — the documented defaults are written, `status: "ok"`.
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
Settings → General, with "Open config.toml" and "Recreate defaults" beside it.
Settings → Privacy › Settings file shows the same status at any time, with the
file's path and the `unknownKeys` list, so a typo'd key is visible rather
than silently ignored.
Both the boot-time status (carried on `bootstrap_app_state`'s
`configStatus`) and later hot-reload failures (`atlas:config-error`) land
there, so a config that failed to load at startup can't quietly serve
defaults — including flipping `shareTelemetry` back on — without saying so.

A file that exists but cannot be *read* at all (permissions, a transient I/O
fault) is treated as `"usingDefaults"`, not as an absent file — as is a
config directory that can't be resolved, and a first-run write that fails.

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

## First run

When `config.toml` doesn't exist, Atlas writes the fully commented defaults
(`config.default.toml`). There is no import from older storage: Atlas is in
alpha and keeps no migration paths. A key an older build wrote and this one
doesn't know shows up under unknown keys in Settings › Privacy › Settings
file, and can be deleted.

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
- **Per-project shared-memory switches.** Consent to share memory is given
  per repository, so it lives in `<project>/.atlas/memory-sharing.json`, set
  from the Memory panel (the Shared pill and its settings popover), not here:
  - `enabled` (default `true`): the project's sessions get the memory tools,
    their activity is captured, and the extractor runs.
  - `fromExternalSessions` (default `false`): extraction also reads the
    coding-agent sessions the capture recorder imported from outside Atlas
    (a terminal Claude Code session's own transcript), which sends their
    transcripts to the extraction model (the Atlas model, or your provider
    key), the same as in-app sessions. Has no effect while `enabled` is
    `false`. Off, those sessions are never read for extraction; the
    briefing's handoff note still names their files and commits, read
    locally.
- **Any "is a credential configured" presence flag.** Even a boolean is
  security-sensitive derived state; the BYOK UI computes availability at
  runtime from the environment instead of persisting it here.

## Testing

- Rust: `the_settings_registry_matches_app_settings` pins `AppSettings` to
  `src-tauri/settings-registry.toml`, and `config_default_file_matches_the_committed_copy`
  pins the generated file to `docs/reference/config.default.toml`
  (`ATLAS_BLESS=1 cargo test -p atlas config_default` rewrites it).
- TS: `tests/settings-registry.test.ts` fails when any generated output is
  stale (`bun run settings:gen`).
- Rust: `src-tauri/src/state/atlas_config.rs` (`#[cfg(test)] mod tests`) —
  defaults, missing-key fallback, comment/unknown-key preservation across a
  patch, invalid values, unsupported future schema, malformed cold-start and
  hot-reload behavior, generation conflicts, reset/backup, and first run.
  Also: the compare-and-swap that refuses a write on a stale base, temp-file
  cleanup, external-edit adoption (generation bump + dedup on re-read),
  `ConfigStatus`'s wire shape, and that an unreadable `config.toml` is
  flagged rather than treated as absent.
- Rust: `src-tauri/src/state/app_state.rs` — a `settings` key an older build
  left in `state.json` doesn't break parsing of the rest of the file, and the
  next save drops it.
