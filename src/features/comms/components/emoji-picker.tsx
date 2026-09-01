import { useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Search, Smile } from "lucide-react";
import { EMOJI_CATEGORIES, searchEmoji } from "../lib/emoji-data";

/**
 * The composer's emoji button.
 *
 * Distinct from the reaction picker on purpose: a *reaction* must come from the
 * server's `CHAT_REACTION_EMOJI` allowlist or the frame is refused, whereas
 * message text can contain any emoji at all. So this one is searchable and
 * broad, and it inserts into the draft rather than sending a frame.
 */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;

  const pick = (char: string) => {
    onPick(char);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Emoji"
          // Keeps the textarea selection alive so the emoji lands where the
          // caret was, not at the end.
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          <Smile size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            searchRef.current?.focus();
          }}
          className="z-[var(--z-modal)] w-[292px] rounded-lg border border-border-default bg-bg-overlay shadow-[var(--shadow-overlay)] animate-scale-in"
        >
          <div className="border-b border-border-default p-1.5">
            <div className="flex items-center gap-1.5 rounded-md border border-border-default bg-bg-input px-2 py-1 focus-within:border-border-focus">
              <Search size={11} className="shrink-0 text-text-ghost" />
              <input
                ref={searchRef}
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
                placeholder="Search emoji…"
                className="min-w-0 flex-1 bg-transparent text-[11.5px] text-text-primary outline-none placeholder:text-text-ghost"
              />
            </div>
          </div>

          <div className="max-h-[240px] overflow-y-auto hide-scrollbar p-1.5">
            {searching ? (
              results.length ? (
                <Grid entries={results.map((r) => r.char)} onPick={pick} />
              ) : (
                <div className="px-1 py-6 text-center text-[11px] text-text-tertiary">
                  No emoji matches “{query.trim()}”.
                </div>
              )
            ) : (
              EMOJI_CATEGORIES.map((cat) => (
                <div key={cat.name} className="mb-1.5 last:mb-0">
                  <div className="px-1 pb-1 pt-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
                    {cat.name}
                  </div>
                  <Grid entries={cat.emoji.map((x) => x.char)} onPick={pick} />
                </div>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Grid({ entries, onPick }: { entries: string[]; onPick: (c: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {entries.map((char, i) => (
        <button
          key={`${char}-${i}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(char)}
          className="flex h-[30px] items-center justify-center rounded text-[16px] leading-none transition-colors hover:bg-bg-hover cursor-pointer"
        >
          {char}
        </button>
      ))}
    </div>
  );
}
