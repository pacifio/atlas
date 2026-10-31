// The ⌘K palette and ⌘P file search, as data: what the overlay shows, how a
// query filters and ranks it, and how the drill-in views stack.
//
// Everything here is pure, so the ranking and the view stack are tested
// without a DOM (`command-palette-logic.test.ts`). The components build the
// items (they hold the icons and the closures) and hand them to these
// functions; nothing here reads a store.

import type { ReactNode } from "react";
import type { ActionId } from "@/features/keybindings/lib/actions";

/** How many sessions the empty palette lists under "Recent Sessions". */
export const RECENT_SESSION_LIMIT = 12;

/** The two modes the one overlay shows: commands, or files. Project-contents
 *  search stays its own dialog (`search-overlay.tsx`). */
export type SearchOverlayMode = "command" | "files";

/** The overlay's own state: open or not, which mode, and — when files was
 *  opened from ⌘K's "Go to file" — the palette query to return to. */
export interface CommandPaletteUiState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  /** Set while a child search is open from the palette: Escape goes back. */
  readonly parentSearch?: CommandPaletteReturnContext;
  /** Set on the way back, so the palette reopens on the query it had. */
  readonly restoredSearch?: CommandPaletteReturnContext;
  /** A view the palette opens straight onto (⌘⇧O's project list, ⌘⇧N's
   *  "Add project" sources). */
  readonly initialView?: CommandPaletteInitialView;
  /** Bumped by every `OpenView`, so asking again for a view while the
   *  palette is already open still opens it (the palette remounts on it). */
  readonly initialViewRequest?: number;
}

/** The views the palette can be opened onto from outside it. */
export type CommandPaletteInitialView = "new-session-in" | "add-project";

export type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "ToggleMode"; readonly mode: SearchOverlayMode }
  | {
      readonly _tag: "OpenChildSearch";
      readonly mode: "files";
      readonly context: CommandPaletteReturnContext;
    }
  | { readonly _tag: "BackToCommand" }
  | { readonly _tag: "OpenView"; readonly view: CommandPaletteInitialView };

export const INITIAL_COMMAND_PALETTE_UI_STATE: CommandPaletteUiState = {
  open: false,
  mode: "command",
};

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      // Closing drops any return context, so the next open is a fresh one.
      return action.open ? { open: true, mode: "command" } : { open: false, mode: state.mode };
    case "ToggleMode":
      // The chord for the mode on screen closes it; any other one switches.
      return state.open && state.mode === action.mode
        ? { open: false, mode: state.mode }
        : { open: true, mode: action.mode };
    case "OpenChildSearch":
      return { open: true, mode: action.mode, parentSearch: action.context };
    case "OpenView":
      return {
        open: true,
        mode: "command",
        initialView: action.view,
        initialViewRequest: (state.initialViewRequest ?? 0) + 1,
      };
    case "BackToCommand":
      return state.open && state.mode !== "command" && state.parentSearch
        ? { open: true, mode: "command", restoredSearch: state.parentSearch }
        : state;
  }
}

/** One row the palette can run. */
export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  /** Unique within the list; the highlight is tracked by it. */
  readonly value: string;
  /** What a query matches, most important first: the first term is the
   *  title, and a match there ranks highest. */
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  /** The muted second line. */
  readonly description?: ReactNode;
  /** The age on the right of a session row ("1d ago"). */
  readonly timestamp?: string;
  /** Last activity, in ms: breaks a ranking tie toward the recent one. */
  readonly searchRecency?: number;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly titleLeadingContent?: ReactNode;
  readonly titleTrailingContent?: ReactNode;
  /** The action whose live chord shows on the right. */
  readonly shortcutAction?: ActionId;
  /** ⌘1–⌘9 picks this row while its list is on screen (a project list). */
  readonly jumpDigit?: number;
  /** Ranked after every non-secondary match. */
  readonly secondary?: boolean;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  /** The overlay stays open after it runs (it opens a child search). */
  readonly keepOpen?: boolean;
  readonly run: () => void | Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly placeholder?: string;
}

export type CommandPaletteEntry = CommandPaletteActionItem | CommandPaletteSubmenuItem;

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteEntry>;
}

/** A drill-in view: what a submenu row pushes. */
export interface CommandPaletteView {
  readonly value: string;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly placeholder?: string;
  /** The field's text on entering the view (a folder browser's `~/`). */
  readonly initialQuery?: string;
}

/** What a child search keeps of the palette it left: the query only. */
export interface CommandPaletteReturnContext {
  readonly query: string;
}

export interface CommandPaletteSearchState {
  readonly query: string;
  readonly views: ReadonlyArray<{
    readonly view: CommandPaletteView;
    readonly parentQuery: string;
  }>;
}

export function createCommandPaletteSearchState(query = ""): CommandPaletteSearchState {
  return { query, views: [] };
}

export function reduceCommandPaletteSearchState(
  state: CommandPaletteSearchState,
  action:
    | { readonly type: "query"; readonly query: string }
    | { readonly type: "push"; readonly view: CommandPaletteView }
    | { readonly type: "back" }
    | { readonly type: "reset"; readonly query?: string },
): CommandPaletteSearchState {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query };
    case "push":
      return {
        query: action.view.initialQuery ?? "",
        views: [...state.views, { view: action.view, parentQuery: state.query }],
      };
    case "back": {
      const parent = state.views[state.views.length - 1];
      return parent ? { query: parent.parentQuery, views: state.views.slice(0, -1) } : state;
    }
    case "reset":
      return createCommandPaletteSearchState(action.query);
  }
}

/** One row of the flat, virtualised list: a group's label or an item. */
export type CommandPaletteRow =
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: CommandPaletteEntry;
      /** Its place among the selectable items; `null` for a disabled one. */
      readonly itemIndex: number | null;
    };

/** Flatten the groups into rows, and index the selectable items so the
 *  keyboard can step over the labels and the disabled rows. */
export function buildCommandPaletteRows(groups: ReadonlyArray<CommandPaletteGroup>) {
  const rows: CommandPaletteRow[] = [];
  const itemValues: string[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    if (group.label) {
      rows.push({
        kind: "label",
        key: `group:${group.value}`,
        label: group.label,
        first: rows.length === 0,
      });
    }
    for (const item of group.items) {
      const itemIndex = item.disabled ? null : itemValues.length;
      if (itemIndex !== null) {
        itemValues.push(item.value);
        rowIndexByItemIndex.push(rows.length);
      }
      rows.push({ kind: "item", key: `${group.value}:${item.value}`, item, itemIndex });
    }
  }
  return { rows, itemValues, rowIndexByItemIndex };
}

export function findHighlightedCommandPaletteItem(
  groups: ReadonlyArray<CommandPaletteGroup>,
  highlightedItemValue: string | null,
): CommandPaletteEntry | null {
  if (highlightedItemValue === null) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.value === highlightedItemValue && !item.disabled) return item;
    }
  }
  return null;
}

/** The highlight one step from `current` through `values`, wrapping at the
 *  ends. With nothing highlighted, down starts at the top and up at the
 *  bottom. */
export function stepHighlight(
  values: ReadonlyArray<string>,
  current: string | null,
  step: 1 | -1,
): string | null {
  if (values.length === 0) return null;
  const index = current === null ? -1 : values.indexOf(current);
  if (index === -1) return step === 1 ? values[0]! : values[values.length - 1]!;
  return values[(index + step + values.length) % values.length]!;
}

/** Case- and accent-folded, whitespace-collapsed: what every match compares.
 *  Locale-free on purpose (a Turkish host must still match "GIT" to "git"). */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function rankSearchFieldMatch(
  field: string,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const normalizedField = normalizeSearchText(field);
  if (
    normalizedField.length === 0 ||
    !queryTokens.every((token) => normalizedField.includes(token))
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) return 3;
  if (normalizedField.startsWith(normalizedQuery)) return 2;
  if (normalizedField.includes(normalizedQuery)) return 1;
  return 0;
}

/** The first search term holding every query word decides the rank: an
 *  earlier term ranks higher, and within a term an exact match beats a
 *  prefix beats a substring. A session's title match ranks as one tier, so
 *  recency orders them. */
function rankCommandPaletteItemMatch(
  item: CommandPaletteEntry,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) return 0;
  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery, queryTokens);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      if (index === 0 && item.searchRecency !== undefined) {
        return 1_000 + Number(fieldRank === 3);
      }
      return 1_000 - index * 100 + fieldRank;
    }
  }
  return 0;
}

/**
 * The groups a query shows.
 *
 * Empty, the view's own groups. Typed, at the root: the Actions (and the
 * Atlas-only groups) filtered, then every project and every session that
 * matches — the recent-sessions group drops out, since the session search
 * covers it. A leading `>` narrows to commands only. Inside a submenu, only
 * that submenu's rows are searched.
 */
export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  sessionSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value !== RECENT_SESSIONS_GROUP);
    }
    return [...input.activeGroups];
  }
  const queryTokens = normalizedQuery.split(" ");

  const searchableGroups = input.isInSubmenu
    ? [...input.activeGroups]
    : input.activeGroups.filter((group) => group.value !== RECENT_SESSIONS_GROUP);
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.sessionSearchItems.length > 0) {
      searchableGroups.push({
        value: "sessions-search",
        label: "Sessions",
        items: input.sessionSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .flatMap((item, index) => {
        const haystack = normalizeSearchText(item.searchTerms.join(" "));
        if (!queryTokens.every((token) => haystack.includes(token))) return [];
        return [
          { item, index, rank: rankCommandPaletteItemMatch(item, normalizedQuery, queryTokens) },
        ];
      })
      .sort(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
          right.rank - left.rank ||
          (right.item.searchRecency ?? 0) - (left.item.searchRecency ?? 0) ||
          left.index - right.index,
      )
      .map((entry) => entry.item);
    return items.length === 0 ? [] : [{ value: group.value, label: group.label, items }];
  });
}

export const ACTIONS_GROUP = "actions";
export const RECENT_SESSIONS_GROUP = "recent-sessions";

/** The empty palette: Actions, then the recent sessions, then the
 *  Atlas-only groups (tabs, layout, splits) that the reference app has no
 *  counterpart for. */
export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteEntry>;
  recentSessionItems: ReadonlyArray<CommandPaletteActionItem>;
  extraGroups?: ReadonlyArray<CommandPaletteGroup>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: ACTIONS_GROUP, label: "Actions", items: input.actionItems });
  }
  if (input.recentSessionItems.length > 0) {
    groups.push({
      value: RECENT_SESSIONS_GROUP,
      label: "Recent Sessions",
      items: input.recentSessionItems,
    });
  }
  for (const group of input.extraGroups ?? []) {
    if (group.items.length > 0) groups.push(group);
  }
  return groups;
}

export const ROOT_PLACEHOLDER = "Search commands, projects, and sessions…";

export function commandPaletteEmptyMessage(isActionsOnly: boolean): string {
  return isActionsOnly ? "No matching actions." : "No matching commands, projects, or sessions.";
}

/** Number the first nine rows ⌘1–⌘9, in the order they are listed. */
export function enumerateCommandPaletteItems<T extends CommandPaletteItem>(
  items: ReadonlyArray<T>,
): T[] {
  return items.map((item, index) => (index < 9 ? { ...item, jumpDigit: index + 1 } : item));
}
