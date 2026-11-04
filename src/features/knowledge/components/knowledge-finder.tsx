//! Cmd+F finder for the Knowledge Base — a simple TITLE-only search across all
//! entries (lowercased query + lowercased title, plain substring match — no
//! content scan, which produced noisy/inaccurate hits). A floating bar pinned
//! to the top of the editor column; Esc / click-away closes, ↑/↓ + Enter
//! navigate, click opens a result.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@tryatlas/design";

interface FinderEntry {
  id: string;
  title: string;
  icon?: string | null;
}

interface Result {
  id: string;
  title: string;
  icon: string;
}

const MAX_RESULTS = 50;

export function KnowledgeFinder({
  entries,
  onSelect,
  onClose,
}: {
  entries: FinderEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const results = useMemo<Result[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: Result[] = [];
    for (const e of entries) {
      if (!e.title.toLowerCase().includes(s)) continue;
      out.push({ id: e.id, title: e.title || "Untitled", icon: e.icon || "📄" });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [q, entries]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  const choose = (i: number) => {
    const r = results[i];
    if (r) {
      onSelect(r.id);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="absolute left-1/2 top-3 z-popover w-[460px] max-w-[90%] -translate-x-1/2">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-md">
        <div className="flex items-center gap-2 px-3 h-9 border-b border-border-subtle">
          <Search size={13} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find notes by title…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
          {q && (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {results.length}
              {results.length >= MAX_RESULTS ? "+" : ""}
            </span>
          )}
          <Hint label="Close" shortcut="Esc">
            <button
              onClick={onClose}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-element-hover cursor-pointer"
            >
              <X size={12} />
            </button>
          </Hint>
        </div>
        {q.trim() && (
          <div className="max-h-[340px] overflow-y-auto hide-scrollbar py-1">
            {results.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">No matches</div>
            ) : (
              results.map((r, i) => (
                <button
                  key={r.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                    i === active ? "bg-element-hover" : "hover:bg-element-hover/60",
                  )}
                >
                  <span className="shrink-0 text-base leading-none">{r.icon}</span>
                  <span className="truncate text-sm font-medium text-foreground">{r.title}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
