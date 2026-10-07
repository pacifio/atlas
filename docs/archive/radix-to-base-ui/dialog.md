# dialog

2026-09-18 — transformation engine (the `base-nova` registry wrapper was the
target shape for the new `src/ui/dialog.tsx`; the 26 consumers are hand-rolled
Radix and were transformed in place, keeping their own classes). Verdict:
migrated; two flagged deltas.

## Changed

- `src/ui/dialog.tsx` — **new**, on `@base-ui/react/dialog`.
  `Overlay` → `Backdrop` (the public export keeps the `DialogOverlay` name,
  as the shadcn base registry does), `Content` → `Popup`. A centred modal has
  **no Positioner** — the Popup places itself; only anchored popups need one.
  Scales: `rounded-xl` (the dialog step), `shadow-lg` (`--elevation-dialog`),
  `z-overlay` for the scrim and `z-modal` for the dialog, `heading` / `body`
  named type styles for Title and Description, and the house
  `animate-fade-in` / `animate-scale-in` pair keyed on `data-open` /
  `data-closed`. The close button composes the existing `IconButton`.
- 26 consumers off `import * as Dialog from "@radix-ui/react-dialog"` onto
  `import { Dialog } from "@base-ui/react/dialog"`, with `Dialog.Overlay` →
  `Dialog.Backdrop` and `Dialog.Content` → `Dialog.Popup`:
  `components/{command-palette,new-tab-palette,search-overlay}`,
  `agents/{agent-oauth-modal,remove-agent-dialog}`,
  `auth/connect-dialog`, `canvas/canvas-panel`,
  `chat/{chat-search-palette,elicitation-modal,import-threads-modal,
  permission-modal,thread-history-view}`, `comms/media-lightbox`,
  `explorer/file-tree-confirm-delete`, `file-picker/file-picker`,
  `git/{git-diff-modal,git-graph-panel}`,
  `git/git-manager/{git-error-dialog,merge-branch-dialog}`,
  `layout/layout-switcher`,
  `organisations/{create-org-dialog,members-modal,org-switcher}`,
  `projects/stop-agents-dialog`, `settings/marketplace/skill-modal`,
  `updater/update-available-modal`.
  - `data-[state=open]:` / `data-[state=closed]:` → `data-open:` /
    `data-closed:` (`git-diff-modal.tsx`).
  - **No z-index moved.** Unlike the anchored families, a dialog Popup is
    `fixed` in the consumers' own classes, so its z-index still applies where
    it stands.
  - **No `asChild` at all** in this family — every dialog here is controlled,
    with no `Dialog.Trigger`.
  - `onOpenAutoFocus={(e) => { e.preventDefault(); ref.focus(); }}` →
    `initialFocus={ref}` in `command-palette.tsx`, `new-tab-palette.tsx`,
    `search-overlay.tsx`, `chat-search-palette.tsx`, `layout-switcher.tsx`;
    → `initialFocus={false}` in `merge-branch-dialog.tsx` (which only wanted
    focus left alone) and in `agent-oauth-modal.tsx`.
  - `agent-oauth-modal.tsx` is the one real restructure. Radix's
    `onInteractOutside={(e) => e.preventDefault()}` and
    `onEscapeKeyDown={(e) => { if (phase.kind === "terminal")
    e.preventDefault(); }}` have no Base UI props: both are now *reasons* on
    the Root's `onOpenChange(open, details)`, cancelled with
    `details.cancel()`. The outside-press rule is scoped to `docked` — that is
    the only state it applied in, since the undocked branch is a real modal
    with a backdrop. The behaviour is preserved: while docked, clicking the
    terminal behind the dock does not dismiss it, and Escape does not dismiss
    it while a login is being driven in the terminal.

Leftover scan: `grep -rn "@radix-ui\|data-\[state=\|--radix-\|asChild" src/`
returns only prose in comments and the stale allowlist entries in
`resolve-theme.test.ts` (cleared in the dependency-removal commit). **No Radix
import remains anywhere under `src/`.**

## Left alone

- The consumers were not repointed at the new `src/ui/dialog.tsx`; every one has
  its own geometry (palettes at 15% from the top, a full-bleed diff modal, a
  lightbox). Adopting the wrapper would restyle 26 surfaces inside a migration
  commit.
- `aria-describedby={undefined}` on three palettes — it silenced a Radix
  warning and is now inert, but removing it is churn with no effect.
- `src/ui/button.tsx` still renders a plain `<button>`. Base UI *does* ship a
  Button primitive with `render`, and the design-system doc's "no `asChild`,
  because that would need a second dependency" rationale no longer holds now
  that `@base-ui/react` is present. Adopting it is a deliberate API change to a
  primitive with ~200 call sites and belongs to its own decision, not to this
  migration. Flagged, not done.

## Behavior changes

- **Initial focus moved one element.** Radix focused the Content element itself
  when a dialog opened; Base UI focuses the first tabbable element inside the
  Popup. For the seven dialogs that named a target this is identical. For the
  rest, the first button or input now takes focus instead of the dialog
  container — which is what the WAI-ARIA pattern asks for, and is why it is
  left at Base UI's default.
- **`modal` widened** to `boolean | "trap-focus"`, default still `true`.
  `agent-oauth-modal.tsx` is the only caller passing it (`modal={!docked}`) and
  keeps its boolean.
- **Dismiss callbacks are gone as props.** `onEscapeKeyDown`,
  `onPointerDownOutside`, `onInteractOutside` and `onFocusOutside` are now
  `eventDetails.reason` values on `onOpenChange`, cancelled with
  `eventDetails.cancel()`. Only `agent-oauth-modal.tsx` used any of them.
- Base UI exposes `data-nested` / `data-nested-dialog-open` and a
  `--nested-dialogs` count on the Popup. Nothing uses them yet; they are the
  supported way to stack dialogs if a surface ever needs it.

## Verify by hand

1. ⌘K command palette, ⌘T new-tab palette, the in-page search overlay, the chat
   search palette: each must open with the caret already in its input
   (`initialFocus`).
2. Escape closes each, and focus returns to whatever had it before.
3. Tab inside an open dialog: focus must stay trapped inside it.
4. Open a dropdown menu inside the members modal and the org switcher: the menu
   must draw above the dialog and Escape must close the menu first.
5. The layout switcher: arrow keys must work immediately, because the content
   div takes focus (`initialFocus={contentRef}`).
6. The agent sign-in dock: while docked, click into the terminal behind it — it
   must NOT dismiss. Press Escape while a terminal login is running — it must
   NOT dismiss. Press Escape in any other phase — it must dismiss.
7. The git diff modal's fade/scale entrance still plays, and reverses on close.
8. With a Browser tab live, open any dialog: the native webview must hide.
