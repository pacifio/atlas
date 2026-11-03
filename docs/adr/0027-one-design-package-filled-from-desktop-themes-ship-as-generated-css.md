# ADR-0027: One design package, filled from desktop; its themes ship as CSS generated from keys.toml

**Status:** Accepted (2026-11-04). Supersedes the design-system spec's (ATL-426) D1, D4,
D9, D11, D12 and D17 where they disagree with it. ADR-0009 and ADR-0022 stand.

**For agents:** colour is derived in exactly one place, `keys.toml`, and nowhere else.
The package publishes that derivation three ways: a TypeScript resolver, a Rust rule
table, and a static `themes.css` for every built-in theme. A consumer that only needs
built-in themes (web, docs, Storybook) imports the CSS and runs no colour code. Never
derive a theme colour with `color-mix()`; a call-site tint stays allowed (ADR-0009's
amendment).

## Context

Atlas renders one product in three places that agree only by accident. `apps/web`
(in `tryatlas/server`) holds 57 `ui/` files copied from `pacifio/standards`, 6 of them
drifted. `docs-atlas` holds another 10 copies. Desktop has its own primitives
(`src/ui`), tokens and theme engine. Copying files is what produced the drift.

The design-system spec (ATL-426, written 2026-10-06 to 10-19) proposed promoting
`standards` into a package and having desktop adopt it. Two things have changed since:

- **Desktop moved ahead.** The UI overhaul in 0.4.1 rebuilt most desktop surfaces.
  `standards` has not had a commit since 2026-09-30. Adopting it would roll desktop's
  design back.
- **ADR-0022 kept derivation in `keys.toml`.** The spec's D4 moved it into CSS
  `color-mix()` and retired `keys.toml`. ADR-0022 rejected that a week later.

The open question was whether a CSS-derived vocabulary would make Storybook, web and
docs easier, given that those consumers can't run Atlas's TypeScript theme engine
through IPC.

## Decision

**One package, `@tryatlas/design`, in the `standards` repo, renamed `pacifio/design`
and restructured as a library.** Its history becomes the system's history. The TanStack
`/mock` app and `/ds` gallery are deleted; Storybook replaces them.

**Desktop is the source of truth.** The package is filled by copying from desktop:

- the `src/ui` primitives
- `tokens.css` and the named utilities
- `keys.toml`, its generator, the TypeScript resolver, the built-in themes and the golden
  fixture
- the design-system ratchet

Components that only `standards` has (avatar, toast, table, tag, sheet and the rest) are
restyled to desktop's language. Where both have a component, desktop's wins.

**The boundary rule (spec D3) stands.** A component belongs in the package if it renders
from props alone. It stays in an app if it calls `invoke()`, `fetch`, a router or a store.

**Themes ship as generated CSS.** The package's generator reads `keys.toml` and the
built-in themes, and emits:

1. the TypeScript registry and resolver, used by desktop's runtime and the theme editor;
2. the Rust rule table (`base-rules.txt`, `theme-keys.txt`);
3. **`themes.css`**: every built-in theme, both appearances, fully resolved, one block per
   `[data-theme="…"][data-appearance="…"]`.

A user theme or a live theme-editor preview still runs the resolver, as today. The
golden fixture keeps the two interpreters one engine.

**Desktop's Rust build stays hermetic.** `bun run theme:keys` copies `keys.toml`, the
built-in themes and the generated Rust tables from the installed package into
`crates/atlas-theme/`, as committed generated files. A contract test fails when they
differ from the installed package. Cargo never reads `node_modules`.

**One CSS name per key.** A theme key's CSS variable is its dotted name with `.` and `_`
turned into `-`, with no prefix: `element.hover` → `--element-hover`. The `--atlas-`
prefix goes. A test asserts the mapping has no collisions, including with the shadcn
base tokens.

**Distribution.** The package is installed from a git tag
(`github:pacifio/design#v0.x.y`) until the `@tryatlas` npm scope is set up, then from npm.
Desktop pins an exact version so release builds are reproducible. Web and docs may use a
range.

**Type.** Geist and Geist Mono ship in the package through `@fontsource-variable`, so
they work offline in Tauri. Desktop moves off the system font. Atlas Sans replaces Geist
when it is ready.

**Review surfaces.** The package has a Storybook. Desktop does not: its mock backend
(`bun run dev`, `?scenario=…`) already shows composed screens with real stores. There is
no visual-regression suite and no Storybook composition for now.

**Mobile is deferred.** The PWA and the Flutter retirement (spec D17) are out of scope
until the team picks them up again.

## Considered options

- **Derive in CSS with `color-mix()` (the spec's D4).** Rejected, for three reasons.
  - Rust needs the derivation too: export writes the full shadcn set and import fills
    missing tokens. CSS derivation would bring back the second engine ADR-0022 removed.
  - ADR-0022's `readable` operation picks the candidate with the greater contrast.
    `color-mix()` can't compare, and `contrast-color()` is not in WebKit.
  - xterm, pixi, recharts and the code viewers need concrete values. Reading them back
    from a probe element means parsing WebKit's `color(srgb …)` output, plus a boot gate
    for WebKit older than 16.2.

  The thing CSS derivation was meant to buy, consumers that need no theme code, is
  bought more cheaply by generating `themes.css`.
- **Promote `standards` as it is, and have desktop adopt it.** Rejected: it is older than
  desktop's design.
- **A workspace package inside the `atlas` repo.** Rejected: web and docs live in other
  repos, and the package needs a release cadence of its own.
- **A Storybook per app, composed into one site.** Rejected for now. The desktop mock
  backend already does the app-level job, and composition across three hosts is fragile.

## Consequences

- Changing a derivation rule is a package change plus a desktop bump. Use `bun link` while
  iterating on both.
- The `--atlas-*` → unprefixed rename touches every feature directory. It runs as
  expand–migrate–contract (spec D19): new names authoritative, old ones aliased, call
  sites moved by directory, aliases deleted and banned by the ratchet.
- `bun-singletons.test.ts` gains `@base-ui/react`, `motion` and `@tryatlas/design`.
- The `?scenario=design-system` gallery shrinks once its primitives come from the package.
