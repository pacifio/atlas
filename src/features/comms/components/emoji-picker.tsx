import { useMemo, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { BAR_BUTTON } from "./views/comms-composer-parts";
import { Search, Smile } from "lucide-react";
import { EMOJI_CATEGORIES, searchEmoji } from "../lib/emoji-data";
import { HintItem, Popover, PopoverContent, PopoverTrigger } from "@tryatlas/design";

/**
 * The composer's emoji button.
 *
 * Distinct from the reaction picker on purpose: a *reaction* must come from the
 * server's `CHAT_REACTION_EMOJI` allowlist or the frame is refused, whereas
 * message text can contain any emoji at all. So this one is searchable and
 * broad, and it inserts into the draft rather than sending a frame.
 *
 * Reads no store: the composer view renders it and hands it `onPick`; it
 * owns only its own open state and search query.
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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <HintItem label="Emoji">
        <PopoverTrigger
          render={
            <BarButton
              aria-label="Emoji"
              // Keeps the editor's selection alive so the emoji lands where the
              // caret was, not at the end.
              onMouseDown={(e) => e.preventDefault()}
            >
              <Smile size={17} />
            </BarButton>
          }
        />
      </HintItem>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        // Hand initialFocus the element to land on: the search field.
        initialFocus={searchRef}
        className="w-[292px] p-0"
      >
        <div className="border-b border-border p-1.5">
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-panel-input px-2 py-1 focus-within:border-border-strong">
            <Search size={11} className="shrink-0 text-disabled" />
            <input
              ref={searchRef}
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              placeholder="Search emoji…"
              aria-label="Search emoji"
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
      </PopoverContent>
    </Popover>
  );
}

/** The composer bar's button (`BAR_BUTTON` in `views/comms-composer-parts.tsx`),
 *  as a component so the trigger can render it. */
function BarButton(props: ComponentProps<"button">) {
  return <button type="button" {...props} className={cn(BAR_BUTTON, props.className)} />;
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
