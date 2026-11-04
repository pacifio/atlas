# Theme keys

Schema-1 themes have optional shadcn **base tokens**, optional eight-colour
**palette** entries, and optional Atlas **theme keys**. Nothing is required
(ADR-0022): `background`, `foreground` and `primary` are the seeds, and every
base token a theme leaves out is derived from them (the first table below). A
theme key always resolves in this order: explicit `keys` value, palette
source, base-token source, then the Atlas default for the active appearance.

Every key, its description, its sources and its transform are declared once, in
**`keys.toml`**, which belongs to `@tryatlas/design` (ADR-0027). The package
generates the TS registry the resolver reads and the key list and rule table
Rust reads; `bun run theme:keys` copies those, `keys.toml` and the built-in
themes into `crates/atlas-theme/`, and generates the `keys` property of the JSON
Schema and the key table below from the copy. `bun run test` fails if any of
them is stale. Editing a key means editing the package's `keys.toml`; its
`resolve-theme.ts` is the only place the derivation order itself lives.

**A key exists only where an author needs that surface to differ from the base
tokens.** Everything else Atlas derives and does not ask about: a status badge's
tinted fill is its status foreground at 12%, a focused control's border is the
strong border, booleans are constants. The 2026-09-18 audit cut the set on
exactly that test — a little over half the keys came off — and what went did not
disappear, it became a **derived variable** (table at the bottom) or a plain
base token. Removing a key is a soft break: an unknown key still loads,
with a warning, so a theme written for a newer Atlas keeps working on an older
one and the other way round.

An explicit key is written as a dotted TOML key (or as nested tables). A key
may not also be a prefix, so use `terminal.ansi.red`, never both `terminal`
and `terminal.ansi.red`. The schema enumerates the dotted form, which is what
an editor completes and typo-checks; the nested form still loads. A key's
value is a colour, either bare (`syntax.keyword = "#c678dd"`) or as a
one-field table (`syntax.keyword = { color = "#c678dd" }`).

A theme key carries no font style. `font_style` was accepted by the schema
and read by nothing, so `font_style = "italic"` loaded cleanly and rendered
upright; the loader now rejects it by name. Nothing between a resolved key
and CodeMirror, highlight.js or the markdown renderer can carry one, and a
field that only sometimes works is worse than one that does not exist.

## Consuming a key

Most code never touches this file: the applier writes every resolved key to
`:root` as `--<key with dots and underscores as dashes>`, so a Tailwind
utility or a `var()` follows the theme with no work and recolours on a switch
with no re-render. Prefer that.

Five subsystems cannot, because they take a colour as a JavaScript VALUE rather
than as a style — xterm's `ITheme`, pixi's `Graphics.fill({ color })`, every
recharts colour prop, mermaid's `themeVariables`, and a canvas 2D `fillStyle`
(the diff minimap). They read `src/features/theme/theme-values.ts`:

| | |
|---|---|
| `themeColor(key)` | the resolved colour for a theme key |
| `themeDerived(name)` | the resolved colour for a derived variable |
| `themeBase(token)` | the resolved colour for a base token (`chart-1`, `card`, …) |
| `themeHex(key)` / `hexOf(value)` | the same as pixi's 24-bit integer |
| `onThemeApplied(fn)` | imperative repaint hook — a live xterm, a running pixi scene |
| `useThemeVersion()` | React re-render hook — recharts, mermaid |

Reading the right value once is only half of it. A subsystem that caches a
colour at construction time is still theme-blind; it just fails one switch
later. Every non-CSS consumer subscribes to one of the last two.

## The transform vocabulary

Three transforms exist, and the generated table below names one per key.
`alpha n` replaces the alpha channel. `mix n → B:background` and
`mix n → B:foreground` are a mirrored pair, and which one a key uses is a
statement about appearance: mixing toward the BACKGROUND pushes a colour away
from the reader in either appearance, mixing toward the FOREGROUND pulls it
closer.

There is no "lighten" — it was the dark-appearance reading of "a stronger
version of this", and applied unchanged to Rosé Pine Dawn it made a hovered
primary button PALER than its rest state and resolved `terminal.ansi.black` to
something lighter than the terminal background it sits just above. One key
still uses it, `terminal.ansi.bright_white`, where "paler" is the literal
intent whatever the background.

Adding a fourth means editing `crates/atlas-theme/keys.toml`'s vocabulary
comment, the `OPERATIONS` table in `scripts/generate-theme-keys.mjs`, and the
registry preamble it emits — the transform itself is one line of `color.ts`.

<!-- generated:theme-keys -->
<!-- Generated from crates/atlas-theme/keys.toml by `bun run theme:keys`. Edit that file, not this block. -->

## How a missing base token is derived

Every base token is optional. One a theme leaves out comes from its rule:
`P:x` is `palette.x`, `B:x` is another base token, and `D` is the Atlas
default (dark / light). `background`, `foreground` and `primary` are the
seeds; a theme that sets only those still sets every token.

| Token | Source | Transform | D (dark / light) | What it is |
|---|---|---|---|---|
| `background` | D | — | `#000000` / `#ffffff` | The app's ground. A seed. |
| `foreground` | B:background | readable: B:foreground or B:background | — | Body text. A seed; left out, the ink that reads on the background. |
| `card` | B:background | mix 0.05 → B:foreground | — | Raised surfaces: cards, composer, tiles. |
| `card-foreground` | B:foreground | — | — | Text on a card. |
| `popover` | B:background | mix 0.12 → B:foreground | — | Menus, popovers, tooltips. |
| `popover-foreground` | B:foreground | — | — | Text in a popover. |
| `primary` | B:foreground | — | — | Brand colour for buttons, focus and selection. A seed; monochrome if unset. |
| `primary-foreground` | B:primary | readable: B:foreground or B:background | — | Text on a primary fill. |
| `secondary` | B:background | mix 0.05 → B:foreground | — | Secondary button fill. |
| `secondary-foreground` | B:foreground | mix 0.28 → B:background | — | Secondary text and secondary button labels. |
| `muted` | B:background | mix 0.05 → B:foreground | — | Quiet fills: wells, inactive tracks. |
| `muted-foreground` | B:foreground | mix 0.32 → B:background | — | Hints, captions, placeholders. |
| `accent` | B:muted | — | — | Hover and selected rows (shadcn's meaning, not the brand colour). |
| `accent-foreground` | B:foreground | — | — | Text on an accent row. |
| `destructive` | P:red → D | — | `#f44747` / `#c62828` | Destructive actions and errors. |
| `destructive-foreground` | B:destructive | readable: B:foreground or B:background | — | Text on a destructive fill. |
| `border` | B:background | mix 0.16 → B:foreground | — | Separators and outlines. |
| `input` | B:border | — | — | Input outlines. |
| `ring` | B:primary | — | — | Focus rings. |
| `chart-1` | B:primary | — | — | The first chart series: the theme's ink. |
| `chart-2` | P:green → D | — | `#9ecf8a` / `#3f7f2f` | Chart series 2. |
| `chart-3` | P:yellow → D | — | `#e0b070` / `#b06000` | Chart series 3. |
| `chart-4` | P:purple → D | — | `#c9a2f5` / `#7b3fb5` | Chart series 4. |
| `chart-5` | P:cyan → D | — | `#7fd1e8` / `#1f7f99` | Chart series 5. |
| `sidebar` | B:background | — | — | The sidebars' ground. |
| `sidebar-foreground` | B:foreground | — | — | Sidebar text. |
| `sidebar-primary` | B:primary | — | — | Primary fills in a sidebar. |
| `sidebar-primary-foreground` | B:primary-foreground | — | — | Text on a sidebar primary fill. |
| `sidebar-accent` | B:accent | — | — | Hover and selected rows in a sidebar. |
| `sidebar-accent-foreground` | B:accent-foreground | — | — | Text on a sidebar accent row. |
| `sidebar-border` | B:background | mix 0.08 → B:foreground | — | Sidebar separators, quieter than `border`. |
| `sidebar-ring` | B:ring | — | — | Focus rings in a sidebar. |
| `radius` | D | — | `8px` | Corner radius. |
| `tracking-normal` | D | — | `0em` | Letter spacing. |
| `spacing` | D | — | `0.25rem` | The spacing unit. |
| `shadow-2xs` | D | — | `0 1px 2px rgba(0, 0, 0, 0.35)` / `0 1px 2px rgba(0, 0, 0, 0.04)` | Shadow ramp. |
| `shadow-xs` | D | — | `0 1px 2px rgba(0, 0, 0, 0.45)` / `0 1px 2px rgba(0, 0, 0, 0.06)` | Shadow ramp. |
| `shadow-sm` | D | — | `0 1px 3px rgba(0, 0, 0, 0.55)` / `0 1px 3px rgba(0, 0, 0, 0.08)` | Shadow ramp. |
| `shadow-md` | D | — | `0 4px 12px rgba(0, 0, 0, 0.65)` / `0 4px 12px rgba(0, 0, 0, 0.11)` | Shadow ramp. |
| `shadow-lg` | D | — | `0 8px 24px rgba(0, 0, 0, 0.75)` / `0 8px 24px rgba(0, 0, 0, 0.14)` | Shadow ramp. |
| `shadow-xl` | D | — | `0 12px 36px rgba(0, 0, 0, 0.82)` / `0 12px 36px rgba(0, 0, 0, 0.18)` | Shadow ramp. |
| `shadow-2xl` | D | — | `0 16px 48px rgba(0, 0, 0, 0.9)` / `0 16px 48px rgba(0, 0, 0, 0.22)` | Shadow ramp. |

## Full key list and derivation sources

All **73** keys, in the order and grouping of `crates/atlas-theme/keys.toml`.
**Source** is the first thing Atlas tries after an explicit `keys` value:
`P:x` is `palette.x`, `B:x` is `base.x`, and `D` is the Atlas default for the
active appearance, shown here as dark / light. **Transform** is applied to
whichever of those three supplied the colour, and never to an explicit value.

### Borders

Separators and control outlines.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `border.subtle` | B:sidebar-border → D | — | `#141414` / `#ebe5de` | Low-emphasis separator. |
| `border.strong` | B:border → D | — | `#3d3d3d` / `#b8b1aa` | High-emphasis border, including a focused control's. |

### Elements and overlays

Hover/selected/pressed overlays, the raised edge, and the brand fills.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `element.hover` | B:foreground → D | alpha 0.04 | `rgba(255,255,255,0.04)` / `rgba(0,0,0,0.04)` | Hover overlay for ordinary elements. |
| `element.selected` | B:foreground → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(0,0,0,0.06)` | Selected overlay for ordinary elements. |
| `element.active` | B:foreground → D | alpha 0.08 | `rgba(255,255,255,0.08)` / `rgba(0,0,0,0.08)` | Pressed overlay for ordinary elements. |
| `element.highlight` | B:foreground → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(0,0,0,0.06)` | Top-edge highlight on a raised surface. |
| `primary.hover` | B:primary → D | mix 0.15 → B:foreground | `#cccccc` / `#8875a1` | Hovered primary-brand fill. |
| `primary.muted` | B:primary → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(144,122,169,0.08)` | Muted primary-brand fill. |

### Text

Prose roles that are not a base token.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `text.disabled` | B:muted-foreground → D | mix 0.2 → B:background | `#4a4a4a` / `#a39d96` | Disabled and unavailable text. |

### Status

Success / warning / error / info.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `status.success.foreground` | P:green → D | — | `#3fb950` / `#286983` | Success status foreground, and the live-capture indicator. |
| `status.warning.foreground` | P:yellow → D | — | `#cd9731` / `#ea9d34` | Warning status foreground. |
| `status.error.foreground` | P:red → B:destructive → D | — | `#f44747` / `#b4637a` | Error status foreground. |
| `status.info.foreground` | P:blue → D | — | `#6796e6` / `#56949f` | Informational status foreground. |

### Selection

Document text selection.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `selection.background` | B:primary → D | alpha 0.18 | `rgba(255,255,255,0.18)` / `rgba(144,122,169,0.18)` | Document text selection. |

### Terminal

The PTY surface and the 16 ANSI colours.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `terminal.foreground` | B:foreground → D | — | `#d4d4d4` / `#575279` | Terminal default foreground. |
| `terminal.background` | B:background → D | — | `#000000` / `#faf4ed` | Terminal background. |
| `terminal.cursor` | B:foreground → D | — | `#d4d4d4` / `#575279` | Terminal cursor. |
| `terminal.ansi.black` | B:background → D | mix 0.12 → B:foreground | `#1e1e1e` / `#575279` | ANSI black. |
| `terminal.ansi.red` | P:red → D | — | `#f44747` / `#b4637a` | ANSI red. |
| `terminal.ansi.green` | P:green → D | — | `#98c379` / `#286983` | ANSI green. |
| `terminal.ansi.yellow` | P:yellow → D | — | `#e5c07b` / `#ea9d34` | ANSI yellow. |
| `terminal.ansi.blue` | P:blue → D | — | `#61afef` / `#56949f` | ANSI blue. |
| `terminal.ansi.magenta` | P:purple → D | — | `#c678dd` / `#907aa9` | ANSI magenta. |
| `terminal.ansi.cyan` | P:cyan → D | — | `#56b6c2` / `#56949f` | ANSI cyan. |
| `terminal.ansi.white` | B:foreground → D | — | `#d4d4d4` / `#575279` | ANSI white. |
| `terminal.ansi.bright_black` | B:muted-foreground → D | — | `#666666` / `#9893a5` | ANSI bright black. |
| `terminal.ansi.bright_red` | P:red → D | mix 0.15 → B:foreground | `#ff6b6b` / `#c97991` | ANSI bright red. |
| `terminal.ansi.bright_green` | P:green → D | mix 0.15 → B:foreground | `#b2d89a` / `#4d8399` | ANSI bright green. |
| `terminal.ansi.bright_yellow` | P:yellow → D | mix 0.15 → B:foreground | `#f2d28c` / `#edae52` | ANSI bright yellow. |
| `terminal.ansi.bright_blue` | P:blue → D | mix 0.15 → B:foreground | `#82c0f3` / `#73a5ae` | ANSI bright blue. |
| `terminal.ansi.bright_magenta` | P:purple → D | mix 0.15 → B:foreground | `#d493e5` / `#a290b5` | ANSI bright magenta. |
| `terminal.ansi.bright_cyan` | P:cyan → D | mix 0.15 → B:foreground | `#78c7d0` / `#73a5ae` | ANSI bright cyan. |
| `terminal.ansi.bright_white` | B:foreground → D | lighten 0.18 | `#ffffff` / `#464261` | ANSI bright white. |

### Syntax

CodeMirror and Markdown highlighting.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `syntax.comment` | B:muted-foreground → D | — | `#737373` | Comments and prose quotes. |
| `syntax.keyword` | P:purple → D | — | `#ff678d` / `#d32a61` | Keywords and control flow. |
| `syntax.string` | P:green → D | — | `#5ecc71` / `#199f43` | Strings. |
| `syntax.number` | P:orange → D | — | `#68cdf2` / `#1ca1c7` | Numbers. |
| `syntax.type` | P:cyan → D | — | `#d568ea` / `#a631be` | Types, classes, and namespaces. |
| `syntax.function` | P:blue → B:primary → D | — | `#9d6afb` / `#693acf` | Functions and headings. |
| `syntax.variable` | B:foreground → D | — | `#a3a3a3` / `#636363` | Variables. |
| `syntax.operator` | P:cyan → D | — | `#636363` | Operators. |
| `syntax.tag` | P:red → D | — | `#ff855e` / `#d5512f` | Markup tags. |
| `syntax.attribute` | P:yellow → D | — | `#60d199` / `#18a46c` | Markup attributes. |
| `syntax.constant` | P:orange → D | — | `#08c0ef` | Constants and atoms. |
| `syntax.regexp` | P:red → D | — | `#64d1db` / `#17a5af` | Regular expressions. |
| `syntax.escape` | P:pink → D | — | `#61d5c0` / `#16a994` | Escape sequences. |
| `syntax.definition` | B:foreground → D | — | `#9d6afb` / `#693acf` | Definitions and strong prose. |
| `syntax.property` | P:cyan → D | — | `#ffa359` / `#d47628` | Properties and object keys. |

### Editor

The code editor's own chrome.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `editor.background` | B:background → D | — | `#000000` / `#faf4ed` | Code editor background. |
| `editor.foreground` | B:foreground → D | — | `#d4d4d4` / `#575279` | Code editor foreground. |
| `editor.caret` | B:foreground → D | — | `#d4d4d4` / `#575279` | Code editor caret. |
| `editor.gutter.background` | B:background → D | — | `#000000` / `#faf4ed` | Code editor gutter background. |
| `editor.gutter.foreground` | B:muted-foreground → D | — | `#666666` / `#9893a5` | Code editor line numbers. |
| `editor.active_line.background` | B:foreground → D | alpha 0.04 | `rgba(255,255,255,0.04)` / `rgba(0,0,0,0.04)` | Active editor line. |
| `editor.active_line.gutter_foreground` | B:foreground → D | — | `#d4d4d4` / `#575279` | Active line number. |
| `editor.selection.background` | B:primary → D | alpha 0.24 | `#303030` / `#dfdad9` | Editor selection. |
| `editor.match_bracket.background` | B:accent → D | — | `#2d2d2d` / `#dfdad9` | Matching bracket background. |
| `editor.match_bracket.border` | B:ring → D | — | `#3d3d3d` / `#907aa9` | Matching bracket outline. |

### Search

In-document search matches.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `search.match.background` | P:yellow → D | alpha 0.22 | `rgba(229,192,123,0.22)` / `rgba(234,157,52,0.22)` | A search match in the document. |
| `search.match.active_background` | P:yellow → D | alpha 0.5 | `rgba(229,192,123,0.5)` / `rgba(234,157,52,0.5)` | The match the cursor is on. |

### Chrome surfaces

Scrollbars and panel surfaces — the app frame.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `scrollbar.thumb.background` | B:foreground → D | alpha 0.16 | `rgba(255,255,255,0.16)` / `rgba(0,0,0,0.16)` | Scrollbar thumb. |
| `scrollbar.thumb.hover` | B:foreground → D | alpha 0.26 | `rgba(255,255,255,0.26)` / `rgba(0,0,0,0.26)` | Hovered scrollbar thumb. |
| `panel.background` | B:sidebar → D | — | `#060706` / `#fffaf3` | Panel background. |
| `panel.input.background` | B:background → D | — | `#0a0a0a` / `#fffaf3` | Panel input background. |

### Diff

Added and removed regions, inline and side-by-side.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `diff.added.background` | P:green → D | alpha 0.13 | `#0d2211` / `rgba(40,105,131,0.13)` | Added line or hunk. |
| `diff.added.emphasis` | P:green → D | alpha 0.34 | `rgba(52,211,153,0.34)` / `rgba(40,105,131,0.34)` | Changed words inside an added line. |
| `diff.added.text` | P:green → D | — | `#3fb950` / `#286983` | Added diff text, and the +N line statistic. |
| `diff.removed.background` | P:red → D | alpha 0.13 | `#220d0d` / `rgba(180,99,122,0.13)` | Removed line or hunk. |
| `diff.removed.emphasis` | P:red → D | alpha 0.34 | `rgba(244,63,63,0.34)` / `rgba(180,99,122,0.34)` | Changed words inside a removed line. |
| `diff.removed.text` | P:red → D | — | `#f85149` / `#b4637a` | Removed diff text, and the -N line statistic. |
| `diff.context.background` | B:background → D | — | `#0a0a0a` / `#faf4ed` | Unchanged diff context. |

### Agents and indicators

The agent identity chip.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `agent.chip.foreground` | B:foreground → D | — | `#ffffff` / `#575279` | Agent identity chip text. |
| `agent.chip.background` | B:foreground → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(0,0,0,0.06)` | Agent identity chip fill. |

## Derived variables

Atlas writes these **6** custom properties too, but
they are **not** theme keys: each is a pure transform of a key that is, so a
theme steers it through that key. Writing one in a theme file is an
unknown-key warning.

| Variable | Derived from | Transform | What it colours |
|---|---|---|---|
| `status.success.background` | `status.success.foreground` | alpha 0.12 | Tinted fill behind a success foreground. |
| `status.warning.background` | `status.warning.foreground` | alpha 0.12 | Tinted fill behind a warning foreground. |
| `status.error.background` | `status.error.foreground` | alpha 0.12 | Tinted fill behind an error foreground. |
| `status.info.background` | `status.info.foreground` | alpha 0.12 | Tinted fill behind an informational foreground. |
| `element.emphasis` | `base.foreground` | alpha 0.16 | The strongest neutral overlay — a chat mention addressed to you. |
| `terminal.selection` | `base.primary` | alpha 0.3 | Terminal selection. |

<!-- /generated:theme-keys -->

## Legacy CSS-variable map

**These names no longer exist.** They were aliases in `tokens.css` through the
sweep, which rewrote all 2,594 `var(--alias)` call sites and deleted them — a
name in the left column will resolve to nothing. The exceptions are
`--border-subtle`, `--border-strong`, `--diff-added-text` and
`--diff-removed-text`: since theme keys dropped the `--atlas-` prefix
(ADR-0027) they are those keys' own variables again, with the meaning given
below. The table is kept because a
theme written against an older Atlas, a stale branch, or a snippet in an issue
will still be full of them, and this is the translation.

The table is exhaustive for the former `tokens.css` colour variables; names
within a cell each map to the single token or key in the next cell.

| Former variable(s) | Source now |
|---|---|
| `--bg-base`, `--bg-surface`, `--bg-primary` | base `background` |
| `--bg-sidebar` | base `sidebar` |
| `--bg-raised`, `--bg-secondary`, `--bg-elevated` | base `card` |
| `--bg-overlay`, `--bg-tertiary` | base `popover` |
| `--bg-input`, `--bg-canvas`, `--bg-rail`, `--panel-rail-bg`, `--panel-bg` | `panel.input.background`, `panel.background` |
| `--bg-elevated-2`, `--panel-bg-2` | base `card` |
| `--bg-tab-active`, `--bg-tab-inactive` | base `accent`, base `sidebar` |
| `--bg-hover`, `--bg-selected`, `--bg-active`, `--selection-bg` | `element.hover`, `element.selected`, `element.active`, `selection.background` |
| `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-inverse` | base `foreground`, `secondary-foreground`, `muted-foreground`, `primary-foreground` |
| `--text-ghost`, `--text-muted` | `text.disabled`, base `muted-foreground` |
| `--border-default`, `--border-focus`, `--border-variant` | **gone** — use `var(--border)`, `border.strong`, `border.subtle` |
| `--border-subtle`, `--border-strong` | corresponding `border.*` key |
| `--accent-primary`, `--accent-primary-hover`, `--accent-primary-muted`, `--accent-secondary` | base `primary`, `primary.hover`, `primary.muted`, base `muted-foreground` |
| `--status-success`, `--status-warning`, `--status-error`, `--status-info` | corresponding `status.*.foreground` key |
| `--status-*-muted`, `--status-success-bg` | corresponding `status.*.background` **derived variable** |
| `--status-purple`, `--status-orange`, `--text-accent`, `--atlas-ants-color` | **gone** — no consumer; the marching-ants colour is set per call site |
| `--danger`, `--warning` | base `destructive`, `status.warning.foreground` |
| `--stat-added`, `--stat-removed`, `--capture-live` | `diff.added.text`, `diff.removed.text`, `status.success.foreground` |
| `--diff-add-line-bg`, `--diff-add-side-bg` | `diff.added.background` (one fill for both renderers) |
| `--diff-remove-line-bg`, `--diff-remove-side-bg` | `diff.removed.background` |
| `--diff-emph-add-bg`, `--diff-emph-remove-bg` | `diff.added.emphasis`, `diff.removed.emphasis` |
| `--diff-added-text`, `--diff-removed-text`, `--diff-context-bg` | corresponding `diff.*` key |
| `--diff-added-bg`, `--diff-removed-bg`, `--diff-modified-bg` | **gone** — no consumer |
| `--cm-bg`, `--cm-fg`, `--cm-caret`, `--cm-gutter-*`, `--cm-active-*`, `--cm-selection-*`, `--cm-bracket-*` | corresponding `editor.*` key |
| `--cm-fold-bg`, `--cm-fold-border`, `--cm-fold-fg` | base `secondary`, `border`, `secondary-foreground` |
| `--cm-comment`, `--cm-keyword`, `--cm-string`, `--cm-number`, `--cm-type`, `--cm-func`, `--cm-variable`, `--cm-tag`, `--cm-attr`, `--cm-constant`, `--cm-regexp`, `--cm-property` | corresponding `syntax.*` key |
| `--cm-meta` | `syntax.attribute` — CodeMirror already coloured `tags.meta` with it |
| `--comms-outer`, `--comms-surface` | base `sidebar`, base `background` |
| `--comms-unread`, `--comms-unread-deep` | `status.success.foreground` |
| `--comms-mention-text`, `--comms-mention-bg` | base `foreground`, the `element.emphasis` derived variable |
| `--comms-mention-other-bg`, `--comms-mention-other-text` | **gone** — no consumer |
| `--agent-*-chip`, `--agent-*-chip-bg` | **gone** — the chip is `agent.chip.foreground` / `agent.chip.background`, and the vendors' brand hues are constants in `features/agents/lib/agent-brand.ts` |

`--font-size-*` and `--space-*` are gone too, and radius, shadow, z-index and
motion are not theme keys: those scales live in the Tailwind namespaces, and
[`design-system.md`](./design-system.md) is their reference. A theme does set
`radius`, the three fonts, `tracking-normal` and the seven `shadow-*` ramps —
they are base tokens, listed with the rest of the shadcn set above.

Two more former aliases that were not colours: `--shadow-overlay` is
`shadow-md`, and `--z-max` is whichever named layer the site belongs to
(`z-popover` for a menu, `z-drag` for the hint overlay).

## Regenerating checked assets

After editing `crates/atlas-theme/keys.toml` — adding, removing, renaming a key,
or changing what one derives from:

```bash
bun run theme:keys          # rewrites all four generated files
bun run theme:keys:check    # what `bun run test` runs; fails on anything stale
```

`theme:keys` shells out to the schema example below, so it needs cargo;
`theme:keys:check` does not.

The JSON Schema and browser mock snapshot are also checked by `atlas-theme`
tests. After intentionally changing their Rust shape, regenerate them with:

```bash
cargo run -p atlas-theme --example generate_schema > crates/atlas-theme/schema/theme-v1.json
cargo run -p atlas-theme --example generate_builtins > src/dev/mock-backend/fixtures/builtin-themes.json
```
