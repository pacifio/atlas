import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, Search, X } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  MAX_PLAIN_FIND_MATCHES,
  findInText,
  firstMatchAtOrAfter,
  releasePlainFindCache,
  type PlainFindMatch,
} from "../lib/plain-find";

/**
 * ⌘F in a file tab whose editor cannot open its own find panel: a read-only
 * large file, or one whose editor has not attached yet. It searches the
 * file's plain text (`plain-find.ts`) and goes to a match by revealing it in
 * the code view, which scrolls to it, tints its line and selects it where
 * there is an editor to select in.
 */

/** How long typing settles before the search runs. */
const FIND_DEBOUNCE_MS = 120;

interface FileFindBarProps {
  /** The text to search, read when a search runs. */
  getText: () => string;
  /** The cursor's line, where the first match shown is looked for from. */
  startLine: () => number;
  onGo: (match: PlainFindMatch) => void;
  onClose: () => void;
  /** Bumped to put the keyboard back in the query (⌘F while open). */
  focusRequest: number;
}

export function FileFindBar({ getText, startLine, onGo, onClose, focusRequest }: FileFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [state, setState] = useState<{ matches: PlainFindMatch[]; index: number; ran: string }>({
    matches: [],
    index: -1,
    ran: "",
  });
  const latest = useRef({ getText, startLine, onGo });
  latest.current = { getText, startLine, onGo };

  useEffect(() => {
    const timer = setTimeout(() => {
      const { getText, startLine, onGo } = latest.current;
      const matches = findInText(getText(), query, matchCase);
      const index = firstMatchAtOrAfter(matches, startLine());
      setState({ matches, index, ran: query });
      if (index >= 0) {
        onGo(matches[index]);
        // The reveal can focus the editor; typing stays in the query.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, matchCase]);

  useEffect(() => releasePlainFindCache, []);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const step = (dir: 1 | -1) => {
    const total = state.matches.length;
    if (total === 0) return;
    const index = (Math.max(state.index, dir > 0 ? -1 : 0) + dir + total) % total;
    setState((s) => ({ ...s, index }));
    onGo(state.matches[index]);
    // The reveal focuses the editor; the query keeps the keyboard.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const total = state.matches.length;
  const label =
    query === "" || state.ran !== query
      ? ""
      : total === 0
        ? "No results"
        : `${state.index + 1} of ${total >= MAX_PLAIN_FIND_MATCHES ? `${MAX_PLAIN_FIND_MATCHES}+` : total}`;

  return (
    <div
      role="search"
      aria-label="Find in file"
      data-file-find
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
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in file"
        aria-label="Find in file"
        spellCheck={false}
        className="h-full w-44 min-w-0 bg-transparent px-1.5 font-sans text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span
        className="min-w-16 shrink-0 px-1 text-right text-xs text-muted-foreground tabular-nums"
        aria-live="polite"
      >
        {label}
      </span>
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
          disabled={total === 0}
          onClick={() => step(-1)}
        />
      </Hint>
      <Hint label="Next match (↩)">
        <IconButton
          size="sm"
          icon={ArrowDown}
          label="Next match"
          disabled={total === 0}
          onClick={() => step(1)}
        />
      </Hint>
      <Hint label="Close (Esc)">
        <IconButton size="sm" icon={X} label="Close find" onClick={onClose} />
      </Hint>
    </div>
  );
}
