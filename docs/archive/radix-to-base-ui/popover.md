# popover

2026-09-18 — transformation engine (the `base-nova` registry wrapper was the
target shape for the new `src/ui/popover.tsx`; the 25 consumers are hand-rolled
Radix and were transformed in place, keeping their own classes). Verdict:
migrated; one functional break found and fixed that nothing in the toolchain
reports, plus three flagged deltas.

## Changed

- `src/ui/popover.tsx` — **new**, on `@base-ui/react/popover`.
  `Portal > Positioner > Popup`, `align`/`alignOffset`/`side`/`sideOffset`
  declared on `PopoverContent` and forwarded to the Positioner. Adds the
  `Title` / `Description` parts Base UI has and Radix did not. Scales:
  `rounded-lg`, `shadow-md` (`--elevation-menu`), `z-popover` on the
  Positioner, `max-h-(--available-height)`, the house `animate-scale-in`
  entrance from `origin-(--transform-origin)`.
- 25 consumers off `import * as Popover from "@radix-ui/react-popover"` onto
  `import { Popover } from "@base-ui/react/popover"`:
  `artifacts/{export-button,session-chat-panel,artifacts-panel,session-detail,
  checkpoint-scope-picker,checkpoints-picker}`,
  `memory/{memory-sharing-controls,provider-pickers}`,
  `chat/{chat-pinned-menu,chat-header,provider-model-pills}`,
  `spaces/{space-chrome,space-toolbar}`,
  `comms/{message-group,rename-channel-menu,pinned-menu,create-channel-menu,
  emoji-picker,new-dm-menu,call-menu}`, `github/github-panel`,
  `git/diff-view`, `git/git-manager/{branch-switcher,history-view}`,
  `components/titlebar`.
  - 27 `Content` → `Positioner > Popup`; 29 `asChild` → `render`.
  - z-index moved onto every Positioner, verbatim (see the dropdown-menu
    report for why it has to move).
  - `--radix-popover-content-transform-origin` → `--transform-origin`,
    `--radix-popover-trigger-width` → `--anchor-width` (`session-detail.tsx`).
  - `data-[state=open]:` / `data-[state=closed]:` → `data-open:` /
    `data-closed:` on the popups that animate.
  - `onOpenAutoFocus={(e) => { e.preventDefault(); ref.focus(); }}` →
    `initialFocus={ref}` in `emoji-picker.tsx` and `github-panel.tsx`; the
    latter gained a `filterRef` because it had been reaching the input through
    `e.currentTarget.querySelector("input")`.
  - `rename-channel-menu.tsx`: `children` tightened `ReactNode` → `ReactElement`
    (`render` clones one element).
- **`src/features/browser/components/browser-overlay-watcher.tsx` — the break
  worth the most attention.** A native child webview paints over the whole HTML
  layer, so Atlas hides the embedded browser whenever an overlay is open. The
  detector matched `[data-radix-popper-content-wrapper]` and
  `[data-state="open"][data-side]` — **neither attribute exists in Base UI**.
  Every popover and menu opened over a live Browser tab would have been painted
  over by the webview, with no error anywhere. The selector now matches
  `[data-open][data-side]` (Base UI's Positioner and Popup carry both) and the
  MutationObserver's `attributeFilter` watches `data-open` instead of
  `data-state`. `browser-overlay-watcher.test.tsx` was updated to the same
  attributes; all three cases still pass, including "a tooltip must not hide
  the browser".
- `src/features/artifacts/components/header-dock.tsx` — `DOCK_TRIGGER` carried
  `data-[state=open]:bg-white/[0.12]` to keep a dock button lit while its
  popover is up. Base UI marks an open trigger `data-popup-open`, so that is
  now `data-popup-open:`. Another silent one: the class compiled fine and
  simply never matched.
- `src/components/titlebar.tsx`, `src/features/chat/components/chat-header.tsx`,
  `src/features/comms/components/call-menu.tsx`,
  `src/features/artifacts/components/header-dock.tsx` — comments that described
  Radix's `asChild`/unmount behaviour now describe `render` and Base UI.

Leftover scan: `grep -rn "@radix-ui/react-popover\|--radix-popover\|data-radix"
src/` → only the stale `resolve-theme.test.ts` allowlist entries, removed at the
end of the migration.

## Left alone

- `src/features/capture/components/capture-popover.tsx` — it is the *content* of
  the titlebar popover, not a Radix component; its `atlas-panel-in-tl` entrance
  now reads `--transform-origin` through the `globals.css` change made in the
  dropdown-menu commit.
- The consumers were not repointed at the new `src/ui/popover.tsx`; each carries
  its own surface (glass, blur, custom shadows). Adopting the wrapper would
  restyle 25 surfaces inside a migration commit.
- Colour literals and arbitrary sizes in those files — the colour-and-scale
  sweep's job.

## Behavior changes

- **`hideWhenDetached` has no equivalent.** No call site used it; Base UI
  exposes `data-anchor-hidden` on the Positioner if it is ever needed.
- **`Popover.Anchor` is gone** in Base UI (the Positioner takes an `anchor`
  prop instead). Atlas never used the part.
- **Collision padding** 0 → 5 and **arrow padding** 0 → 5, as elsewhere.
- **`modal` widened** to `boolean | "trap-focus"`, default still `false`.
  Nothing changed for Atlas.
- Dismiss callbacks (`onEscapeKeyDown`, `onPointerDownOutside`,
  `onInteractOutside`) are now reasons on `onOpenChange`'s `eventDetails`. No
  popover call site used any of them.

## Verify by hand

1. Open a Browser tab, then open the titlebar capture popover, a dock popover in
   the Timeline header, and a context menu over it. **The webview must
   disappear each time** and come back on close — this is the overlay-watcher
   fix and it is invisible in the mock backend.
2. Hover a dock button in the Timeline header while its popover is open: the
   button stays lit (`data-popup-open`).
3. Open the emoji picker in Comms: the search box must have focus immediately.
4. Open the GitHub panel's branch switcher: the filter box must have focus.
5. Open the session-detail picker: its popup must be exactly as wide as its
   trigger (`--anchor-width`).
6. Open the titlebar project popover and close it: the exit `animate-scale-out`
   must still play, and the panel's blur must not flatten during the entrance.
7. Open a popover near the bottom/right edge of the window and confirm it flips
   rather than clipping.
8. With OS "reduce motion" on, opening and closing are plain fades.
