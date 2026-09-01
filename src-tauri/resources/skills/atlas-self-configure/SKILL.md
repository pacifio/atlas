---
name: atlas-self-configure
description: Inspect and safely update Atlas user preferences through Atlas's config.toml.
---

# Atlas self-configure

Atlas's user-facing preferences live in one human-editable file,
`config.toml`. This skill is how you (an agent) read and change it safely —
without touching anything else Atlas persists.

## Where the file lives

- macOS: `~/Library/Application Support/dev.atlas.ide/config.toml`
- Linux: `~/.config/dev.atlas.ide/config.toml`
- Windows: `%APPDATA%\dev.atlas.ide\config.toml`

If you are the Atlas native agent and have a `get_atlas_config_info` tool
available, prefer it — it returns the exact resolved path plus the current
validated settings, generation number, and any load error, without you
having to guess at platform conventions or race a concurrent write.

If the file does not exist yet, Atlas hasn't created it (a fresh install
before first launch, or the user deleted it). Do not create one speculatively
— report that to the user instead of guessing at defaults.

## The schema

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
# updaterIgnoredVersion is absent unless the user has ignored a specific
# version — TOML has no null, so "unset" means the key isn't there at all.
enterToSend = true
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `autoAddAtlasGitignore` | boolean | `true` | Adds `.atlas/` to a project's `.gitignore` on open. |
| `enableAtlasLogs` | boolean | `true` | Records Atlas-internal events into the Logs panel. |
| `showHiddenFiles` | boolean | `true` | Shows dotfiles in the file explorer. |
| `uiScale` | number | `1.0` | Interface zoom. **Must be between 0.5 and 2.0.** |
| `shareTelemetry` | boolean | `true` | Anonymous product telemetry opt-out switch. |
| `linkTelemetryToAccount` | boolean | `true` | Attribute telemetry to the signed-in account instead of the anonymous device id. |
| `embeddingModelId` | string | `"all-MiniLM-L6-v2"` | Selected on-device embedding model id. **Must not be empty.** |
| `codeEditorTheme` | string | `"atlas"` | Code editor color theme id. **Must not be empty.** |
| `atlasTheme` | string | `"atlas-black"` | Atlas interface theme id. **Must not be empty.** |
| `adaptiveSuggestions` | `"agent"` \| `"off"` | `"agent"` | Next-step suggestion chips in chat. Exactly one of these two strings — nothing else. |
| `gitBlameInline` | boolean | `true` | Inline git blame in the editor. |
| `autoUpdate` | boolean | `true` | Auto-update master switch. |
| `updaterIgnoredVersion` | string, or the key absent | absent | A version the user chose to skip. Set the key to clear it back to "nothing ignored" by removing the line entirely — do not write an empty string. |
| `enterToSend` | boolean | `true` | Chat composer send gesture. |

Any key not in this table is left alone by Atlas (preserved, surfaced as a
diagnostic) — never delete a key you don't recognize.

## Making a change

1. **Read the whole file first.** You need to see existing comments and
   formatting so your edit doesn't disturb them.
2. **Explain what you're about to change** to the user before writing:
   the key, its current value, the new value, and what it actually does
   (from the table above) — don't silently flip a setting.
3. **Change only the one line (or few lines) you mean to change.** Leave
   every other key, comment, and blank line exactly as it was. Do not
   reformat, reorder, or re-indent the rest of the file.
4. **Validate the value yourself before writing:**
   - `uiScale` must be a finite number in `[0.5, 2.0]`.
   - `adaptiveSuggestions` must be exactly `"agent"` or `"off"`.
   - String fields (`embeddingModelId`, `codeEditorTheme`, `atlasTheme`) must
     not be empty.
   - To clear `updaterIgnoredVersion`, remove the line; don't write `""`.
5. **Write atomically:** write your edited content to a new file in the
   *same directory* (e.g. `config.toml.tmp.<random>`), then rename/move it
   over `config.toml`. Never edit the file in place or write directly to
   `config.toml` — a crash or a concurrent Atlas reload mid-write must never
   leave a half-written file behind.
6. **Re-read the file after writing** to confirm your change landed as
   expected.
7. Atlas does its own full validation pass whenever it notices the file
   changed (this happens live, no restart required for any setting above).
   If your edit was invalid despite step 4, Atlas rejects it entirely and
   keeps running on the last good settings — report that to the user rather
   than trying to "fix" the file further yourself; ask them what they
   actually want instead.

## What this skill must never touch

- API keys, tokens, or any credential — Atlas doesn't store these in a file
  it owns at all; they live in the user's own shell profile. Never write
  secrets into `config.toml`.
- `state.json`, `device.json`, `telemetry.json` — separate files with
  separate ownership; not in scope for this skill.
- The user's shell profile (`~/.zshrc` and similar).
- Atlas's own binary, packages, or update mechanism. "Self-configure" means
  preferences only, never self-update.
- Session history, transcripts, or any per-project `.atlas/` state — none of
  that is a "setting."

If a request needs any of the above, say so plainly and stop — it's out of
scope for this skill, not something to work around.

## Examples

**Turn off a boolean** (`gitBlameInline`):
```diff
-gitBlameInline = true
+gitBlameInline = false
```

**Change an enum** (`adaptiveSuggestions`):
```diff
-adaptiveSuggestions = "agent"
+adaptiveSuggestions = "off"
```

**Change a bounded number** (`uiScale`, requesting 150%):
```diff
-uiScale = 1.0
+uiScale = 1.5
```
(Reject a request for e.g. `3.0` — out of the `[0.5, 2.0]` range; tell the
user the valid range instead of writing it anyway.)
