# Icon themes

Atlas file and folder icons use **VS Code's `iconThemes` contribution format,
verbatim** (theme-system decision 4). A theme published for VS Code installs
here unchanged — there is no Atlas icon-theme format, no conversion step, and
no separate schema to learn.

This page is the reference for what Atlas reads, in what order, from where, and
what it deliberately does not do. The colour side of theming is
`docs/reference/theme-keys.md`; the two are separate tracks and are chosen
separately in Settings.

## Where themes come from

| Source                  | Location                                                       | Removable |
| ----------------------- | -------------------------------------------------------------- | --------- |
| **Minimal**             | built in — no document at all                                  | no        |
| **Material Icon Theme** | bundled, `crates/atlas-icon-theme/vendor/material-icon-theme/` | no        |
| Installed themes        | `~/.config/atlas/icon-themes/<publisher>.<name>/`              | yes       |

The selection lives in `~/.config/atlas/config.toml` as `iconTheme`:

```toml
[settings]
iconTheme = "material-icon-theme"   # or "minimal", or an installed id
```

The value is a single path segment (letters, digits, `.`, `-`, `_`) because it
names a directory under the icon-themes folder. Anything else is refused at
validation, so a config edit cannot make Atlas read outside that directory.

### "Minimal"

`minimal` is not an empty icon theme, it is **no** icon theme: every row falls
back to the lucide icon Atlas drew before icon themes existed. It is also what
you see for a split second while a resolution is in flight, and what you see
for anything the active theme has no answer for — one code path, so switching
to Minimal never changes the shape of anything twice.

### The bundled default

Material Icon Theme 5.38.1, MIT, vendored whole with its `LICENSE.txt` and a
provenance note (`ATTRIBUTION.txt`) alongside it. vscode-icons is deliberately
**not** bundled: its icons are CC BY-SA, which Atlas cannot redistribute on the
same terms.

### Installing from Open VSX

**Settings → Icons → Install from Open VSX.** Open VSX is the only remote
source Atlas has for icons. Type a query, press Enter, pick a result, install.

A few properties worth knowing:

- **Nothing is fetched at startup, or on a timer.** Every request is one a
  person asked for by clicking.
- The search is filtered on each candidate's real `package.json` — a result
  appears only if it declares `contributes.iconThemes`, so colour themes do not
  clutter an icon-theme picker. (Colour themes are searched the same way, from
  the theme import dialog; the client both use is `src-tauri/src/open_vsx.rs`.)
- Being offline costs a search, not a launch: the failure is reported in place,
  with a retry, and the installed list is untouched.
- The `.vsix` is a zip. Only its `extension/` subtree is unpacked, every entry
  is checked for path traversal, and the unpack goes to a staging directory that
  is only swapped into place once the result loads as an icon theme. A failed
  install leaves what you had.

Themes are installed under `<namespace>.<name>` — `PKief.material-icon-theme`.

## The format

Everything below is VS Code's, not Atlas's. The authority is the theme document
named by `contributes.iconThemes[0].path` in the extension's `package.json`.

### `iconDefinitions`

A map of id to icon. An icon is either an image or a font glyph:

```jsonc
{
  "iconDefinitions": {
    "typescript": { "iconPath": "./../icons/typescript.svg" },
    "_seti_ts": {
      "fontCharacter": "\\E001",
      "fontColor": "#519aba",
      "fontSize": "150%",
      "fontId": "seti",
    },
  },
}
```

`iconPath` is relative to the theme document, and `.` / `..` are resolved. SVG
and PNG both work. When a definition sets both, `iconPath` wins.

### `fonts`

Glyph themes (Seti and its descendants) declare their web fonts:

```jsonc
{
  "fonts": [
    {
      "id": "seti",
      "src": [{ "path": "./seti.woff", "format": "woff" }],
      "weight": "normal",
      "style": "normal",
      "size": "115%",
    },
  ],
}
```

Atlas reads the font file and hands the webview a `data:` URL, so the font
loads with no file access. `fontCharacter`'s `\E001` escape is decoded to the
actual codepoint — VS Code passes it to CSS `content:`, Atlas renders it as
text.

Fonts are fetched **only after a glyph icon has actually been resolved**, so an
SVG theme never loads one.

### Associations

| Key                                           | Matches                                            |
| --------------------------------------------- | -------------------------------------------------- |
| `file`                                        | any file with no better answer                     |
| `folder` / `folderExpanded`                   | any folder, closed / open                          |
| `rootFolder` / `rootFolderExpanded`           | the project root                                   |
| `fileNames`                                   | a whole file name, optionally parent-path-prefixed |
| `fileExtensions`                              | an extension, case-insensitively                   |
| `languageIds`                                 | the editor's language id for the file              |
| `folderNames` / `folderNamesExpanded`         | a folder name, optionally prefixed                 |
| `rootFolderNames` / `rootFolderNamesExpanded` | the root folder by name                            |

### `light` and `highContrast`

Either section may override any of the association tables above. They are
**partial**: a key the section does not set falls through to the base set. The
light section is used when the colour theme resolves to a light appearance.

High contrast falls back to the **base** set, not to `light` — the two are
siblings.

### `hidesExplorerArrows`

A theme whose folder icons already say open or closed can ask the explorer to
drop its twisty chevrons. Atlas honours it for file-tree rows; the indent
spacer stays, so names still line up.

## Precedence

For a file, in order, first hit wins:

1. `fileNames`
2. `fileExtensions`
3. `languageIds`
4. `file`

For a folder: `folderNamesExpanded` (when open) → `folderNames` →
`folderExpanded` / `folder`. For the root: the `rootFolder*` family first,
falling back to the folder family.

Two rules cut across all of it:

- **A parent-path-prefixed entry beats a bare one.** `.config/graphqlrc` wins
  over `graphqlrc`, `.github/workflows` over `workflows`. Material ships 204
  prefixed file names and 25 prefixed folder names, so this is not academic.
  Up to four path segments are considered.
- **The longest extension wins.** `types.d.ts` gets the `d.ts` icon, not the
  `ts` one. A dotfile's name is never read as an extension: `.gitignore` has a
  name, not an extension.

Appearance sections are consulted **per step**, not per resolution: at each
step the `light` (or `highContrast`) table is checked before the base one. The
alternative — running the whole chain against `light` first — would let a
`light.fileExtensions` hit beat a base `fileNames` hit, which inverts the order
above for every theme whose light section is partial. They all are.

### Language ids

`languageIds` is matched against the **editor's own** language id for the path
(`src/features/icon-theme/lib/language-id.ts`). There is deliberately no second
language table: a file the editor calls `rust` is the file an icon theme's
`"rust"` entry matches. A path the editor cannot identify sends no language id
at all rather than sending `plaintext`.

## How it loads (and why it is lazy)

Material is a 444 KB document naming 1,251 SVGs, about 1 MB of icons. None of
that reaches the webview at startup. The IPC surface is split so that only what
is on screen is ever transferred:

| Command                 | Answers                                          |
| ----------------------- | ------------------------------------------------ |
| `list_icon_themes`      | the picker's rows                                |
| `resolve_icons`         | one definition id per path, for a batch of paths |
| `get_icon_theme_assets` | SVG/PNG bytes, for a batch of definition ids     |
| `get_icon_theme_fonts`  | a glyph theme's fonts, inlined                   |
| `search_icon_themes`    | Open VSX search                                  |
| `install_icon_theme`    | download + unpack                                |
| `remove_icon_theme`     | delete an installed theme                        |

A row does not fetch; it registers a want, and one flush per render turns a
whole screen of rows into a single `resolve_icons`. Assets are cached by
definition id, not by path, so a project of a thousand TypeScript files
transfers the TypeScript icon once. Glyph icons carry their character and
colour inline in the resolve, because a round trip would cost more than the
data.

Installing or removing a theme emits `atlas:icon-themes-changed`; the frontend
drops its caches and every visible icon re-resolves without a reload. Switching
themes does the same.

## Colour

Where a theme sets colour, the theme wins: a glyph's `fontColor` is used as
written, and an SVG's own `fill` values are drawn as authored (all 1,251
Material icons paint this way).

Where a theme leaves colour to Atlas, Atlas's colour theme supplies it. SVGs
are **inlined** rather than pointed at by an `<img>` precisely so that an icon
drawn in `currentColor` inherits the row's colour and follows the active theme.
The lucide fallbacks are Atlas's own icons and always follow the theme.

Inlining third-party markup means every icon is sanitised first: a drawing-only
element allowlist, no `on*` handlers, no external references, and no `<style>`
(CSS inside an inline SVG is document-scoped and would escape the icon). An
icon that does not survive the pass is not cached, so the row keeps its lucide
fallback rather than rendering an empty box.

## Where icons appear

The file tree, the editor tab strip (for tabs opened from a path), and the
file-search palette (`⌘P`). Rows that do not stand for a real path — a
knowledge page, a chat — keep their own icons.

## What Atlas does not support

Known and deliberate. None of these stop a theme from loading; the affected
icon falls back.

- **`<style>` elements and external references inside an icon.** Removed by the
  sanitiser, for the reasons above.
- **`foreignObject` and embedded raster `<image>` elements** inside an SVG icon.
  Not on the drawing allowlist.
- **Product icon themes** (`contributes.productIconThemes`). Atlas reads file
  icon themes only; an extension that contributes just a product icon theme is
  filtered out of search and refused at install.
- **More than one icon theme per extension.** The first
  `contributes.iconThemes` entry is the one used.
- **`showLanguageModeIcons`.** Parsed and ignored — it controls a VS Code
  status-bar affordance Atlas does not have.
- **Theme-supplied localisation** (`package.nls.*.json`). A theme's display
  name is read from the manifest as published, untranslated.
- **Hot reload of an installed theme's files.** Colour themes watch
  `~/.config/atlas/themes/`; icon themes do not watch their directory. Install
  and remove refresh the catalog; editing a theme's files in place needs a
  restart.
- **Nothing outside the icon theme is taken from the `.vsix`** — the compiled
  extension host, its commands and its settings are dropped on unpack. Atlas
  does not run extensions.
