# Atlas keybindings (`keybindings.json`)

Every rebindable shortcut in Atlas is an **action** with a stable id
(`panels.left`, `tabs.close`, `terminal.nextTab` …). The registry of actions,
their titles, default chords and the focus context they fire in lives in
`src/features/keybindings/lib/actions.ts`; Settings → Keybindings renders that
registry and lets you rebind each row.

Bindings are grouped into **profiles**. The built-in `Default` profile never
changes and always reflects Atlas's shipped defaults: the first edit made while
it is active (a rebind, or a different keymap under "Start from") forks it into
an active **My keybindings** profile and lands there. Only one profile is
active at a time; the Keymap section's menu creates, renames, deletes, copies
and imports them.

In the editor, click a shortcut and press the new keys; it saves as soon as a
complete chord lands. Esc, Tab or a click elsewhere cancels, and ⌫ removes the
shortcut. A chord that clashes, or that macOS keeps for itself, still saves,
with a warning and an Undo. Search takes a name or a shortcut written out
(`cmd k`, `cmd+shift+p`); the keyboard button in the field searches by pressing
the shortcut instead.

**Add keybinding**, beside the search, adds a row where you pick a command,
press its shortcut, optionally set its condition, and Save; the page then
scrolls to that command.

## Presets and the first-run question

A profile can be **based on** another editor's keys: `vscode`, `cursor`,
`zed` or `jetbrains` (`src/features/keybindings/lib/presets.ts`). A preset
names only the commands that editor has a well-known equivalent for; every
other command keeps Atlas's chord. Each table follows that editor's macOS
default keymap, and none carries a multi-stroke chord (`⌘K ⌘S`), which Atlas
cannot match.

On first launch — while there is no `keybindings.json` — Atlas asks which
editor you're coming from. Picking one creates a profile based on it; "Atlas"
and "Decide later" keep the Default profile. Every answer writes the file, so
the question is asked once, and deleting the file asks it again. Change a
profile's preset later with **Keys from** in Settings → Keybindings.

## Location

```
~/.config/atlas/keybindings.json      ($XDG_CONFIG_HOME/atlas/keybindings.json if set)
```

A sibling of `config.toml`, for the same reason: it is a document you may edit
by hand. Atlas re-reads it whenever the window regains focus, so edits land
without a relaunch. The file button beside **Add keybinding** opens it.

## Format

```json
{
  "version": 1,
  "activeProfileId": "profile-abc",
  "profiles": [
    { "id": "default", "name": "Default", "builtIn": true, "bindings": {} },
    {
      "id": "profile-abc",
      "name": "My keybindings",
      "basedOn": "vscode",
      "bindings": {
        "panels.left": ["cmd+shift+l"],
        "panels.right": null,
        "view.zoomIn": ["cmd+=", "cmd+shift+="]
      }
    }
  ]
}
```

A profile stores **overrides only**:

- `"action.id": ["chord", …]` replaces the action's default chords;
- `"action.id": null` unbinds it;
- an absent key means "use the default" — the preset's chords if the
  profile's `basedOn` preset names the action, otherwise Atlas's — so new
  actions shipped in a later Atlas version work in every existing profile.

An unknown `basedOn` (a newer Atlas wrote it, or a typo) is kept on disk and
ignored, with a warning in Settings.

### Chord syntax

Lowercase tokens joined by `+`: modifiers first (`cmd`, `ctrl`, `alt`,
`shift`; `mod`/`command`/`option`/`control`/`meta`/`super`/`win` are accepted
aliases), then exactly one key. Keys are letters, digits, `f1`–`f24`, punctuation (`; ' [ ] \ / , . = -`
and `` ` ``) or the named keys `space`, `enter`, `tab`, `escape`, `backspace`,
`delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.
`cmd++` means ⌘⇧= (the "⌘+" zoom chord on a US layout).

Chords match on the **physical key**, so `alt+b` works even though macOS types
`∫` for it.

`cmd` is the **primary modifier**: ⌘ on macOS, Ctrl on Windows and Linux. On
macOS every modifier must match exactly, so `cmd+b` does not fire on ⌃B. Off
macOS `cmd+x` and `ctrl+x` are the same key; the editor treats two commands
bound that way as conflicting. `cmd+ctrl+x` means Ctrl+Super/Win there.

### When conditions

Every action fires under a **when** condition, shown under its title in the
editor ("When Always", "When terminalFocus"). Click it to edit: type an
expression, or build it with **+ Add** (a condition, or a group joined by
and / or), flip **Not**, and pick the variable. An action set to Always offers
one-click picks such as "Not in the terminal". A valid expression saves as you
type, like every other setting.

A condition belongs to the action, not to one of its chords: every shortcut an
action has fires under the same condition. The parser and evaluator are `src/features/keybindings/lib/when.ts`.

An expression joins variables with `!`, `&&`, `||` and parentheses; `!` binds
tightest and `||` loosest. Empty means always.

| variable                        | true while                                            |
| ------------------------------- | ----------------------------------------------------- |
| `terminalFocus`                 | the terminal has the keyboard                         |
| `chatFocus`                     | the focused split's active tab is a chat              |
| `editorFocus`                   | … is the code editor                                  |
| `knowledgeFocus`                | … is Knowledge                                        |
| `pdfFocus`                      | … is a PDF                                            |
| `canvasFocus`                   | … is a canvas or a space                              |
| `browserFocus`                  | … is the browser                                      |
| `diffFocus`                     | … is the review diff                                  |
| `pullRequestFocus`              | … is a pull request                                   |
| `inputFocus`                    | a text field, text area or rich-text editor has focus |
| `knowledgeOpen`                 | the focused split's active tab is Knowledge           |
| `modelPickerOpen`               | the composer's model picker has focus                 |
| `isMac`, `isWindows`, `isLinux` | Atlas is running on that system                       |
| `true`, `false`                 | always / never                                        |

At most one of the `…Focus` variables is true at a time. A variable Atlas
doesn't provide is always false, and the editor marks it.

Most actions default to always. Some only exist inside one panel — terminal
find, saving in Knowledge — and default to that panel's variable. Their
handler lives in that panel, so a condition can only **narrow** where they
fire: `terminalFocus && !inputFocus` works; `chatFocus` on terminal find
means it never fires, and the editor warns. Global actions take any
condition: `!terminalFocus` on the command palette keeps ⌘K from opening it
while the terminal has focus.

Scoped actions may share a chord with a global one (the terminal's ⌘W shadows
close-tab while the terminal is focused); the editor flags that amber only once
a profile or keymap has changed one side. Two actions under the _same_
condition sharing a chord is a real conflict (red): the first in registry order
wins.

A profile stores conditions it changed under `when`, beside `bindings`:

```json
{
  "id": "profile-abc",
  "name": "My keybindings",
  "bindings": {},
  "when": { "nav.commandPalette": "!terminalFocus" }
}
```

An absent key keeps the action's own condition; `""` means always. Reset to
default clears both the chords and the condition.

## Sharing a profile

**Copy as JSON** (the clipboard icon in Settings → Keybindings) copies the
active profile in a stable, versioned form:

```json
{
  "atlasKeybindings": 1,
  "name": "My keybindings",
  "basedOn": "vscode",
  "bindings": { "panels.left": ["cmd+shift+l"] }
}
```

It carries the preset, the overrides and any `when` conditions, never the
resolved chords, so the recipient stays on Atlas's moving defaults for everything else. **Import a
profile…** takes that JSON and adds it as a new, active profile. A newer
`atlasKeybindings` version is rejected; commands and presets this Atlas
doesn't know are kept.

## Reserved chords

The recorder warns when a chord belongs to the operating system (⌘Q, ⌘H, ⌘M,
⌘Space, ⌘Tab, ⌘\`, the screenshot chords, Mission Control's ⌃arrows …;
Alt+Tab and Alt+F4 elsewhere). It still lets you bind one: with the system
shortcut turned off, it works.

## The native Close Tab item

On macOS, Window ▸ Close Tab carries the first chord bound to `tabs.close`.
That menu item is what closes a tab while the embedded browser has focus, so
it follows a rebind. A chord it can't express (punctuation) leaves the item
without one.

## Validation

Atlas checks the file's shape when loading and before every save: unique
profile ids, non-empty names, a present and empty `default` profile, an
`activeProfileId` that exists, and syntactically valid chords and `when`
expressions. A file that
fails to parse is **left untouched** — Atlas runs on the Default profile and
shows the error at the top of Settings → Keybindings. Action ids Atlas doesn't
recognise are preserved verbatim and listed under "Unknown commands".

## Not rebindable

The file view's editing keys (undo, find's next and previous), the note editor's formatting shortcuts,
the terminal's readline keys and copy/paste, the native macOS menu bar, arrow
keys inside palettes and lists, and Escape-to-close.
