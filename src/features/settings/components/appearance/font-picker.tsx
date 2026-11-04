/**
 * Pick a font from the ones installed, each drawn in itself — not typed from
 * memory.
 *
 * The list is the machine's own (`fonts-api.ts`), read again every time the
 * picker opens, so a font installed from Google Fonts a minute ago is there.
 * First comes the default ("System font", "Same as code", …), last a way to
 * write a fallback list by hand, which `config.toml` has always taken and
 * still does: "Berkeley Mono, SF Mono" is a list, not a font, so it is shown
 * as one and edited as text.
 *
 * A picker for code or the terminal lists every font but refuses one that is
 * not fixed-width, with a toast saying why: hiding them
 * would make a font you know you have look missing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { AlertTriangle, Check, ChevronDown, ExternalLink, PenLine, Search } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { cssFamily, listFontFamilies, parseFontValue, type FontFamily } from "../../lib/fonts-api";
import { Icon, Input, Hint } from "@tryatlas/design";

const DEFAULT_ITEM = "\u0000default";
const GOOGLE_FONTS = "https://fonts.google.com";

/** One read shared by every picker on the page; `refresh` replaces it. */
let shared: Promise<FontFamily[]> | null = null;
const readFamilies = (refresh = false) => {
  if (refresh || !shared) shared = listFontFamilies();
  return shared;
};

export function FontPicker({
  value,
  onChange,
  defaultLabel,
  defaultFamily,
  themeFamily,
  monospace = false,
  label,
}: {
  /** The setting's CSS font-family list; empty is the default. */
  value: string;
  onChange: (next: string) => void;
  /** What the default is called: "System font", "Same as code". */
  defaultLabel: string;
  /** The CSS family the default item is drawn in. */
  defaultFamily: string;
  /** The first family of the theme's font, when the default comes from the
   *  theme: checked like a chosen font, so an uninstalled one is flagged. */
  themeFamily?: string;
  /** Refuse a font that is not fixed-width. */
  monospace?: boolean;
  /** The accessible name. */
  label: string;
}) {
  const [families, setFamilies] = useState<FontFamily[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const parsed = parseFontValue(value);

  useEffect(() => {
    let live = true;
    void readFamilies().then((list) => live && setFamilies(list));
    return () => {
      live = false;
    };
  }, []);

  const byName = useMemo(() => new Map(families.map((f) => [f.name, f])), [families]);
  const items = useMemo(() => [DEFAULT_ITEM, ...families.map((f) => f.name)], [families]);
  const selected = parsed.kind === "family" ? parsed.family : DEFAULT_ITEM;
  // Only worth saying once there is a list to have looked in. A theme's font
  // is the usual case: tweakcn themes name Google Fonts nobody has installed.
  const wanted =
    parsed.kind === "family" ? parsed.family : parsed.kind === "default" ? themeFamily : undefined;
  const missing = wanted !== undefined && families.length > 0 && !byName.has(wanted);

  const pick = (item: string | null) => {
    if (item === null) return;
    if (item === DEFAULT_ITEM) return onChange("");
    if (monospace && byName.get(item)?.monospace === false) {
      toast.error(`“${item}” isn't monospace`, {
        description: "Code and the terminal need a fixed-width font, so the current one was kept.",
      });
      return;
    }
    onChange(cssFamily(item));
  };

  if (editing) {
    return (
      <CustomListInput
        value={value}
        label={label}
        onDone={(next) => {
          setEditing(false);
          if (next !== null && next !== value) onChange(next);
        }}
      />
    );
  }

  const shown =
    parsed.kind === "default"
      ? defaultLabel
      : parsed.kind === "family"
        ? parsed.family
        : parsed.families.join(", ");
  const shownFamily =
    parsed.kind === "default" ? defaultFamily : `${value.trim()}, ${defaultFamily}`;

  return (
    <Combobox.Root
      items={items}
      value={selected}
      onValueChange={(next) => pick(next as string | null)}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void readFamilies(true).then(setFamilies);
      }}
      itemToStringLabel={(item: string) => (item === DEFAULT_ITEM ? defaultLabel : item)}
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={label}
        className={cn(
          "flex h-control-md w-48 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-panel-input px-2",
          "text-xs text-foreground outline-none select-none",
          "transition-colors duration-fast ease-out-strong hover:border-border-strong",
          "focus-visible:border-border-strong data-popup-open:bg-element-active",
        )}
      >
        {missing && (
          <Hint
            label={
              parsed.kind === "default"
                ? `Your theme uses ${wanted}, which isn't installed. Get it from Google Fonts, or pick another.`
                : `${wanted} isn't installed, so the default is showing.`
            }
          >
            <span className="flex text-warning">
              <Icon icon={AlertTriangle} size="sm" />
            </span>
          </Hint>
        )}
        <span className="min-w-0 flex-1 truncate text-left" style={{ fontFamily: shownFamily }}>
          {shown}
        </span>
        <Icon icon={ChevronDown} size="sm" className="text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner className="isolate z-popover outline-none" sideOffset={4} align="end">
          <Combobox.Popup
            className={cn(
              "flex max-h-(--available-height) w-72 flex-col overflow-hidden rounded-lg",
              "border border-border bg-popover text-foreground shadow-md outline-none",
              "origin-[var(--transform-origin)] animate-scale-in",
            )}
          >
            <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border-subtle px-2.5">
              <Icon icon={Search} size="sm" className="text-muted-foreground" />
              <Combobox.Input
                placeholder="Search fonts"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-disabled"
              />
            </div>
            <Combobox.Empty className="px-3 py-4 text-center text-xs text-muted-foreground empty:hidden">
              {families.length === 0
                ? "Atlas couldn't list this computer's fonts. Write a font list instead."
                : "No installed font matches."}
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto p-0.5 empty:hidden">
              {(item: string) => {
                const isDefault = item === DEFAULT_ITEM;
                const family = isDefault ? undefined : byName.get(item);
                return (
                  <Combobox.Item
                    key={item}
                    value={item}
                    className={cn(
                      "flex h-control-lg cursor-pointer items-center gap-2 rounded px-2 text-sm outline-none select-none",
                      "text-secondary-foreground data-highlighted:bg-element-hover data-highlighted:text-foreground",
                      // Each row loads its own font to draw itself; off-screen
                      // rows skip layout, so a long list opens without loading
                      // every font on the machine at once.
                      "[contain-intrinsic-size:auto_32px] [content-visibility:auto]",
                    )}
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      style={{
                        fontFamily: isDefault
                          ? defaultFamily
                          : `${cssFamily(item)}, ${defaultFamily}`,
                      }}
                    >
                      {isDefault ? defaultLabel : item}
                    </span>
                    {isDefault && <span className="text-2xs text-muted-foreground">default</span>}
                    {monospace && family?.monospace === false && (
                      <span className="text-2xs text-disabled">proportional</span>
                    )}
                    <Combobox.ItemIndicator className="flex text-muted-foreground">
                      <Icon icon={Check} size="sm" />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle p-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setEditing(true);
                }}
                className="flex h-control-sm cursor-pointer items-center gap-1.5 rounded px-1.5 text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground"
              >
                <Icon icon={PenLine} size="xs" />
                Custom font list…
              </button>
              <button
                type="button"
                onClick={() => void openUrl(GOOGLE_FONTS)}
                className="flex h-control-sm cursor-pointer items-center gap-1.5 rounded px-1.5 text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground"
              >
                Get more fonts
                <Icon icon={ExternalLink} size="xs" />
              </button>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

/** A font list written by hand: Enter or leaving the field saves, Escape
 *  goes back without saving. */
function CustomListInput({
  value,
  label,
  onDone,
}: {
  value: string;
  label: string;
  onDone: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // Escape unmounts the field, and its blur must not then save the draft.
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  useEffect(() => ref.current?.focus(), []);
  return (
    <Input
      ref={ref}
      value={draft}
      aria-label={`${label}: font list`}
      placeholder="Berkeley Mono, SF Mono, monospace"
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(draft.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(draft.trim());
        if (event.key === "Escape") finish(null);
      }}
      className="w-48"
    />
  );
}
