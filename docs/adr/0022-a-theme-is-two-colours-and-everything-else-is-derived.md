# ADR-0022: A theme can be two colours; every shadcn token is optional and derived once

**Status:** Accepted (2026-10-22). Amends ADR-0009, whose "base tokens (required)" it
reverses; the rest of 0009 stands.

**For agents:** no base token is required. A missing one is derived by the rules in
`crates/atlas-theme/keys.toml` (`[[base]]`), which `bun run theme:keys` generates into
both TypeScript and Rust. Do not write a fallback chain anywhere else. If a colour
needs a new rule, add it to that file; if it needs a new operation, add it to both
interpreters and the parity fixture.

## Context

ADR-0009 made the shadcn token set the floor of every theme, so all 42 tokens are
required. Three things have gone wrong since.

- **Authoring a theme means 42 decisions.** Most of them are not decisions at all.
  `card` is the background, `popover` is the card, and `sidebar-border` is the border.
  A whole theme can be built from a background, an accent and an optional foreground,
  and its users would not be able to tell what they are missing. That is the experience a "Create
  theme" dialog should have.
- **The derivation exists twice.** The TypeScript resolver derives the theme keys from
  `keys.toml`. The Rust importer derives missing base tokens with its own hand-written
  chains (`import/draft.rs`: `fallback_for`, `atlas_default`). They use different rules,
  different defaults, and sRGB arithmetic. The importer's chains can't run when a user
  edits a theme, and the resolver's rules can't run when a token is missing.
- **Mixing in sRGB is the wrong space.** `toward_foreground` at 8% on a saturated
  background shifts the hue and drops the lightness unevenly. Light and dark variants
  then need different amounts to look the same. The contrast slider inherits the same
  error.

## Decision

**The seeds are shadcn tokens, not a new concept.** `background`, `primary` and
`foreground` are the roots of the derivation graph. Every other base token derives from
them. The roots themselves fall back to Atlas's default for the appearance, and
`foreground` falls back to whatever reads best on `background`. A file whose only
content is

```toml
[dark.base]
background = "#101418"
primary = "#7aa2f7"
```

is a complete theme, and it is still a shadcn theme: no token is renamed and none is
added.

**Every level stays optional and overrides the level below it:**

1. Seeds.
2. Base tokens, where imports land.
3. Palette. It stays optional and has no default, because a key reads the palette
   before base: a default hue would outrank the theme's own `primary`. A key with no
   source falls back to its own last-resort value, which for `syntax.*` is Pierre's.
4. Theme keys.

A value written at any level is used exactly as written, and nothing is derived over
it.

**One derivation engine.** `keys.toml` gains `[[base]]` entries in the same shape as
`[[key]]`:

- a source token;
- an optional palette source;
- an operation from the closed vocabulary;
- a default for each appearance.

`theme:keys` generates them into the TS registry and a Rust table. Each language has
one small interpreter for the closed set of operations. A shared golden fixture holds
the derived values for a set of seeds, and both languages' tests must reproduce it.
That fixture is what makes two interpreters one engine.

The importer's `fill_required_base` becomes a call to the Rust interpreter.
`fallback_for` and `atlas_default` are deleted.

**Derivation runs where the colour is needed, from the file as written:**

- Rust sends the frontend each variant as authored. The TypeScript resolver derives
  base tokens first, then the palette, then the keys, so the theme creator can show
  any token as "derived, click to pin" and preview a seed change on every frame
  without a round trip.
- Rust derives in two places: export, which writes the full resolved shadcn set so the
  output works anywhere shadcn does, and import.

**The arithmetic is perceptual.** `mix` interpolates in OKLab, and a new `readable`
operation picks the candidate with the greater WCAG contrast against a surface. That
operation replaces the importer's "contrast with primary" special case. The existing
key operations (`toward_background`, `toward_foreground`, `alpha`) and the
`interfaceContrast` slider all use the same `mix`. Every derived colour in every theme
therefore moves slightly, once, in this change.

**What gets pinned:**

- Built-in themes pin every base token. Each was tuned by hand or ports a published
  theme, so a rule improving must not repaint it. A built-in
  may drop a token later, deliberately, to follow the rule instead.
- Imports pin every token the importer derived. The user previewed the result and
  accepted it, so it must not move under them when a rule improves.
- A theme made in the creator saves only what the user touched, and accepts that its
  derived tokens improve with Atlas.

## Considered options

- **New `seed.*` tokens beside the shadcn set.** Rejected. A seed would be a second
  name for `background` or `primary`, and every reader would have to know which one
  wins. Making the existing tokens optional gives the same UX with no new vocabulary,
  and a seeds-only file is still valid shadcn input.
- **Derive in Rust only, and ship complete variants to the frontend.** Rejected. The
  creator's live preview would need an IPC call per frame, and the mock backend
  (`bun run dev`) would need its own copy of the rules, which is a second engine by
  another name. It would also hide which tokens the author actually wrote.
- **Derive in TypeScript only, with export done in the frontend.** Rejected. Export
  and import are Rust and are tested there. Moving them to make derivation single-language
  would trade a fixture-guarded interpreter for a larger, untested move.
- **Derive in CSS (`color-mix()`, relative colour syntax).** Still rejected, for
  ADR-0009's consumer reason: xterm, pixi, recharts and CodeMirror need concrete
  values.

## Consequences

- `validate_variant` stops reporting missing tokens. An unknown token is still an
  error, and so is a malformed value.
- The JSON Schema drops `required` from the base tokens.
- `docs/reference/theme-keys.md` gains a generated table of the base rules beside the
  key rules.
- Third-party themes that set all 42 tokens render exactly as before, apart from the
  OKLab change to the derived theme keys.
- The importer's report keeps its "derived" entries. They now name the rule that
  produced each value, not the chain.
