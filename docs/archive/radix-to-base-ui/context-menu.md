# context-menu

2026-09-18 — transformation engine, with the `base-nova` registry wrapper used
as a shape reference. Verdict: migrated; two flagged deltas (menu entrance
animation added, `onSelect` silently type-checks so it had to be swept by hand).

## Changed

- `src/ui/context-menu.tsx` — rebuilt on `@base-ui/react/context-menu`.
  - `Content` → `Portal > Positioner > Popup`. `align`/`alignOffset`/`side`/
    `sideOffset` are declared on `ContextMenuContent` and forwarded to the
    Positioner.
  - `Label` → `GroupLabel`, `Sub` → `SubmenuRoot`, `SubTrigger` →
    `SubmenuTrigger`, `ItemIndicator` → `CheckboxItemIndicator`.
  - SubTrigger open marker `data-[state=open]:` → `data-popup-open:`;
    `data-[disabled]:` → `data-disabled:`.
  - `ContextMenuSubContent` now composes the public `ContextMenuContent` and
    pins `align="start" alignOffset={4} side="right" sideOffset={0}`. Radix's
    `SubContent` implied that placement; Base UI's Positioner defaults to
    `align="center"` with no side, so without these a submenu would open
    centred over its parent.
  - Styling moved onto the landed scales: `z-[9999]` → the `z-popover` layer on
    the Positioner (above `z-modal`, so a menu inside a dialog escapes it);
    `shadow-[0_8px_24px_rgba(0,0,0,0.6)]` → `shadow-md` (`--elevation-menu`);
    `bg-black` → `bg-bg-overlay`; `rounded-md` → `rounded-lg` (the menu step);
    `text-[11.5px]`/`text-[12px]`/`text-[9.5px]` → `text-xs`/`text-sm`/
    `text-3xs`; the uppercase label block → the `eyebrow` named style;
    `opacity-40` → the single `opacity-50` disabled treatment.
  - The z-index had to move: in Base UI the Popup is static inside the
    positioned Positioner, so a z-index on the Popup has no effect at all.
- `src/features/explorer/components/file-tree.tsx` — 2 `asChild` → `render`
  (the outer tree trigger wraps the per-row trigger, so the nested one has to
  be converted first), 21 `onSelect` → `onClick`.
- `src/features/keybindings/components/keybindings-table.tsx` — 1 `asChild` →
  `render`, 9 `onSelect` → `onClick`.
- `src/components/app-context-menu.tsx` — `import * as ContextMenu from
  "@radix-ui/react-context-menu"` → `import { ContextMenu } from
  "@base-ui/react/context-menu"`; `Content` → `Positioner > Popup` with the
  existing `zIndex: 99999` moved verbatim onto the Positioner; `asChild` →
  `render={children}`, which tightened the component's own `children` prop from
  `ReactNode` to `ReactElement` (Base UI clones one element, exactly as Radix's
  `asChild` merged onto one child).
- `src/features/browser/components/browser-panel.tsx` — same import and
  `Content` → `Positioner > Popup` treatment, 1 `asChild` → `render`. Its items
  already used `onClick`.

Leftover scan: `grep -rn "radix-ui\|@radix-ui" src/ui/context-menu.tsx
src/features/explorer/components/file-tree.tsx
src/features/keybindings/components/keybindings-table.tsx
src/components/app-context-menu.tsx
src/features/browser/components/browser-panel.tsx` → clean. No
`@radix-ui/react-context-menu` import remains anywhere under `src/`.

## Left alone

- The hardcoded `#0f0f0f` / `#1a1a1a` palette in `app-context-menu.tsx` and
  `browser-panel.tsx`. Those are `colour-literal` ratchet entries and belong to
  the colour sweep (PR 4), not to this migration — the design-system doc says
  not to fix a violation walked past.
- `src/dev/mock-backend/**` — no context-menu fixture needed changing.

## Behavior changes

- **`onSelect` compiles but never fires.** Base UI's `Menu.Item` renders a
  `<div>`, so `onSelect` remains a valid React DOM prop on it: a call site left
  on `onSelect` type-checks, lints, renders — and does nothing when clicked.
  All 30 sites were swept to `onClick`. Nothing in the toolchain would have
  caught a missed one; this is the single highest-risk item in the family.
- **The menu now has an entrance.** The Radix wrapper appeared instantly. The
  new Popup carries `animate-scale-in` from `origin-(--transform-origin)` — the
  house 150ms `ease-out-strong` entrance already used by the tooltip. Deliberate
  and flagged, not an accident of the port.
- **`closeOnClick` defaults to `false` on `CheckboxItem`/`RadioItem`** in Base
  UI where Radix closed the menu on select. Atlas has no checkbox or radio
  context-menu item in use today, so nothing changed; the default is left at
  Base UI's, per the skill's rule.
- **`ContextMenu.Root` has no `modal` prop** and **`ContextMenu.Trigger` has no
  `disabled` prop** in Base UI. Neither was used by Atlas.
- **Collision padding** defaults 0 → 5, as with the tooltip.

## Verify by hand

1. Right-click a file-tree row: the menu opens at the pointer, and right-
   clicking a row outside the current multi-selection collapses the selection
   to that row first.
2. Click each item and confirm the action runs — this is the `onSelect` →
   `onClick` sweep, and a missed one fails silently.
3. Type the first letter of an item with the menu open: typeahead moves the
   highlight. Arrow keys wrap at the ends.
4. Escape closes it and focus returns to the row.
5. Right-click a keybindings-table row: the row also becomes selected
   (`onOpenChange`), and Copy / Change / Remove all fire.
6. Right-click in the Browser reader pane: Copy Selection, Find in Page and the
   rest all run.
7. Right-click the app background (`AppContextMenu`): New Chat / New Terminal /
   Settings open their tabs.
