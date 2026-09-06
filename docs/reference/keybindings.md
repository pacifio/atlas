# Atlas keybindings (`keybindings.json`)

Every rebindable shortcut in Atlas is an **action** with a stable id
(`panels.left`, `tabs.close`, `terminal.nextTab` …). The registry of actions,
their titles, default chords and the focus context they fire in lives in
`src/features/keybindings/lib/actions.ts`; Settings → Keybindings renders that
registry and lets you rebind each row.

Bindings are grouped into **profiles**. The built-in `Default` profile is
locked and always reflects Atlas's shipped defaults; duplicate it (or create an
empty profile) to customise. Only one profile is active at a time.

## Location

```
~/.config/atlas/keybindings.json      ($XDG_CONFIG_HOME/atlas/keybindings.json if set)
```

A sibling of `config.toml`, for the same reason: it is a document you may edit
by hand. Atlas re-reads it whenever the window regains focus, so edits land
without a relaunch. "Open keybindings.json" in the editor's toolbar opens it.

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
- an absent key means "use the default" — so new actions shipped in a later
  Atlas version work in every existing profile.

### Chord syntax

Lowercase tokens joined by `+`: modifiers first (`cmd`, `ctrl`, `alt`,
`shift`; `command`/`option`/`control`/`meta` are accepted aliases), then exactly
one key. Keys are letters, digits, `f1`–`f24`, punctuation (`; ' [ ] \ / , . = -`
and `` ` ``) or the named keys `space`, `enter`, `tab`, `escape`, `backspace`,
`delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.
`cmd++` means ⌘⇧= (the "⌘+" zoom chord on a US layout).

Chords match on the **physical key**, so `alt+b` works even though macOS types
`∫` for it. `cmd` also matches Ctrl on a keyboard without a Command key.

### When contexts

Most actions are global. Some only fire while a surface has focus and are
shown in the editor's When column: `terminalFocus`, `chatFocus`,
`knowledgeOpen`, `knowledgeFocus`, `pdfFocus`, `canvasFocus`. Scoped actions
may share a chord with a global one (the terminal's ⌘W shadows close-tab while
the terminal is focused); the editor marks that amber. Two actions in the
*same* context sharing a chord is a real conflict (red): the first in registry
order wins.

## Validation

Atlas checks the file's shape when loading and before every save: unique
profile ids, non-empty names, a present and empty `default` profile, an
`activeProfileId` that exists, and syntactically valid chords. A file that
fails to parse is **left untouched** — Atlas runs on the Default profile and
shows the error at the top of Settings → Keybindings. Action ids Atlas doesn't
recognise are preserved verbatim and listed under "Unknown commands".

## Not rebindable

The code editor's CodeMirror keymap, the note editor's formatting shortcuts,
the terminal's readline keys and copy/paste, the native macOS menu bar, arrow
keys inside palettes and lists, and Escape-to-close.
