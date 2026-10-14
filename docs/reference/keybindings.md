# Atlas keybindings (`keybindings.json`)

Every rebindable shortcut in Atlas is an **action** with a stable id
(`panels.left`, `tabs.close`, `terminal.nextTab` …). The registry of actions,
their titles, default chords and the focus context they fire in lives in
`src/features/keybindings/lib/actions.ts`; Settings → Keybindings renders that
registry and lets you rebind each row.

Bindings are grouped into **profiles**. The built-in `Default` profile is
locked and always reflects Atlas's shipped defaults; duplicate it (or create an
empty profile) to customise. Only one profile is active at a time.

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

### When contexts

Most actions are global. Some only fire while a surface has focus — for a
surface that lives in a tab, while that tab is the active tab of the focused
split — and are shown in the editor's When column: `terminalFocus`, `chatFocus`,
`knowledgeOpen`, `knowledgeFocus`, `pdfFocus`, `canvasFocus`. Scoped actions
may share a chord with a global one (the terminal's ⌘W shadows close-tab while
the terminal is focused); the editor marks that amber. Two actions in the
*same* context sharing a chord is a real conflict (red): the first in registry
order wins.

## Modifier-held navigation hints

Hold Command on macOS or Control on Windows/Linux for 400 ms to see small
keycaps beside eligible tabs and panel controls. Press a displayed key while
keeping its modifiers held to run the existing shortcut. Release the primary
modifier to dismiss the caps immediately. On macOS, holding Control also
reveals Control-based bindings, such as the VS Code, Cursor and Zed presets'
tab indices.

The cap shows only the remaining key. Hold Shift or Alt/Option as well to see
commands requiring those modifiers; for example, Command shows `B` on the
left-panel control, and Command+Shift shows `B` on the right-panel control.
The shipped navigation bindings are unchanged:

| Destination | macOS default | Windows/Linux default |
| --- | --- | --- |
| Tab 1–8 in the focused pane | Command+1–8 | Control+1–8 |
| Last tab in that pane | Command+9 | Control+9 |
| Previous / next tab, wrapping in that pane | Command+Shift+[ / ] | Control+Shift+[ / ] |
| Project sidebar | Command+Shift+. | Control+Shift+. |
| Left / right panel | Command+B / Command+Shift+B | Control+B / Control+Shift+B |
| Adjacent pane, stopping at the edges | Option+; / Option+' | Alt+; / Alt+' |

Numeric caps belong only to the focused pane, and follow its tab order. The
last tab prefers its index when it has one; `9` remains available even with
more than nine tabs. Adjacent panes advertise their focus command when a
custom binding matches the held primary modifier. The default Alt-only pane
shortcuts remain available independently. Without a project, the single tab
strip, its numeric hints and its navigation actions all use only the visible
projectless tabs, including those kept in different saved groups. Hidden
project-only tabs no longer occupy indices or cycling destinations. Home has
no tab-index action and therefore no cap.

Previously, navigation shortcuts were discoverable through settings and
individual labels only. The overlay now reads the same resolved profile and
registered actions as dispatch: rebinding, unbinding and preset changes take
effect live. One shared subscription supplies both the visual caps and
`aria-keyshortcuts`, including late handler registration, unregistration,
handler-set changes and scope/focus changes while no modifier is held.
A conflicting global action, an active scoped handler (such as
a terminal shortcut), or an operating-system reservation suppresses the cap
for that chord. Scoped handlers can decline an event, but hints conservatively
omit claimed chords rather than invoking a handler to guess its result.
There is no new Command/Control+Tab handler or second navigation dispatcher.

The overlay never takes focus, intercepts pointer input or consumes a key
event. It has no motion, including with reduced motion enabled. The real
controls retain their accessible names and expose `aria-keyshortcuts`; the
visual caps are hidden from assistive technology to avoid duplicate labels.
Hidden, disabled and clipped targets are omitted. Tab caps use the icon area
to keep titles readable. Positions and eligibility
are refreshed on layout mutations, scrolling, resizing and focus changes,
with DOM observation active only while the modifier is held.

Quick presses do not flash an overlay. An unrelated shortcut, pointer press,
IME composition, open menu/dialog/listbox, shortcut recording, or the separate
Hint Navigation mode dismisses it until the modifier is released. Losing
window focus or hiding the document also resets the hold.

The navigation-hints unit and component suites cover platform conventions,
modifier lifetime, profile changes, scoped dispatch and split-local target
mapping using the real layout store and hotkey handlers. Browser checks can
verify layout and dispatch, but do not establish how native macOS menus or
an embedded browser webview intercept keys; those still need native-window QA.

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

It carries the preset and the overrides, never the resolved chords, so the
recipient stays on Atlas's moving defaults for everything else. **Import a
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
`activeProfileId` that exists, and syntactically valid chords. A file that
fails to parse is **left untouched** — Atlas runs on the Default profile and
shows the error at the top of Settings → Keybindings. Action ids Atlas doesn't
recognise are preserved verbatim and listed under "Unknown commands".

## Not rebindable

The code editor's CodeMirror keymap, the note editor's formatting shortcuts,
the terminal's readline keys and copy/paste, the native macOS menu bar, arrow
keys inside palettes and lists, and Escape-to-close.
