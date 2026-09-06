import { Kbd, KbdGroup, KbdKeys, KbdCombo } from "atlas";

export const SingleKey = () => (
  <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
    <span>Open the command palette</span>
    <Kbd>K</Kbd>
  </div>
);

export const ShortcutRow = () => (
  <div className="flex flex-col gap-2">
    {[
      ["Command palette", "⌘K"],
      ["New chat tab", "⌘T"],
      ["Split editor", "⌘\\"],
      ["Hint navigation", "⌘⌥Space"],
    ].map(([label, combo]) => (
      <div key={label} className="flex items-center justify-between gap-6 text-[11.5px]">
        <span className="text-[var(--text-secondary)]">{label}</span>
        <KbdCombo combo={combo} />
      </div>
    ))}
  </div>
);

export const KeyList = () => (
  <div className="flex items-center gap-3">
    <KbdKeys keys={["⌘", "⇧", "P"]} />
    <KbdKeys keys={["⌥", "/"]} />
    <KbdKeys keys={["Esc"]} />
  </div>
);

export const InGroup = () => (
  <KbdGroup>
    <Kbd>⌘</Kbd>
    <Kbd>⇧</Kbd>
    <Kbd>F</Kbd>
  </KbdGroup>
);
