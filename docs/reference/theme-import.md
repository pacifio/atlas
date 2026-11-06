# Theme import

Converting a shadcn, Zed or VS Code theme into an Atlas theme file. The
conversion lives in `crates/atlas-theme/src/import/`; this page is the contract
it implements — what each format can carry, what Atlas invents, and what it
leaves behind. Colour roles are in [`theme-keys.md`](./theme-keys.md).

An import is a **one-time conversion** (decision 15). The output is an ordinary
schema-1 TOML in `~/.config/atlas/themes/<id>.toml` that the user then owns and
edits; nothing keeps a link back to the source and nothing re-reads it.

## The three formats

| format           | fidelity          | why                                                                                       |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| shadcn / tweakcn | **native**        | Atlas's base tokens _are_ shadcn's names (decision 9), so the chrome crosses verbatim     |
| Zed              | **near-lossless** | Zed's colour roles map onto Atlas's theme keys almost one-to-one; only the shadcn layer has to be invented |
| VS Code          | **lossy**         | a workbench theme and an app theme are different things                                   |

Every import returns a report — keys **mapped** (the source said this), **derived**
(Atlas worked it out, and from what) and **ignored** (nowhere to put it, grouped
by category). The panel in Settings → Appearance → Import shows all three before
anything is written.

## Shared machinery

Two steps run after every importer's own mapping, in this order.

**Palette guessing.** The optional eight-colour palette is what **36** theme
keys resolve through — the four status foregrounds, 12 of the 16 ANSI slots, 12
of the 15 syntax roles, both search matches and both diff families — plus the
four derived status fills on top of those. An import that skipped it would
produce a theme whose editor is the author's and whose chrome is Atlas's. Each
colour is taken from the first of:

| palette  | source, in order                                                                     |
| -------- | ------------------------------------------------------------------------------------ |
| `red`    | `terminal.ansi.red` → `syntax.tag` → `status.error.foreground` → base `destructive`  |
| `green`  | `terminal.ansi.green` → `syntax.string` → `status.success.foreground`                |
| `yellow` | `terminal.ansi.yellow` → `syntax.attribute` → `status.warning.foreground`            |
| `blue`   | `terminal.ansi.blue` → `syntax.function` → `status.info.foreground` → base `primary` |
| `cyan`   | `terminal.ansi.cyan` → `syntax.type`                                                 |
| `purple` | `terminal.ansi.magenta` → `syntax.keyword`                                           |
| `orange` | `syntax.number` → `terminal.ansi.bright_red`                                         |
| `pink`   | `syntax.escape` → `terminal.ansi.bright_magenta` → `syntax.regexp`                   |

**Base tokens the source lacks.** No base token is required (ADR-0022), but an
import fills every one the source did not supply and **pins** it in the file, so
the theme you previewed is the theme you keep even if a rule changes later.
The filling is not importer-specific: it is the same `[[base]]` rules in
`crates/atlas-theme/keys.toml` that any theme leaving a token out resolves
through — `card` and `border` mixed from `background` toward `foreground` in
OKLab, `input` ← `border`, `ring` ← `primary`, the chart ramp from the palette,
and `primary-foreground` / `destructive-foreground` as whichever of the theme's
own foreground and background reads better on the fill. The report names the
rule each value came from. The table is in
[theme keys](theme-keys.md#how-a-missing-base-token-is-derived).

Light variants get a **light shadow ramp**, not the dark one.

## shadcn / tweakcn

Two source shapes, one mapping:

- a **registry item** — `{type: "registry:style", cssVars: {theme, light, dark}}`,
  which is what tweakcn exports and what a URL on a shadcn site serves;
- a pasted **`globals.css`** — `:root { --background: … }` plus `.dark { … }`,
  including `@theme inline` and `@layer base { :root { … } }`.

**Maps.** Every shadcn token name straight onto the Atlas base token of the same
name, per variant, with `cssVars.theme` / `@theme` behind both. Colour values
keep the author's notation: an oklch theme stays oklch. tweakcn's extras land
where Atlas has a home — `font-sans` / `font-serif` / `font-mono`, `radius`,
`tracking-normal` (also read from tweakcn's `--letter-spacing`) and the composed
`shadow-2xs`…`shadow-2xl` ramp. The font stacks are the one optional set of base
tokens; a stack both variants share is written once, in the theme's top-level
`[base]` table (shadcn's `cssVars.theme`), and a user's font setting outranks it.

**Derives.** Nothing beyond the shared machinery, plus `destructive-foreground`,
which current shadcn registries no longer emit.

**Drops.** `--shadow-color` / `-opacity` / `-blur` / `-spread` / `-offset-x` /
`-offset-y` (Atlas takes the composed ramp, not its ingredients), a registry
item's raw `css` block, and any CSS rule that is not `:root`, `.dark` or
`@theme`. `--color-x: var(--x)` entries in `@theme inline` are re-exports, not
values, and are skipped silently.

**Kept but ignored.** `spacing` (decision 20). Spacing and the type scale are
app-owned, so the value stays in the file — dropping it would lose the author's
intent on a round trip — and the report warns that nothing honours it.

**Not carried, by construction.** shadcn describes application chrome and stops
there: no editor, no terminal, no syntax, no diff. _Every_ Atlas theme key —
the set `crates/atlas-theme/keys.toml` declares and
[`theme-keys.md`](./theme-keys.md) tabulates — resolves from the base tokens or
from Atlas's defaults.

**Appearance.** `cssVars.light` / `cssVars.dark` are trusted. In pasted CSS,
`:root` is the light variant _when a `.dark` block exists to be the other half_;
a dark-only paste is judged by its `background` lightness and filed as dark,
which the report says.

## Zed

A family (`{name, author, themes: [{name, appearance, style}]}`) becomes **one
Atlas theme per member**, each with the single variant its `appearance` names —
"Rosé Pine", "Moon" and "Dawn" are siblings, not variants of one design, which
is also how the built-ins already treat that family.

**Maps.** 44 style keys onto Atlas theme keys — 67 of the 73 in all, once the
syntax and player maps are counted. Zed's border roles collapse onto Atlas's
two: Zed's `border.variant` and `border.disabled` become `border.subtle`,
`border.selected` becomes `border.strong`, and Zed's bare `border` and
`border.focused` are not theme keys at all — they carry into the shadcn
`border`/`input` and `ring` base tokens. All 16 `terminal.ansi.*` colours
transfer exactly. `players[0].cursor` becomes `editor.caret` and
`terminal.cursor`; `players[0].selection` becomes `selection.background` and
`editor.selection.background` — two keys, not three, because `terminal.selection`
is derived from `primary` and no theme may set it. The `syntax` map collapses
onto Atlas's 15 roles. `font_style` does **not** cross: an Atlas theme
key is a colour, and the loader rejects a `font_style` by name rather than
accept one nothing reads, so an italic scope imports upright and the drop is
listed under "font styles".

**Derives.** The base tokens, since Zed has no shadcn layer. Every source
below is a ZED style key, not an Atlas one. The judgements worth knowing:
`primary` ← Zed's `text.accent`, `accent` ← Zed's `element.hover` (shadcn's
`accent` is a hover _surface_, which is the audit's "accent collision"), `card`
and `popover` ← `elevated_surface.background`, `sidebar` and `secondary` ←
`surface.background`, `destructive` ← `error`, `ring` ← Zed's `border.focused`,
the chart ramp ← the ANSI blue/green/yellow/magenta/red.

**Drops**, by category: icon roles (Atlas icons follow the text roles), the
`players[1..]` collaboration colours, editor furniture Atlas does not draw (wrap
guides, invisibles, subheaders, the read/write highlight pair), app chrome that
follows the panel tokens (status bar, title bar, toolbar, tab bar, pane borders,
drop targets), the VCS states Atlas has no colour for (`conflict`, `renamed`,
`ignored`, `hidden`, `unreachable`), `hint` and `predictive`, Zed's dim ANSI
ramp, and whichever `syntax` scopes are finer than Atlas's 15 roles.

## VS Code

`include` is resolved relative to the file on disk (up to 8 hops, cycle-checked);
the included file is the base and the including file overrides it, with
`tokenColors` concatenated so the includer's rules come last. A _pasted_ theme
cannot resolve an include, and the report says which file was missed. The
JSON-with-comments dialect VS Code themes are actually written in is read.

Appearance comes from `type`; with no `type`, from `editor.background`'s
lightness.

### From Open VSX

**Settings → Appearance → Import theme → Open VSX** searches open-vsx.org for
extensions that carry a colour theme. As with icon themes, a hit is kept only if
its real `package.json` declares `contributes.themes`, which is checked before
it is listed. Converting one downloads the `.vsix` (32 MB cap, 60-second
timeout), unpacks it into a temporary directory that is deleted when the
preview returns, and imports every theme `contributes.themes` names, each under
its label, with the publisher and licence Open VSX lists for it. One extension
is often a family: GitHub's yields ten candidates, Catppuccin's four.

The themes are read off disk, so `include` resolves as it does for a chosen
file, except that it may not leave the extension (`ImportOptions::include_root`).
A contributed `.tmTheme` (a TextMate theme, with no workbench colours) is
skipped, and so is a path outside the extension; the preview lists what was
skipped and why (`skipped`). Nothing is fetched except when someone asks, and
nothing is kept but what they then add.

### Workbench keys

Mapped where an Atlas equivalent exists: `editor.background` / `.foreground` /
`.lineHighlightBackground` / `.selectionBackground`,
`editorCursor.foreground`, `editorGutter.background`, `editorLineNumber.*`,
`editorBracketMatch.*`, `scrollbarSlider.background` / `.hoverBackground`,
`editor.findMatchBackground` / `.findMatchHighlightBackground`,
`editorWidget.background`, `sideBar.*`, `input.background`,
`focusBorder`, `editorGroup.border`, `list.*`, `descriptionForeground`,
`disabledForeground`, `textLink.foreground`,
`editorError/Warning/Info.foreground`, `gitDecoration.added/deletedResourceForeground`,
`diffEditor.inserted/removedText/LineBackground`, and all 16 `terminal.ansi*`
plus `terminal.background` / `.foreground` / `.selectionBackground`.

The base tokens come from `editor.background`, `foreground`,
`editorWidget.background`, `dropdown.background`, `button.background/foreground`,
`editorGroupHeader.tabsBackground`, `descriptionForeground`,
`list.hoverBackground`, `list.activeSelectionForeground`,
`editorError.foreground`, `editorGroup.border`, `input.border`, `focusBorder`
and `sideBar.*`.

Everything else is counted by category: editor furniture (minimap, rulers,
indent guides, inlay hints, code lens, ghost text, and `editor.foldBackground` —
Atlas draws the fold placeholder from the secondary surface), widgets (suggest,
hover, peek, notifications, quick input, menus, breadcrumbs, debug, testing), app
chrome (status bar, title bar, badges, panel and sidebar headers, welcome page,
settings, keybinding labels, `activityBar.*`, and `tab.*` — Atlas's tab strip
follows the accent and sidebar tokens), text roles
(`input.placeholderForeground`), VCS (merge editor, the rest of
`gitDecoration`, the SCM panel), icon roles, and terminal decorations.

### TextMate scope → syntax key

`tokenColors` is a list of rules carrying grammar _selectors_, not roles. A
selector matches a scope when it is a dotted prefix of it (`string` matches
`string.quoted.double.ts`), and VS Code resolves a token by taking the **longest
matching selector, later rules winning a tie**. A descendant selector
(`meta.tag entity.name`) is a context rule, so only its rightmost element is
considered.

This importer inverts that: for each Atlas key it holds representative scopes
and asks which rule VS Code would apply to each, first match winning.

| Atlas key           | scopes, in order                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `syntax.comment`    | `comment`, `comment.line`, `punctuation.definition.comment`                                    |
| `syntax.keyword`    | `keyword.control`, `keyword`, `storage.type`, `storage.modifier`                               |
| `syntax.operator`   | `keyword.operator`, `keyword.operator.arithmetic`                                              |
| `syntax.string`     | `string.quoted.double`, `string`                                                               |
| `syntax.escape`     | `constant.character.escape`                                                                    |
| `syntax.regexp`     | `string.regexp`                                                                                |
| `syntax.number`     | `constant.numeric`                                                                             |
| `syntax.constant`   | `constant.other`, `constant.language`, `constant`, `variable.language`, `support.constant`     |
| `syntax.type`       | `entity.name.type`, `entity.name.class`, `support.type`, `support.class`, `storage.type.class` |
| `syntax.function`   | `entity.name.function`, `support.function`, `meta.function-call`                               |
| `syntax.definition` | `entity.name.function.definition`, `entity.name`, `entity.name.namespace`                      |
| `syntax.variable`   | `variable.other.readwrite`, `variable`                                                         |
| `syntax.property`   | `variable.other.property`, `support.type.property-name`, `meta.object-literal.key`             |
| `syntax.tag`        | `entity.name.tag`                                                                              |
| `syntax.attribute`  | `entity.other.attribute-name`, `meta.preprocessor`, `keyword.control.directive`                |

The 2026-09-18 key-set cut removed `syntax.boolean`, `syntax.null`,
`syntax.builtin`, `syntax.meta` and `syntax.punctuation`. Their scopes did not
all go with them: `variable.language` and `support.constant` moved onto
`syntax.constant`, `support.class` onto `syntax.type`, and `meta.preprocessor`
and `keyword.control.directive` onto `syntax.attribute`. Dropped outright:
`constant.language.boolean`, `constant.language.null` / `.undefined`,
`entity.name.section`, `punctuation.separator` and bare `punctuation` — the only
surviving punctuation probe is `punctuation.definition.comment`.

`settings.fontStyle: italic` is dropped and reported under "font styles"; the
rule's `foreground` still lands. `markup.*` and grammar-specific scopes have no
Atlas role and are counted as dropped too.

### Semantic tokens

`semanticTokenColors` takes precedence over `tokenColors`, because a theme that
writes one is stating its intent more directly than a grammar selector can. Only
**bare token types** are read: `variable`, `parameter` → `syntax.variable`;
`property` → `syntax.property`; `function`, `method` → `syntax.function`;
`class`, `interface`, `struct`, `enum`, `type`, `typeParameter` and `namespace`
→ `syntax.type`; `macro` → `syntax.attribute`; `enumMember` →
`syntax.constant`; plus `keyword`, `comment`, `string`, `number`, `operator` and
`regexp` onto their own keys. A selector carrying modifiers
(`variable.readonly.defaultLibrary`) is a _conditional_ rule and cannot be
applied unconditionally, so it is reported rather than used.

## Export

`export_theme_shadcn` turns any Atlas theme into a `registry:style` item:
base tokens verbatim per appearance, with `radius`, the three font stacks,
`tracking-normal` and `spacing` hoisted into `cssVars.theme`. Lossy in the
mirror image of the shadcn importer — the palette and every theme key the
source set describe surfaces shadcn has no vocabulary for and are dropped, with
the counts by family in the result. To move a theme between two Atlas installs, copy the
TOML instead.

## Commands

| command                                                         | does                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_color_themes(query)`                                    | Open VSX extensions whose `package.json` declares `contributes.themes`, in Open VSX's relevance order.                                                                                                                                                                                                                               |
| `preview_theme_import({text?, url?, path?, format?, openVsx?})` | converts and reports; writes nothing. `path` and `openVsx` are the sources that can resolve a VS Code `include`. A URL is fetched once, http(s) only, 10-second timeout, 4 MB cap, never at startup. `openVsx: {namespace, name, version?}` imports every colour theme the extension carries; `skipped` lists the ones it could not. |
| `commit_theme_import(toml, id, name)`                           | re-parses, renames and re-serialises, then writes `~/.config/atlas/themes/<id>.toml`. The id is slugged, so it cannot escape the directory.                                                                                                                                                                                          |
| `export_theme_shadcn(id)`                                       | the registry item plus its drop report.                                                                                                                                                                                                                                                                                              |

No new event channel: the existing `~/.config/atlas/themes` watcher and
`atlas:themes-changed` refresh the picker.
