import { KbdCombo } from "atlas";

/** A glyph string is split so every modifier is its own cap and the
 *  remainder ("F", "Space") becomes one. */
export const Simple = () => <KbdCombo combo="⌘K" />;

export const ThreeModifiers = () => <KbdCombo combo="⌘⇧F" />;

export const WordRemainder = () => <KbdCombo combo="⌥Space" />;

export const KeybindingList = () => (
  <div className="flex w-[300px] flex-col gap-2">
    {[
      ["Command palette", "⌘K"],
      ["Find in pane", "⌘F"],
      ["Hint navigation", "⌘⌥Space"],
      ["Split view", "⌘\\"],
    ].map(([label, combo]) => (
      <div key={label} className="flex items-center justify-between text-[11.5px]">
        <span className="text-[var(--text-secondary)]">{label}</span>
        <KbdCombo combo={combo} />
      </div>
    ))}
  </div>
);
