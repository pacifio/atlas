// The surface the session switcher and the project filter open on: the
// session details card's (`session-details-card.tsx`) — one quiet layer, the
// popover colour mixed toward the page's, with one line colour
// (`--details-line`) for the outline and every divider, no card inside it —
// and its rows (`details-rows.tsx`): 32px, medium, a soft fill on hover.

export const MENU_SURFACE =
  "flex max-h-[min(480px,70vh)] min-h-0 w-[300px] flex-col overflow-hidden rounded-xl border border-[var(--details-line)] bg-[color-mix(in_srgb,var(--popover)_44%,var(--background))] [--details-line:color-mix(in_srgb,var(--border-strong)_60%,var(--background))] text-popover-foreground shadow-md atlas-panel-in-tl select-none";

/** The search row at the top, ruled off from the list by the card's line. */
export const MENU_SEARCH =
  "flex h-10 shrink-0 items-center gap-2 border-b border-[var(--details-line)] pr-1.5 pl-3.5";

/** The search field itself. */
export const MENU_SEARCH_INPUT =
  "min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground";

/** The scrolling list: the card's section inset. */
export const MENU_LIST = "hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5";

/** A section's heading: the card's (`DetailsSection`). */
export const MENU_HEADING =
  "flex min-h-7 items-center px-2 text-2xs font-medium text-muted-foreground select-none";

/** One row: the card's `DetailsRow`, highlighted by pointer or keys. */
export const MENU_ITEM =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm font-medium text-secondary-foreground outline-none transition-colors duration-fast ease-out-strong hover:bg-element-hover hover:text-foreground data-highlighted:bg-element-hover data-highlighted:text-foreground";

/** The row that is the current choice. */
export const MENU_ITEM_SELECTED = "bg-element-selected text-foreground";

/** The line under an empty list. */
export const MENU_EMPTY = "px-2 py-3 text-center text-xs text-muted-foreground";
