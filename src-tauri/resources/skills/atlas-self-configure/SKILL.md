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

Editing that file is the supported mechanism, and the only one available to
you: Atlas's config commands are IPC endpoints reachable from its own UI, not
agent tools. Atlas watches the file and validates every change you make (see
step 6 below), so a direct edit is a first-class way in — not a workaround.

If the file does not exist yet, Atlas hasn't created it (a fresh install
before first launch, or the user deleted it). Do not create one speculatively
— report that to the user instead of guessing at defaults.

## The schema is in the file

Atlas writes a comment above every key: what it does, its default, and any
constraint on its value — a numeric range, an exact set of allowed strings,
"must not be empty". **Read those comments and follow them.** They are
generated from the same table Atlas validates against, so they cannot drift
from what it will actually accept.

Do not work from a schema you remember, or from one you saw in another
project. The file in front of you is authoritative, and it is the only thing
guaranteed to match the Atlas build the user is running.

Two things the comments won't spell out:

- **A key that isn't there.** Some settings mean "unset" by being absent —
  TOML has no null. The comment for such a key sits above whichever key
  follows it, so read the whole `[settings]` block, not just the lines with
  values on them. To clear one of these, delete its line; never write an
  empty string.
- **A key Atlas doesn't recognize.** It's preserved untouched and reported to
  the user as a diagnostic. Never delete a key you don't recognize.

## Making a change

1. **Read the whole file first.** You need its comments and formatting to
   avoid disturbing them, and you need the target key's comment to know what
   a valid value even is.
2. **Explain what you're about to change** to the user before writing: the
   key, its current value, the new value, and what it does — quoting the
   file's own comment. Don't silently flip a setting.
3. **Change only the line (or few lines) you mean to change.** Leave every
   other key, comment, and blank line exactly as it was — including the
   comment above the key you're editing, which is Atlas's to rewrite, not
   yours. Do not reformat, reorder, or re-indent anything:

   ```diff
    # Inline git blame — a dim author/age/summary annotation trailing the
    # active line in the editor. (default: true)
   -someSetting = true
   +someSetting = false
   ```
4. **Validate the value against that key's comment before writing.** If the
   comment states a range or a fixed set of values and the user asked for
   something outside it, say so and stop; don't write it and let Atlas reject
   it.
5. **Write atomically:** write your edited content to a new file in the
   *same directory* (e.g. `config.toml.tmp.<random>`), then rename/move it
   over `config.toml`. Never edit in place — a crash or a concurrent Atlas
   reload mid-write must not leave a half-written file behind.
6. **Re-read the file after writing** to confirm your change landed.

Atlas re-validates the whole file whenever it notices a change, live, no
restart. An invalid edit is rejected entirely and Atlas keeps running on the
last good settings — but the file stays as you wrote it, and while it's
invalid Atlas also refuses every settings write from its own UI, until someone
repairs it or uses "Recreate defaults" (which overwrites it, keeping a
`.bak-<unix-seconds>` copy). So a bad write is not free: report it and offer to
restore the exact content you read in step 1, rather than trying to patch your
way out.

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
