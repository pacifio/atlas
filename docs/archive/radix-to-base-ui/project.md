# project

2026-09-18 — whole-project Radix → Base UI migration, transformation-engine
path. Atlas is not a shadcn-CLI project: there was no `components.json` before
this run and `src/ui` held only two hand-written Radix wrappers, so there was no
golden pair to replay. The `base-nova` registry wrappers were fetched and used
as the *target shape* for the five new/rebuilt `src/ui` files; every consumer
was transformed in place against `universal-patterns.md`, `overlays.md`,
`menus.md`, `class-mapping.md`, `wrapper-shapes.md` and `consumer-props.md`,
with `node_modules/@base-ui/react/**/*.d.ts` (and the docs the package ships at
`node_modules/@base-ui/react/docs/react/components/*.md`) as the authority
wherever the tables were silent.

## Dependency swap

- **Added**: `@base-ui/react@1.8.0`. The only new dependency.
- **Removed**: `@radix-ui/react-context-menu`, `@radix-ui/react-dialog`,
  `@radix-ui/react-dropdown-menu`, `@radix-ui/react-popover`,
  `@radix-ui/react-tooltip`. `node_modules` was deleted and reinstalled from the
  new lockfile rather than updated in place, per the repo's note about stale
  nested copies; `tests/bun-singletons.test.ts` does not name any of them and
  needed no change.
- `components.json` added: `style: "base-nova"`, tailwind v4 (no config file,
  css at `src/styles/globals.css`), `ui` alias `@/ui`, lucide icons. `base-nova`
  rather than a `radix-*` style, so a future `shadcn add` delivers Base UI
  variants — its classes will still need swapping for house tokens.
- `vite.config.ts`: `optimizeDeps.include` pre-bundles the five
  `@base-ui/react/*` subpaths the app enters through, and the `vendor-radix`
  manual chunk became `vendor-base-ui` at the same priority.

## App-code sweep

66 files imported Radix (71 imports). All five families are migrated and
**`grep -rn "@radix-ui" src/` now matches nothing but one historical sentence in
a `src/ui/button.tsx` comment.**

| family | consumers | per-family report |
|---|---|---|
| tooltip | 1 wrapper + 14 `asChild` call sites in 8 files | `tooltip.md` |
| context-menu | 1 wrapper + 4 files | `context-menu.md` |
| dropdown-menu | 16 files (new wrapper) | `dropdown-menu.md` |
| popover | 25 files (new wrapper) | `popover.md` |
| dialog | 26 files (new wrapper) | `dialog.md` |

Totals across the sweep: 69 `asChild` → `render`, 75 `onSelect` → `onClick`,
51 `Content` → `Positioner > Popup`, 26 `Overlay` → `Backdrop`, 9
`onOpenAutoFocus` → `initialFocus`, 2 `onCloseAutoFocus` → `finalFocus`, 1
`onInteractOutside` + 1 `onEscapeKeyDown` → `onOpenChange` reasons, 1
`preventDefault()`-to-stay-open → `closeOnClick={false}`.

### The four things nothing in the toolchain catches

Every one of these compiles, lints and passes the test suite while being wrong.
They are the reason this migration cannot be judged by a green build.

1. **`onSelect` on a menu item.** Base UI renders items as `<div>`, so
   `onSelect` stays a valid React DOM prop: a missed rename is a dead handler.
   75 sites.
2. **z-index left on a Popup.** The Popup is statically positioned inside the
   Positioner, so a z-index on it does nothing. Moved onto the Positioner at
   every anchored call site, verbatim, so the ratchet stays flat. (Dialogs are
   exempt — their Popup is `fixed` in the consumers' own classes.)
3. **Submenu placement.** Radix's `SubContent` implied `side="right"
   align="start"`; Base UI's Positioner defaults to `side="bottom"
   align="center"`. Five submenus would have opened underneath their parent
   item. Restored explicitly.
4. **Attribute selectors in non-component code.**
   `browser-overlay-watcher.tsx` decided when to hide the native webview by
   matching `[data-radix-popper-content-wrapper]` and
   `[data-state="open"][data-side]` — neither exists in Base UI, so every
   popover and menu over a live Browser tab would have been painted over.
   `header-dock.tsx` kept a dock button lit with `data-[state=open]`, which Base
   UI spells `data-popup-open`. Both fixed; the watcher's test was updated with
   them.

### Shared CSS

`src/styles/globals.css`:
- `.atlas-menu-pop` and `.atlas-panel-in-tl` read `var(--transform-origin, …)`
  instead of `var(--radix-popper-transform-origin, …)`, same fallbacks. Base UI
  sets the var on the Positioner and the Popup inherits it.
- The reduced-motion exit-swap rule matches `[data-closed]` as well as
  `[data-state="closed"]`, and its "no state attribute" arm excludes both.
  Without this a closing menu would keep its movement under OS reduce-motion.

`src/features/theme/resolve-theme.test.ts` — the only file touched under
`src/features/theme/**`, and only because it had to be: its `CSS_VAR_ALLOWLIST`
enumerates engine-supplied CSS vars, so the five `--radix-*` entries were
replaced by `--transform-origin`, `--anchor-width`, `--available-height` and
`--available-width`. Without it the suite fails.

## Design system

`docs/reference/design-system.md` now lists the five primitives and the three
rules they share (Portal > Positioner > Popup; positioning props declared **and**
forwarded; z-index on the Positioner). The gallery at
`?scenario=design-system` gained an overlay section showing every part and
state, including a dialog containing a dropdown menu — the one place the
`z-popover` (200) above `z-modal` (110) ordering is visible without clicking
through the app.

The **design-system ratchet baseline is byte-identical** to where it started:
no count went up, and none went down. z-index values and colour literals were
moved between elements, never rewritten.

## Final build

`bun run lint`, `bun run format:check`, `bun run typecheck` (both configs) and
`bun run test` (107 files, 1096 tests) all pass, against a baseline where all
four were already green. No cargo work: nothing Rust changed.

## Left on Radix

**Nothing.** 0 wrappers remain on Radix; `src/ui/` holds five Base UI overlay
primitives plus the pre-existing token primitives.

One follow-up flagged rather than done: `src/ui/button.tsx` still renders a
plain `<button>`. Base UI ships a Button primitive with `render`, and the
design-system doc's "no `asChild`, that would need a second dependency"
rationale no longer holds now `@base-ui/react` is present. Adopting it changes
the API of a primitive with hundreds of call sites and belongs to its own
decision.
