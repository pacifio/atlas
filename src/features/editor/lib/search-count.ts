import type { EditorState } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";

/** Counting stops here; a capped count reads "10000+". */
export const SEARCH_COUNT_CAP = 10_000;

export interface SearchCount {
  /** Matches of the query, up to the cap. */
  total: number;
  capped: boolean;
  /** 1-based index of the match the selection sits on; 0 when on none. */
  current: number;
}

/** How many matches the search panel's query has, and which one is selected.
 *  Null with no query, or an invalid one. */
export function searchCount(state: EditorState, cap = SEARCH_COUNT_CAP): SearchCount | null {
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) return null;
  const { main } = state.selection;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (next.value.from === main.from && next.value.to === main.to) current = total;
    if (total >= cap) return { total, capped: true, current };
  }
  return { total, capped: false, current };
}

export function searchCountLabel(count: SearchCount | null): string {
  if (!count) return "";
  if (count.total === 0) return "No results";
  const total = count.capped ? `${count.total}+` : String(count.total);
  return count.current > 0 ? `${count.current} of ${total}` : `${total} matches`;
}

/**
 * Writes "3 of 12" into CodeMirror's own search panel, after the query
 * field. The panel is CodeMirror's; this only keeps one span in it current.
 */
export const searchCountPanel = ViewPlugin.fromClass(
  class {
    private span: HTMLSpanElement | null = null;
    constructor(private readonly view: EditorView) {
      this.schedule();
    }
    update(update: ViewUpdate) {
      const queryChanged = getSearchQuery(update.state) !== getSearchQuery(update.startState);
      if (
        update.docChanged ||
        update.selectionSet ||
        queryChanged ||
        searchPanelOpen(update.state) !== searchPanelOpen(update.startState)
      )
        this.schedule();
    }
    // The panel is drawn by another plugin in the same update; write after it.
    private schedule() {
      this.view.requestMeasure({
        read: (view) =>
          searchPanelOpen(view.state) ? searchCountLabel(searchCount(view.state)) : null,
        write: (label, view) => {
          if (label === null) return;
          const field = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=search]");
          if (!field) return;
          if (!this.span?.isConnected) {
            this.span = document.createElement("span");
            this.span.className = "mx-1 text-xs text-muted-foreground tabular-nums";
            this.span.dataset.searchCount = "";
            this.span.setAttribute("aria-live", "polite");
            field.after(this.span);
          }
          this.span.textContent = label;
        },
      });
    }
  },
);
