import { useEffect, useMemo, useState } from "react";
import { Input, Popover, PopoverContent } from "@tryatlas/design";
import { cn } from "@/lib/utils";

interface IconPickerProps {
  value: string | null;
  anchorRect: DOMRect | null;
  onPick: (icon: string | null) => void;
  onClose: () => void;
}

/** Curated emoji grid for page icons. Three rows by topic so it stays
 *  short — full emoji-mart would be overkill for this slot. Users can
 *  type in any character via the free-form field at the bottom. */
const GROUPS: Array<{ label: string; emojis: string[] }> = [
  {
    label: "Documents",
    emojis: [
      "📄",
      "📝",
      "📖",
      "📕",
      "📗",
      "📘",
      "📙",
      "📚",
      "📓",
      "📔",
      "📋",
      "📑",
      "📰",
      "🗒️",
      "🗂️",
      "🗃️",
      "🗄️",
    ],
  },
  {
    label: "Symbols",
    emojis: [
      "✦",
      "✧",
      "✩",
      "✪",
      "✫",
      "★",
      "☆",
      "❖",
      "◆",
      "◇",
      "●",
      "○",
      "▲",
      "△",
      "■",
      "□",
      "▪",
      "▫",
    ],
  },
  {
    label: "Tech",
    emojis: [
      "💻",
      "🖥️",
      "⌨️",
      "🖱️",
      "💾",
      "💿",
      "🧠",
      "⚙️",
      "🔧",
      "🛠️",
      "🔩",
      "🧪",
      "🧬",
      "🧮",
      "📡",
      "🛰️",
    ],
  },
  {
    label: "Concepts",
    emojis: [
      "💡",
      "🔥",
      "⚡",
      "✨",
      "🌟",
      "🎯",
      "🚀",
      "🛸",
      "🌐",
      "🧭",
      "🗺️",
      "📌",
      "📍",
      "🎨",
      "🏗️",
      "🧱",
    ],
  },
  {
    label: "People",
    emojis: ["👤", "👥", "🧑‍💻", "🧑‍🔬", "🧑‍🏫", "🤖", "🦾", "💬", "🗣️", "💭"],
  },
  {
    label: "Time",
    emojis: ["📅", "🗓️", "⏰", "⏱️", "⏳", "🕰️", "📆"],
  },
];

/**
 * The page-icon picker: a popover anchored to the rect the caller measured
 * (the icon tile it was opened from). Base UI owns Escape, the outside press
 * and collision flipping; every pick and the Clear button close it.
 */
export function IconPicker({ value, anchorRect, onPick, onClose }: IconPickerProps) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => setDraft(value ?? ""), [value]);

  // A snapshot of the tile's rect: the popover doesn't follow the note when it
  // scrolls, as before.
  const anchor = useMemo(
    () => (anchorRect ? { getBoundingClientRect: () => anchorRect } : null),
    [anchorRect],
  );

  if (!anchor) return null;

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={6}
        data-view="icon-picker"
        className="w-[320px] max-h-[360px] overflow-y-auto p-2"
      >
        {GROUPS.map((g) => (
          <div key={g.label} className="mb-1.5">
            <div className="eyebrow px-1 pt-1 pb-0.5">{g.label}</div>
            <div className="grid grid-cols-8 gap-0.5">
              {g.emojis.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    onPick(e);
                    onClose();
                  }}
                  title={e}
                  aria-label={e}
                  aria-pressed={value === e}
                  className={cn(
                    "inline-flex h-[30px] items-center justify-center rounded-md text-xl leading-none",
                    "transition-colors duration-fast",
                    value === e ? "bg-element-active" : "hover:bg-element-hover",
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="mt-1.5 flex items-center gap-1.5 border-t border-border-subtle pt-2">
          <Input
            size="sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onPick(draft.trim() || null);
                onClose();
              }
            }}
            placeholder="Custom emoji or text…"
            aria-label="Custom icon"
            className="flex-1"
          />
          {value && (
            <button
              type="button"
              onClick={() => {
                onPick(null);
                onClose();
              }}
              className="px-1.5 text-xs text-muted-foreground hover:text-foreground"
              title="Remove icon"
            >
              clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
