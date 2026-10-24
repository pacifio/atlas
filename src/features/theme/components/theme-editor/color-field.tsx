/**
 * One colour slot in the theme editor: a swatch that opens the picker, and a
 * hex field. Atlas's format adds one thing: a slot the theme does not set shows what it DERIVES
 * to (ADR-0022), dimmed, and a set slot can be cleared to follow again.
 */

import { memo, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ColorHueSlider, ColorSaturationValuePlane } from "@/ui/color-picker";
import { Icon } from "@/ui/icon";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Hint } from "@/ui/tooltip";
import { colorToCss, hsvToHex, parseColor, toHsv, type HsvColor } from "../../color";

/** `#rrggbb` for anything `parseColor` reads, alpha dropped: what the picker
 *  edits. A colour with alpha keeps it (`alphaOf`) and gets it back on save. */
function opaqueHex(value: string): string {
  const color = parseColor(value);
  // ratchet-allow: the picker needs some concrete point to start from when a
  // slot's value is unreadable; it is a picker position, never painted UI.
  return color ? colorToCss({ ...color, a: 1 }) : "#000000";
}

function alphaOf(value: string): number {
  return parseColor(value)?.a ?? 1;
}

function withAlphaOf(hex: string, alpha: number): string {
  const color = parseColor(hex);
  return color && alpha < 1 ? colorToCss({ ...color, a: alpha }) : hex;
}

const rgbOf = (hex: string) => {
  const color = parseColor(hex);
  return color ? `${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}` : "";
};

function PickerPanel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const normalized = opaqueHex(value);
  const alpha = alphaOf(value);
  const [hsv, setHsv] = useState<HsvColor>(() => toHsv(normalized));
  const [hexDraft, setHexDraft] = useState(normalized);
  const [rgbDraft, setRgbDraft] = useState(() => rgbOf(normalized));
  const [editingText, setEditingText] = useState(false);
  const [synced, setSynced] = useState(normalized);
  const current = hsvToHex(hsv);

  if (synced !== normalized) {
    setSynced(normalized);
    if (!editingText) {
      setHexDraft(normalized);
      setRgbDraft(rgbOf(normalized));
    }
    // Our own change echoed back keeps its hue: hex → HSV is lossy for greys.
    if (current !== normalized) setHsv(toHsv(normalized));
  }

  // The thumb moves every pointer event; the commit — which re-resolves and
  // repaints the whole app — happens at most once a frame, and the last one
  // is never lost to a closing popover.
  // A stable-callback ref: the latest `onChange`, callable from a frame.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const commit = (color: string) => onChangeRef.current(color);
  const pending = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  const flush = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null) onChangeRef.current(next);
  };
  // Only refs inside, so the first render's `flush` is as good as any.
  useEffect(() => () => flush(), []);
  const schedule = (color: string) => {
    pending.current = color;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      pending.current = null;
      if (next !== null) commit(next);
    });
  };

  const setFromHsv = (next: HsvColor) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexDraft(hex);
    setRgbDraft(rgbOf(hex));
    schedule(withAlphaOf(hex, alpha));
  };

  const setFromText = (hex: string | null) => {
    if (!hex) return;
    setHsv(toHsv(hex));
    onChange(withAlphaOf(hex, alpha));
  };

  const textField = (field: "hex" | "rgb") => (
    <label className="grid min-w-0 gap-1">
      <span className="px-1 text-2xs font-medium uppercase text-muted-foreground">{field}</span>
      <Input
        size="sm"
        className="font-mono"
        aria-label={`${label} ${field}`}
        spellCheck={false}
        value={field === "hex" ? hexDraft : rgbDraft}
        onFocus={() => setEditingText(true)}
        onBlur={() => {
          setEditingText(false);
          setHexDraft(current);
          setRgbDraft(rgbOf(current));
        }}
        onChange={(event) => {
          const text = event.currentTarget.value;
          if (field === "hex") {
            setHexDraft(text);
            if (/^#[0-9a-f]{6}$/i.test(text)) {
              setRgbDraft(rgbOf(text));
              setFromText(text.toLowerCase());
            }
          } else {
            setRgbDraft(text);
            const channels = text
              .split(/[,\s]+/)
              .filter(Boolean)
              .map(Number);
            const valid =
              channels.length === 3 &&
              channels.every((c) => Number.isInteger(c) && c >= 0 && c <= 255);
            if (valid) {
              const hex = colorToCss({ r: channels[0], g: channels[1], b: channels[2], a: 1 });
              setHexDraft(hex);
              setFromText(hex);
            }
          }
        }}
      />
    </label>
  );

  return (
    <div className="grid gap-3" data-theme-editor-panel>
      <div className="flex items-center justify-between">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        <span
          className="size-6 shrink-0 rounded-full border border-border-subtle"
          style={{ backgroundColor: current }}
        />
      </div>
      <ColorSaturationValuePlane
        label={label}
        value={hsv}
        onChange={setFromHsv}
        onInteractionEnd={flush}
      />
      <ColorHueSlider
        label={`${label} hue`}
        value={hsv.h}
        onChange={(h) => setFromHsv({ ...hsv, h })}
        onInteractionEnd={flush}
      />
      <div className="grid grid-cols-[1fr_1.2fr] gap-2">
        {textField("hex")}
        {textField("rgb")}
      </div>
    </div>
  );
}

export const ColorField = memo(function ColorField({
  label,
  description,
  value,
  written,
  onChange,
  onReset,
}: {
  label: string;
  description: string;
  /** What the slot resolves to: the written value, or the derived one. */
  value: string;
  /** The theme sets this slot itself, rather than deriving it. */
  written: boolean;
  onChange: (value: string) => void;
  /** Clear the slot so it derives again. */
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (written ? value : "");

  return (
    <div className="flex min-h-9 min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
      <Hint label={description}>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            written ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      </Hint>
      <div className="flex shrink-0 items-center gap-1.5">
        {written ? (
          <Hint label="Derive it again">
            <button
              type="button"
              aria-label={`Derive ${label} again`}
              onClick={onReset}
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground"
            >
              <Icon icon={RotateCcw} size="xs" />
            </button>
          </Hint>
        ) : null}
        <Popover>
          {/* The trigger is the hit area; the swatch it opens from is drawn
              by the span inside it. */}
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={`Choose ${label}`}
                className="group/swatch relative size-5 shrink-0 cursor-pointer"
              />
            }
          >
            <span
              className="block size-full rounded-full border border-border-strong transition-transform duration-fast group-hover/swatch:scale-105"
              style={{ backgroundColor: value }}
            />
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" sideOffset={8} className="w-64 p-3">
            <PickerPanel label={label} value={value} onChange={onChange} />
          </PopoverContent>
        </Popover>
        <Input
          size="sm"
          className="w-24 font-mono"
          aria-label={`${label} value`}
          aria-invalid={draft !== null && draft !== "" && !parseColor(draft)}
          spellCheck={false}
          placeholder={written ? undefined : opaqueHex(value)}
          value={shown}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft(text);
            if (parseColor(text)) onChange(text.trim());
          }}
          onBlur={() => setDraft(null)}
        />
      </div>
    </div>
  );
});
