import { useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Search, Smile } from "lucide-react";
import { HintItem } from "@/ui/hint-group";
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
      <HintItem label="Emoji">
        <Popover.Trigger
          render={
            <button
              type="button"
              // Keeps the textarea selection alive so the emoji lands where the
              // caret was, not at the end.
              onMouseDown={(e) => e.preventDefault()}
              // The composer bar's button (`BAR_BUTTON` in comms-composer).
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground"
            >
              <Smile size={17} />
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-modal" side="top" align="end" sideOffset={8}>
          <Popover.Popup
            // Radix's onOpenAutoFocus + preventDefault + focus() is one
            // Base UI prop: hand initialFocus the element to land on.
            initialFocus={searchRef}
            className="w-[292px] rounded-lg border border-border bg-popover shadow-md origin-[var(--transform-origin)] animate-scale-in"
          >
            <div className="border-b border-border p-1.5">
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-panel-input px-2 py-1 focus-within:border-border-strong">
                <Search size={11} className="shrink-0 text-disabled" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(ev) => setQuery(ev.target.value)}
                  placeholder="Search emoji…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-disabled"
                />
              </div>
            </div>

            <div className="max-h-[240px] overflow-y-auto hide-scrollbar p-1.5">
              {searching ? (
                results.length ? (
                  <Grid entries={results.map((r) => r.char)} onPick={pick} />
                ) : (
                  <div className="px-1 py-6 text-center text-xs text-muted-foreground">
                    No emoji matches “{query.trim()}”.
                  </div>
                )
              ) : (
                EMOJI_CATEGORIES.map((cat) => (
                  <div key={cat.name} className="mb-1.5 last:mb-0">
                    <div className="px-1 pb-1 pt-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                      {cat.name}
                    </div>
                    <Grid entries={cat.emoji.map((x) => x.char)} onPick={pick} />
                  </div>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
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
          className="flex h-control-lg items-center justify-center rounded text-lg leading-none transition-colors hover:bg-element-hover cursor-pointer"
        >
          {char}
        </button>
      ))}
    </div>
  );
}
