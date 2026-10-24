# ADR-0024: Surfaces sit beside the session; destinations take the window

**Status:** Accepted (2026-10-23). Amended 2026-10-24 (one type in both placements, below).

**For agents:** every tab type has exactly one placement, in `TAB_PLACEMENT`
(`src/lib/constants.ts`): `session`, `surface`, `destination`, or (team chat only, see the
amendment) `surface-or-destination`. Adding a tab type without one is a compile error. Read
the test below before choosing; don't add a type to a second list to get round it.
`tests/tab-placement-contract.test.ts` checks the rest.

## Context

The flat shell (#424) made the main column the session's alone and sent every other tab type
to the surfaces pane beside it. Two kinds of panel were treated as one:

- **Tools you work with beside a session:** the editor, a terminal, the browser, a diff,
  source control, team chat. These are built for a column and are fine at 320–600px.
- **Places you go to:** Timeline, Usage, Knowledge, the knowledge graph, Memory, Spaces. Each
  was designed as a full page, with its own sidebar, board, dashboard or canvas. Squeezed into
  a third of the window, they broke.

There were two ways to fix the second group. Making every panel responsive (desktop, tablet,
phone) is a large design job, and the narrow forms of a board or a graph would be poor: they
would degrade rather than work. Desktop tools rarely do it. They split side panels from full
views instead.

## Decision

**Every tab type has one placement, chosen by one test.**

> Do you use it *while* working in a session, and does it have a useful form at column width
> (about 320–600px)? Yes to both → **surface**. No to either → **destination**.

Signs that something is a destination: it has its own navigation (a sidebar or an inspector),
it is a board, dashboard, canvas or graph, or it is about the whole project or organisation
rather than the task in front of you.

- **Session** (`chat`): the main column, which shows no tab strip.
- **Surface:** a tab in the surfaces pane beside the session. Each surface declares a
  `minWidth` in pixels, and a column showing it will not resize below that.
- **Destination:** it takes the area right of the rail, one at a time, like Settings takes the
  window. The session keeps running underneath. Opening another destination replaces it.
  Esc, the header's back arrow, or the destination's own shortcut return to the session.
  Opening or focusing any session or surface returns as well. A destination stays mounted
  while hidden, so going back to it is instant.

**Peeks are added on request, never by default.** A *peek* is a compact view of a destination,
designed for a column on purpose, that can sit beside the session. None exists yet. The first
one adds a `peek` field to the destination's placement entry and a component made for the
narrow width. A full page is never put in a column as is.

**The store enforces placement on every path.** `addTab`, project restore, layout templates,
zen and closing a column all read `TAB_PLACEMENT`. A destination never enters a column, and the
editor state never saves one.

**Settings stays separate.** It is not a tab type and keeps its own full-window screen: it is
org-agnostic, it covers the rail too, and it has its own navigation and search.

## Consequences

- Timeline, Usage, Knowledge, the knowledge graph, Memory and Spaces open as destinations.
  None of them appears in the ⌘T launcher, a layout template or zen. The Research template
  becomes the session beside a browser, the Usage template is removed, and zen is Session │
  Browser.
- You cannot put Timeline beside a session. That is the trade-off: when someone needs to, the
  answer is a peek, not a column.
- Team chat moves from its own right slot to a surface tab with a 320px floor. It belongs to
  the window, not a project (`WINDOW_TYPES`), so it follows you between projects.
- A new tab type has to answer the test before it compiles, and the contract suite checks that
  no destination is offered as a surface.

## Amendment (2026-10-24): one tab type in both placements

**Status:** Accepted.

Team chat passes the surface test: you answer a teammate *while* a session works, and the
panel is built for a column. It is also a place you go to: reading the team's conversations,
catching up on a thread, sitting in it for a while. Forcing it into one placement cost one of
the two uses. As a surface only, catching up meant a 320px column; it also kept a toggle in the
title bar, beside controls that belong to the session. As a destination only, a quick reply
would take the session off screen.

**Decision.** `TAB_PLACEMENT` gets a fourth kind, `surface-or-destination`, with a `minWidth`
for its surface form. A type of this kind opens in the form its entry point asks for:

- as a **destination** from the sidebar footer (beside Timeline and Memory);
- as a **surface** from the surfaces pane's `+` menu and ⌘T;
- from its own shortcut (⌘⇧C), in the form it was last shown in, or as the destination if it
  has never been shown. The last form is a layout preference and persists.

It is still **one per window** (`WINDOW_TYPES`). Opening it in one form moves it out of the
other: the surface tab leaves its column (which folds away if it empties) when the destination
opens, and the destination screen lets go of it when the tab opens. The panel remounts on the
move, which is the cost of never showing two copies.

**Who qualifies.** Only a type that passes the surface test on its own and is also a place with
a full-width use. A destination that someone wants beside the session still gets a peek; this
kind is not a way round that. Team chat is the only member.

**Typing.** `DestinationType` covers every type that can show on the destination screen
(`destination` and `surface-or-destination`), so the destination screen's `switch` and the
`DESTINATIONS` titles must cover team chat. `isDestinationOnly` is what the store routes by: a
destination-only type never enters a column or the editor state. `isDualPlacement` and
`DualPlacementType` name the new kind. `tests/tab-placement-contract.test.ts` checks that every
dual type is one per window and never destination-only.

**Consequences.**

- The title bar no longer carries a team chat toggle. Its right end is the session's group
  (Details, ⋯) and the window's group (the panel toggle, the account).
- The sidebar footer's Team chat button lights only for the destination form; the surface form
  shows as its tab in the surfaces pane.
- Locked team chat (signed out, or a local organisation) is unchanged: greyed in the footer,
  with the hint that unlocks it.
