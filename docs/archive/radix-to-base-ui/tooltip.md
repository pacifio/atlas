# tooltip

2026-09-18 — transformation engine (Atlas is not a shadcn-CLI project; the
`base-nova` registry tooltip was fetched and used as a *shape* reference only,
because Atlas's tooltip carries a bespoke border-arrow design and a hand-rolled
timing layer that no golden pair contains). Verdict: migrated, one flagged
delta (collision/arrow padding defaults), timing preserved exactly.

## Changed

- `src/ui/tooltip.tsx` — rewritten on `@base-ui/react/tooltip`.
  - `import * as TooltipPrimitive from "@radix-ui/react-tooltip"` →
    `import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"`.
  - `Portal > Content` → `Portal > Positioner > Popup`. `side`, `sideOffset`,
    `align`, `alignOffset` are declared on `TooltipContent` and **forwarded** to
    the Positioner (the Pick-means-FORWARD rule); left in `...props` they would
    have landed on the Popup and positioning would have silently broken.
  - `TooltipProvider`: `delayDuration` → `delay`, `skipDelayDuration` →
    `timeout`. Atlas's values are unchanged (`TOOLTIP_OPEN_DELAY` 300 /
    `TOOLTIP_WARM_WINDOW` 300); Base UI's own defaults would have been 600/400.
  - `Tooltip` (Root): Base UI has **no delay prop on the Root**. The Radix
    wrapper's `delayDuration` is now a `delay` prop on the wrapper, and the
    `delayDuration={0}` that used to hold Radix open-at-once is now
    `delay={0}` on the **Trigger** (`tooltip.tsx:145`), carried through a
    `managed` flag on the existing `Timing` context. The 300ms open delay, the
    300ms warm window, the `instant` → `animate-none` entrance skip and the
    cancel-on-leave/blur/press behaviour are byte-for-byte the same logic.
  - `onOpenChange` gained Base UI's `(open, eventDetails)` signature; the
    wrapper's own prop type widens to `(open, eventDetails?)` and forwards the
    details it has.
  - `openOnKeyboardFocusOnly` **deleted**: Base UI's `useFocus` already returns
    early unless the trigger matches `:focus-visible`
    (`node_modules/@base-ui/react/floating-ui-react/hooks/useFocus.js:104`), so
    the Radix workaround is now dead code. `isFocusVisible` is still exported —
    `hint-group.tsx` uses it.
  - Arrow: Radix's `Popper.Arrow` rotated the notch itself; Base UI's `Arrow`
    only sets `position` plus the cross-axis `top`/`left`
    (`internals/useAnchorPositioning.js:427`). The main-axis offset, rotation
    and transform-origin Radix used are restated verbatim in `ARROW_OFFSET`
    (`tooltip.tsx:173`), so the notch lands in the same place on every side.
    `asChild` on the Arrow is gone; the SVG is a plain child.
  - `--radix-tooltip-content-transform-origin` → `--transform-origin` (set by
    Base UI on the Positioner, inherited by the Popup).
  - The hard-coded `zIndex: 9999` / `z-50` moved off the Popup onto the
    Positioner as the named `z-tooltip` layer. In Base UI the Popup is static
    inside the positioned Positioner, so a z-index on it would have had no
    effect at all. `text-[11px]` → `text-xs`, which is the same 11px.
- `src/ui/tooltip.test.tsx` — the `point()` helper fires `mouseEnter` instead of
  `pointerMove`. Base UI opens on a native `mouseenter` listener
  (`useHover.js:239`); Radix watched `pointermove`. Every assertion is
  unchanged and all nine tests pass.
- 14 `<TooltipTrigger asChild>` call sites → `<TooltipTrigger render={…} />` in:
  `src/features/keybindings/components/keybindings-table.tsx` (2),
  `src/features/spaces/components/space-chrome.tsx` (5),
  `src/features/spaces/components/space-pages.tsx`,
  `src/features/comms/components/draft-editor.tsx` (2),
  `src/features/comms/components/call-activity.tsx`,
  `src/features/comms/components/comms-conversation.tsx`,
  `src/features/comms/components/call-menu.tsx`,
  `src/features/comms/components/drafts-tab.tsx`.
  Two of those had a leading `{/* … */}` JSX comment inside the child; a JSX
  comment is not valid as the first token of a `render={…}` expression, so it
  became a plain block comment in the same place.
- `src/features/theme/resolve-theme.test.ts` — `CSS_VAR_ALLOWLIST` gained the
  Base UI runtime positioning vars. Forced: the suite fails otherwise because
  `--transform-origin` is referenced under `src/` and is not a theme key. This
  is the only edit made under `src/features/theme/**`.

Leftover scan: `grep -n "radix-ui\|@radix-ui" src/ui/tooltip.tsx
src/ui/tooltip.test.tsx src/ui/hint-group.tsx` → clean.

## Left alone

- `src/ui/hint-group.tsx` and `src/ui/tooltip-timing.ts` — neither imports
  Radix. `hint-group.tsx` only borrows `hintTriggerProps` / `isFocusVisible`
  from `tooltip.tsx`, both of which still exist with the same signatures. The
  300ms delay, 300ms warm window, 180ms slide and 125/80ms fades in
  `tooltip-timing.ts` are untouched.
- `src/features/mission-control/components/dashboard/*.tsx` — the `<Tooltip>`
  in those files was **recharts**, not Radix, and was out of scope by the
  no-third-party rule. (That whole folder, and recharts with it, was replaced
  by `src/features/usage/` upstream; the Usage tab's chart is plain divs.)
- `src/styles/globals.css` reduced-motion block — the tooltip has no exit
  animation, so the `[data-state="closed"]` exit selectors there do not touch
  it. They are updated for `data-closed` in the popover/menu families.
- `--radix-popper-transform-origin` in `globals.css` — used by `.atlas-menu-pop`
  and `.atlas-panel-in-tl`, which belong to the popover and menu families.

## Behavior changes

- **Collision and arrow padding defaults moved.** Base UI's Positioner defaults
  are `collisionPadding: 5` and `arrowPadding: 5`; Radix's Content defaults were
  `0` and `0`. Left at Base UI's defaults deliberately: the tooltip now keeps
  5px off the viewport edge and stops centring the arrow within 5px of a
  corner. Flagged, not patched.
- **`skipDelayDuration` → `timeout` semantics.** Radix restarted the skip window
  from the moment a tooltip closed; Base UI's Provider `timeout` is documented
  the same way. Atlas does not depend on Base UI's version of this at all —
  `isTooltipWarm()` in `tooltip-timing.ts` is still the single source of truth,
  shared with `HintGroup` and the titlebar dock — so the Provider value is set
  for honesty rather than effect.
- **`disableHoverableContent` has no call site** but the Root prop is renamed
  `disableHoverablePopup` if one ever appears.
- **Focus opening is now the library's job.** Behaviour is the same (only
  `:focus-visible` opens a tooltip) but the check now lives in Base UI rather
  than in `openOnKeyboardFocusOnly`.

## Verify by hand

1. Hover an icon-only control in the titlebar. Nothing for ~300ms, then the
   tooltip scales in from the trigger.
2. Move straight to the next control: the tooltip appears instantly and with no
   entrance animation (`animate-none`).
3. Wait >300ms with nothing hovered, hover again: the delay is back.
4. Hover then leave before 300ms: no tooltip ever appears.
5. Press a control while its tooltip is pending: no tooltip appears.
6. Tab to a control with the keyboard: the tooltip opens. Click one with the
   mouse: it does not open on the click's focus.
7. Check the arrow notch on all four sides (a `side="top"` tooltip near the
   bottom of a panel, a `side="right"` one in a sidebar): the notch must meet
   the panel edge with no seam and the border hairline must line up.
8. With OS "reduce motion" on, the entrance is a plain fade.
