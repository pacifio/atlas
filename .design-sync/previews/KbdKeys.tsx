import { KbdKeys } from "atlas";

/** The form `displayKeys` produces — one cap per glyph. */
export const Chord = () => <KbdKeys keys={["⌘", "⇧", "B"]} />;

export const SingleWordKey = () => <KbdKeys keys={["Esc"]} />;

export const Stacked = () => (
  <div className="flex flex-col gap-2">
    <KbdKeys keys={["⌘", "K"]} />
    <KbdKeys keys={["⌘", "⌥", "J"]} />
    <KbdKeys keys={["⌃", "Tab"]} />
  </div>
);

export const InAKeybindingRow = () => (
  <div className="flex w-[280px] items-center justify-between text-[11.5px]">
    <span className="text-[var(--text-secondary)]">Toggle session history</span>
    <KbdKeys keys={["⌘", "⌥", "J"]} />
  </div>
);
