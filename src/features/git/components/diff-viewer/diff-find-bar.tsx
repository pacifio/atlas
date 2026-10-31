import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { CodeViewDiffItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { ArrowDown, ArrowUp, CaseSensitive, Search, X } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  clearMatches,
  createPaintedRanges,
  findInDiff,
  firstMatchFrom,
  groupByFile,
  MAX_DIFF_FIND_MATCHES,
  paintMatches,
  rotateTo,
  type DiffFindMatch,
} from "../../lib/diff-find";

/**
 * ⌘F in the review diff: a query, a match count, previous and next.
 *
 * It searches the files' diff data (`diff-find.ts`), so a match in a folded
 * file or far outside the viewer's render window is found all the same; going
 * to one unfolds its file first. Everything a keystroke changes lives here,
 * not in the panel: typing re-renders this bar and nothing else, and the
 * search itself runs debounced, outside React's render, with the matches kept
 * in a ref. Painting touches only the rows the viewer has mounted.
 */

/** How long typing settles before the search runs. */
export const DIFF_FIND_DEBOUNCE_MS = 120;

export interface DiffFindHandle {
  /** Repaint the matches over whatever rows are mounted now. */
  repaint: () => void;
}

interface DiffFindBarProps {
  ref?: Ref<DiffFindHandle>;
  viewer: CodeViewHandle<unknown, undefined> | null;
  /** The viewer's items, as the panel gives them to it. */
  items: readonly CodeViewDiffItem<unknown>[];
  /** Unfold a file so a match in it can be shown. */
  onUnfold: (id: string) => void;
  onClose: () => void;
  /** Bumped to put the keyboard back in the query (⌘F while open). */
  focusRequest?: number;
  /** Files whose patch has not loaded yet: the viewer loads them as they
   *  scroll into view, and until then they hold no text to search. */
  unloaded?: number;
}

interface Results {
  query: string;
  matchCase: boolean;
  matches: DiffFindMatch[];
  byFile: Map<string, DiffFindMatch[]>;
  /** The fileDiffs searched, to tell a fold from new text. */
  searched: readonly unknown[];
  /** The file a capped search started from (it wraps round from there), so a
   *  re-search keeps the same window of matches. `null`: the first file. */
  startId: string | null;
}

const EMPTY: Results = {
  query: "",
  matchCase: false,
  matches: [],
  byFile: new Map(),
  searched: [],
  startId: null,
};

/** The file at the top of the viewport: the mounted one starting last at or
 *  above the scroll position. Mounted items come in no particular order. */
function topItemId(viewer: CodeViewHandle<unknown, undefined> | null): string | null {
  const instance = viewer?.getInstance();
  if (!instance) return null;
  const scrollTop = instance.getScrollTop();
  let above: { id: string; top: number } | null = null;
  let below: { id: string; top: number } | null = null;
  for (const item of instance.getRenderedItems()) {
    const top = instance.getTopForItem(item.id);
    if (top === undefined) continue;
    if (top <= scrollTop) {
      if (!above || top > above.top) above = { id: item.id, top };
    } else if (!below || top < below.top) below = { id: item.id, top };
  }
  return (above ?? below)?.id ?? null;
}

function sameMatch(a: DiffFindMatch, b: DiffFindMatch): boolean {
  return a.id === b.id && a.side === b.side && a.lineNumber === b.lineNumber && a.start === b.start;
}

export const DiffFindBar = memo(function DiffFindBar({
  ref,
  viewer,
  items,
  onUnfold,
  onClose,
  focusRequest = 0,
  unloaded = 0,
}: DiffFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  // What the count shows. The matches themselves stay in `results`.
  const [status, setStatus] = useState({ index: -1, total: 0, searched: false });

  const results = useRef<Results>(EMPTY);
  const index = useRef(-1);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  // Read through a ref: the panel's callback is rebuilt as files load, and a
  // new identity must not re-run the search (which would drop the match).
  const onUnfoldRef = useRef(onUnfold);
  onUnfoldRef.current = onUnfold;
  /** The ranges this bar has painted: only these are ever taken back. */
  const painted = useRef(createPaintedRanges());
  /** A match waiting for its file to arrive unfolded. */
  const pending = useRef<DiffFindMatch | null>(null);

  // ── Painting, coalesced to one per frame ──
  const frame = useRef(0);
  const paintNow = useCallback(() => {
    frame.current = 0;
    const instance = viewerRef.current?.getInstance();
    if (!instance) return;
    const { matches, byFile } = results.current;
    if (matches.length === 0) {
      clearMatches(painted.current);
      return;
    }
    const mounted = instance
      .getRenderedItems()
      .map((item) => ({ id: item.id, root: item.element.shadowRoot ?? item.element }));
    paintMatches(painted.current, mounted, byFile, matches[index.current] ?? null);
  }, []);
  const repaint = useCallback(() => {
    if (frame.current || results.current.matches.length === 0) return;
    frame.current = requestAnimationFrame(paintNow);
  }, [paintNow]);
  useImperativeHandle(ref, () => ({ repaint }), [repaint]);

  // Scrolling mounts other rows.
  useEffect(() => {
    const instance = viewer?.getInstance();
    if (!instance) return;
    return instance.subscribeToScroll(() => repaint());
  }, [viewer, repaint]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      clearMatches(painted.current);
    },
    [],
  );

  // ── Going to a match ──
  const show = useCallback(
    (match: DiffFindMatch) => {
      const item = itemsRef.current.find((i) => i.id === match.id);
      if (item?.collapsed) {
        pending.current = match;
        onUnfoldRef.current(match.id);
        return;
      }
      pending.current = null;
      viewerRef.current?.scrollTo({
        type: "line",
        id: match.id,
        lineNumber: match.lineNumber,
        side: match.side,
        align: "center",
      });
      repaint();
    },
    [repaint],
  );

  const select = useCallback(
    (next: number) => {
      const { matches } = results.current;
      index.current = next;
      setStatus((s) => ({ ...s, index: next, total: matches.length }));
      const match = matches[next];
      if (match) show(match);
    },
    [show],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const total = results.current.matches.length;
      if (total === 0) return;
      const from = index.current < 0 ? (dir > 0 ? -1 : 0) : index.current;
      select((from + dir + total) % total);
    },
    [select],
  );

  // ── Searching ──
  const run = useCallback(
    (text: string, caseSensitive: boolean, keep: boolean) => {
      const current = itemsRef.current;
      const previous = keep ? results.current.matches[index.current] : undefined;
      const query = { text, matchCase: caseSensitive };
      const top = keep ? null : topItemId(viewerRef.current);
      let startId = keep ? results.current.startId : null;
      let order = rotateTo(current, startId);
      let matches = findInDiff(order, query);
      // Capped: the matches near the viewer may be past the cap. Search again
      // from the file at the top of the viewer, wrapping round, so the first
      // match shown is near where the reader is.
      if (!keep && matches.length >= MAX_DIFF_FIND_MATCHES && top) {
        startId = top;
        order = rotateTo(current, top);
        matches = findInDiff(order, query);
      }
      results.current = {
        query: text,
        matchCase: caseSensitive,
        matches,
        byFile: groupByFile(matches),
        searched: current.map((i) => i.fileDiff),
        startId,
      };
      let next = -1;
      if (previous) next = matches.findIndex((m) => sameMatch(m, previous));
      if (next === -1 && !keep) {
        // Start from the file at the top of the viewer, not the first file.
        next = firstMatchFrom(
          matches,
          order.map((i) => i.id),
          top,
        );
      }
      index.current = next;
      setStatus({ index: next, total: matches.length, searched: text !== "" });
      if (matches.length === 0) clearMatches(painted.current);
      else if (!keep && matches[next]) show(matches[next]);
      else repaint();
    },
    [repaint, show],
  );

  // A keystroke only schedules the search. Keyed on the query alone, with
  // `run` read through a ref: nothing but typing may restart it.
  const runRef = useRef(run);
  runRef.current = run;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    timer.current = setTimeout(() => {
      timer.current = null;
      runRef.current(query, matchCase, false);
    }, DIFF_FIND_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [query, matchCase]);

  // New items: a fold only needs a repaint; new text needs the search again,
  // keeping the current match where it survives.
  useEffect(() => {
    const searched = results.current.searched;
    const same =
      searched.length === items.length && items.every((i, n) => i.fileDiff === searched[n]);
    if (!same && results.current.query) run(results.current.query, results.current.matchCase, true);
    const waiting = pending.current;
    if (waiting) {
      const item = items.find((i) => i.id === waiting.id);
      // The viewer takes its new items in its own effect, which runs first
      // (it is earlier in the tree); a frame later it has laid them out.
      if (item && !item.collapsed) requestAnimationFrame(() => show(waiting));
    } else repaint();
  }, [items, run, show, repaint]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const label =
    !status.searched || query === ""
      ? ""
      : status.total === 0
        ? "No results"
        : `${status.index + 1} of ${status.total >= MAX_DIFF_FIND_MATCHES ? `${MAX_DIFF_FIND_MATCHES}+` : status.total}`;

  return (
    <div
      role="search"
      aria-label="Find in diff"
      data-diff-find
      className="absolute top-2 right-3 z-panel flex h-control-lg items-center gap-0.5 rounded-md border border-border bg-popover py-1 pr-1 pl-2 shadow-md"
    >
      <Search size={12} className="shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Typed faster than the debounce: search now, once.
            if (results.current.query !== query || results.current.matchCase !== matchCase) {
              if (timer.current) clearTimeout(timer.current);
              timer.current = null;
              run(query, matchCase, false);
            } else step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in diff"
        aria-label="Find in diff"
        spellCheck={false}
        className="h-full w-44 min-w-0 bg-transparent px-1.5 font-sans text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span
        className="min-w-16 shrink-0 px-1 text-right text-xs text-muted-foreground tabular-nums"
        aria-live="polite"
      >
        {label}
      </span>
      {unloaded > 0 && label !== "" && (
        <Hint
          label={`${unloaded} ${unloaded === 1 ? "file hasn't" : "files haven't"} loaded yet and ${unloaded === 1 ? "isn't" : "aren't"} searched. Scroll to them, or open them from the tree.`}
        >
          <span className="shrink-0 pr-1 text-xs text-muted-foreground tabular-nums">
            +{unloaded} unloaded
          </span>
        </Hint>
      )}
      <Hint label="Match case">
        <IconButton
          size="sm"
          icon={CaseSensitive}
          label="Match case"
          aria-pressed={matchCase}
          onClick={() => setMatchCase((v) => !v)}
        />
      </Hint>
      <Hint label="Previous match (⇧↩)">
        <IconButton
          size="sm"
          icon={ArrowUp}
          label="Previous match"
          disabled={status.total === 0}
          onClick={() => step(-1)}
        />
      </Hint>
      <Hint label="Next match (↩)">
        <IconButton
          size="sm"
          icon={ArrowDown}
          label="Next match"
          disabled={status.total === 0}
          onClick={() => step(1)}
        />
      </Hint>
      <Hint label="Close (Esc)">
        <IconButton size="sm" icon={X} label="Close find" onClick={onClose} />
      </Hint>
    </div>
  );
});
