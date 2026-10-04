# dropdown-menu

2026-09-18 — transformation engine (the `base-nova` registry wrapper was fetched
and used as the target shape for the new `src/ui/dropdown-menu.tsx`; the 16
consumers are hand-rolled Radix and were transformed in place, keeping their own
classes). Verdict: migrated; four flagged deltas.

## Changed

- `src/ui/dropdown-menu.tsx` — **new**, on `@base-ui/react/menu`. Base UI has no
  "DropdownMenu": a trigger-anchored menu *is* `Menu`, so the import is
  `import { Menu as MenuPrimitive } from "@base-ui/react/menu"` while the public
  names stay shadcn's. `Portal > Positioner > Popup`; `align`/`alignOffset`/
  `side`/`sideOffset` declared on `DropdownMenuContent` and forwarded to the
  Positioner. `Label` → `GroupLabel`, `Sub` → `SubmenuRoot`, `SubTrigger` →
  `SubmenuTrigger`, `ItemIndicator` → `CheckboxItemIndicator` /
  `RadioItemIndicator`. `DropdownMenuSubContent` composes the public Content and
  pins `align="start" alignOffset={-3} side="right" sideOffset={0}`. SubTrigger
  open styling is `data-popup-open:`. Scales: `rounded-lg`, `shadow-md`
  (`--elevation-menu`), `z-popover` on the Positioner, `max-h-(--available-height)`.
- 16 consumers off `import * as DropdownMenu from "@radix-ui/react-dropdown-menu"`
  onto `import { Menu as DropdownMenu } from "@base-ui/react/menu"`:
  `settings/providers-settings`, `memory/provider-pickers`,
  `keybindings/profile-bar`, `chat/composer-add-menu`, `chat/chat-header`,
  `auth/account-menu`, `layout/center-panel`, `projects/add-project-menu`,
  `projects/project-sidebar`, `comms/message-group`,
  `organisations/members-modal`, `organisations/org-switcher`,
  `knowledge/editor-footer`, `knowledge/knowledge-sidebar`, `log/log-panel`,
  `mission-control/dashboard/dashboard-header` (since renamed to
  `usage/components/usage-header` by the Usage tab upstream).
  - 24 `Content`/`SubContent` → `Positioner > Popup`, positioning props hoisted.
  - 19 `asChild` → `render`; 45 `onSelect` → `onClick`.
  - **z-index moved onto every Positioner.** The Popup is static inside the
    positioned Positioner, so the `z-[9999]` / `z-[var(--z-max)]` /
    `z-[var(--z-modal)]` / `style={{ zIndex }}` those files carried would have
    stopped working where it stood. The values are moved verbatim, not
    renamed to the new layers — that is the colour-and-scale sweep's job, and
    moving them keeps the design-system ratchet flat.
    `account-menu.tsx` and `profile-bar.tsx` kept their z-index inside a
    `CONTENT_CLASS` string constant, so it was split out of the constant and
    put on the Positioner by hand.
  - **Submenu placement restored explicitly** in `composer-add-menu.tsx` (4) and
    `project-sidebar.tsx` (1): Radix's `SubContent` implied `side="right"
    align="start"`, Base UI's Positioner defaults to `side="bottom"
    align="center"`, which would have opened every submenu underneath its
    parent item. Nothing type-errors on this; only looking at it catches it.
  - `onCloseAutoFocus` → `finalFocus` in `profile-bar.tsx`
    (`finalFocus={() => !openingInput.current}`) and `project-sidebar.tsx`
    (`finalFocus={false}`). Both existed to stop the menu's focus-return from
    blurring a freshly mounted rename input.
  - `org-switcher.tsx`: the one `onSelect={(e) => { e.preventDefault(); … }}`
    ("keep the menu open") became `closeOnClick={false}` plus a plain `onClick`.
  - `account-menu.tsx` / `members-modal.tsx`: the components' own `children` /
    `trigger` props tightened from `ReactNode` to `ReactElement`, because
    `render` clones one element where `asChild` merged onto one child.
  - `message-group.tsx`: `--radix-dropdown-menu-content-transform-origin` →
    `--transform-origin`.
- `src/styles/globals.css`
  - `.atlas-menu-pop` and `.atlas-panel-in-tl` read `var(--transform-origin, …)`
    instead of `var(--radix-popper-transform-origin, …)`, with the same
    fallbacks. Base UI sets `--transform-origin` on the Positioner and the
    Popup inherits it, so the grow-from-the-trigger entrance is unchanged.
  - The reduced-motion exit-swap rule now matches `[data-closed]` as well as
    `[data-state="closed"]`, and the "no state attribute at all" arm excludes
    both. Without this a closing menu would keep its movement under OS
    "reduce motion".
- `src/features/auth/components/account-button.tsx` — a doc comment that
  described `DropdownMenu.Trigger asChild` now describes `render`.
- `src/features/theme/resolve-theme.test.ts` — Base UI runtime vars were added
  to `CSS_VAR_ALLOWLIST` in the tooltip commit; the Radix entries stay until the
  last family lands.

Leftover scan: `grep -rn "@radix-ui/react-dropdown-menu\|--radix-dropdown" src/`
→ only the (now stale) allowlist entry in `resolve-theme.test.ts`, removed at
the end of the migration.

## Left alone

- The hardcoded colours (`bg-black`, `bg-[#000]`, `#1a1a1a`) and arbitrary text
  sizes in the consumers. Ratchet entries owned by the colour-and-scale sweep.
- `capture-popover.tsx`, `session-chat-panel.tsx`, `artifacts-panel.tsx` and
  friends have their own `onSelect` props on ordinary components — not Radix,
  not renamed.
- The consumers were **not** repointed at the new `src/ui/dropdown-menu.tsx`.
  Every one of them carries its own surface classes; adopting the wrapper would
  restyle sixteen surfaces in a migration commit. The wrapper is what new code
  and the sweep build on.

## Behavior changes

- **`onSelect` compiles and never fires** (Base UI items render a `<div>`, so
  it stays a valid DOM prop). 45 sites swept; nothing in lint, tsc or the test
  suite would catch a missed one.
- **Checkbox items no longer close the menu.** Radix's `CheckboxItem` closed on
  select; Base UI's `closeOnClick` defaults to `false` there. The log panel's
  source filter and the providers-settings sort menu now stay open while you
  toggle several. Left at Base UI's default per the skill's rule — it is also
  the better behaviour for a multi-select filter.
- **Submenu hover delay.** Base UI's `SubmenuTrigger` has `delay` 100ms /
  `closeDelay` 0; Radix opened submenus on a different internal schedule. Left
  at Base UI's defaults.
- **Menus now loop through items by default** (`loopFocus` defaults true on the
  Root; Radix's `loop` defaulted false and no call site set it).
- **Collision padding** 0 → 5 and **arrow padding** 0 → 5, as with the tooltip.
- The new `src/ui/dropdown-menu.tsx` popup has the house `animate-scale-in`
  entrance; the ad-hoc consumer menus keep whatever entrance they had.

## Verify by hand

1. Open the account menu, the log-panel filter, the export menu in the Usage
   header, the project-sidebar row menu: each must appear anchored to
   its trigger, at the same offset as before, and **above** anything it opens
   over.
2. Click every item in at least three of them — this is the `onSelect` sweep.
3. Composer "+" menu: hover "Take a screenshot", "Add from GitHub", "Attach a
   session", "Reference project". Each submenu must open **to the right of** its
   row, top-aligned with it, not underneath.
4. In the project sidebar, choose Rename from the row menu: the inline input
   must keep focus after the menu closes (`finalFocus={false}`).
5. In the keybindings profile bar, choose "New profile…": same check.
6. Org switcher → "Turn on sync for …": the menu must stay open
   (`closeOnClick={false}`).
7. Open a dropdown inside a dialog (members-modal role menu) and confirm the
   menu draws above the dialog and closes without closing the dialog.
8. Keyboard: arrow keys move the highlight and wrap; typing a letter jumps to
   the matching item; Escape closes the submenu first, then the menu.
