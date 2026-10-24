/**
 * Controls bound to one `config.toml` key: the value comes from the settings
 * store, and a change saves it. Rows use these instead of re-wiring
 * `updateSettings` by hand for every switch.
 */

import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Switch } from "@/ui/switch";
import { Select, type SelectOption } from "@/ui/select";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Slider } from "@/ui/slider";
import type { AppSettings, BooleanSettingKey } from "../../lib/app-settings";
import { settingMeta } from "../../lib/settings-sections";
import { useScopedSetting } from "../../lib/use-scoped-setting";

/** "Needs you: System notification", not just "System notification": one page
 *  can hold several rows with the same title, one per section, and a screen
 *  reader moving between controls hears only this name. */
function accessibleName(setting: keyof AppSettings): string {
  const meta = settingMeta(setting);
  return `${meta.section}: ${meta.title}`;
}

export function SettingSwitch({
  setting,
  disabled,
  onChange,
}: {
  setting: BooleanSettingKey;
  disabled?: boolean;
  /** Runs after the value is saved — for a side effect the store can't own. */
  onChange?: (next: boolean) => void;
}) {
  const scoped = useScopedSetting(setting);
  return (
    <Switch
      checked={scoped.value}
      disabled={disabled || scoped.globalOnly}
      aria-label={accessibleName(setting)}
      onCheckedChange={(next) => {
        scoped.set(next);
        onChange?.(next);
      }}
    />
  );
}

type EnumKey = {
  [K in keyof AppSettings]: AppSettings[K] extends string
    ? string extends AppSettings[K]
      ? never
      : K
    : never;
}[keyof AppSettings];

/** A select over an enum key's values; `options` gives each value its label. */
export function SettingSelect<K extends EnumKey>({
  setting,
  options,
  disabled,
}: {
  setting: K;
  options: readonly SelectOption<AppSettings[K] & string>[];
  disabled?: boolean;
}) {
  const scoped = useScopedSetting(setting);
  return (
    <Select
      value={scoped.value as AppSettings[K] & string}
      options={options}
      disabled={disabled || scoped.globalOnly}
      aria-label={accessibleName(setting)}
      onValueChange={(next) => scoped.set(next as AppSettings[K])}
    />
  );
}

type NumberKey = {
  [K in keyof AppSettings]: AppSettings[K] extends number ? K : never;
}[keyof AppSettings];

type TextKey = {
  [K in keyof AppSettings]: AppSettings[K] extends string
    ? string extends AppSettings[K]
      ? K
      : never
    : never;
}[keyof AppSettings];

/** A − n + stepper over an integer key, bounded by its registry `min`/`max`.
 *  `zeroLabel` names a 0 that means something other than a count ("Off"). */
export function SettingStepper({
  setting,
  unit = "",
  zeroLabel,
  disabled,
}: {
  setting: NumberKey;
  unit?: string;
  zeroLabel?: string;
  disabled?: boolean;
}) {
  const scoped = useScopedSetting(setting);
  const { min = -Infinity, max = Infinity } = settingMeta(setting);
  const value = scoped.value as number;
  const off = disabled || scoped.globalOnly;
  const name = accessibleName(setting);
  const step = (by: number) => scoped.set(Math.min(max, Math.max(min, value + by)));
  return (
    <div className="flex items-center gap-1">
      <IconButton
        icon={Minus}
        size="sm"
        variant="outline"
        label={`${name}: smaller`}
        shape="round"
        disabled={off || value <= min}
        onClick={() => step(-1)}
      />
      <span className="min-w-12 text-center text-xs tabular-nums" aria-live="polite">
        {value === 0 && zeroLabel ? (
          zeroLabel
        ) : (
          <>
            {value}
            {unit}
          </>
        )}
      </span>
      <IconButton
        icon={Plus}
        size="sm"
        variant="outline"
        label={`${name}: larger`}
        shape="round"
        disabled={off || value >= max}
        onClick={() => step(1)}
      />
    </div>
  );
}

/** A text field over a string key. Saves on Enter or when it loses focus,
 *  not per keystroke: every save rewrites `config.toml`. Escape reverts. */
export function SettingText({
  setting,
  placeholder,
  disabled,
}: {
  setting: TextKey;
  placeholder?: string;
  disabled?: boolean;
}) {
  const scoped = useScopedSetting(setting);
  const saved = scoped.value as string;
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => {
    if (draft.trim() !== saved) scoped.set(draft.trim());
  };
  return (
    <Input
      size="sm"
      className="w-56"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled || scoped.globalOnly}
      aria-label={accessibleName(setting)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(saved);
      }}
    />
  );
}

/** A multi-line text area over a string key, for prose (instructions). Saves
 *  when it loses focus or on ⌘↵, not per keystroke; Escape reverts. */
export function SettingTextarea({
  setting,
  placeholder,
  rows = 4,
  maxLength,
}: {
  setting: TextKey;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
}) {
  const scoped = useScopedSetting(setting);
  const saved = scoped.value as string;
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => {
    if (draft.trim() !== saved) scoped.set(draft.trim());
  };
  return (
    <textarea
      className="block w-full min-w-0 resize-y rounded-md border border-border bg-panel-input px-2 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-border-strong focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      value={draft}
      rows={rows}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={scoped.globalOnly}
      aria-label={accessibleName(setting)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.blur();
        if (event.key === "Escape") setDraft(saved);
      }}
    />
  );
}

/** A slider over an integer key, bounded by its registry `min`/`max`, with the
 *  value beside it. Saves once, on release; `onPreview` runs on every step of
 *  the drag, for a setting worth watching change (contrast). */
export function SettingSlider({
  setting,
  step = 1,
  unit = "",
  onPreview,
}: {
  setting: NumberKey;
  step?: number;
  unit?: string;
  onPreview?: (value: number) => void;
}) {
  const scoped = useScopedSetting(setting);
  const { min = 0, max = 100 } = settingMeta(setting);
  const saved = scoped.value as number;
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  return (
    <div className="flex w-full items-center gap-3 @min-[32rem]/settings-row:w-52">
      <output className="min-w-12 rounded-md bg-element-selected px-1.5 py-0.5 text-center font-mono text-2xs text-foreground tabular-nums">
        {draft}
        {unit}
      </output>
      <Slider
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={scoped.globalOnly}
        aria-label={accessibleName(setting)}
        onValueChange={(next) => {
          setDraft(next);
          onPreview?.(next);
        }}
        onValueCommitted={(next) => {
          if (next !== saved) scoped.set(next);
        }}
      />
    </div>
  );
}
