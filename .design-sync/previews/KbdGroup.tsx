import { Kbd, KbdGroup } from "atlas";

export const Chord = () => (
  <KbdGroup>
    <Kbd>⌘</Kbd>
    <Kbd>⇧</Kbd>
    <Kbd>P</Kbd>
  </KbdGroup>
);

export const TwoKeys = () => (
  <KbdGroup>
    <Kbd>⌥</Kbd>
    <Kbd>/</Kbd>
  </KbdGroup>
);

export const WordKeys = () => (
  <KbdGroup>
    <Kbd>⌘</Kbd>
    <Kbd>⌥</Kbd>
    <Kbd>Space</Kbd>
  </KbdGroup>
);

export const InlineWithLabel = () => (
  <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
    <span>Switch agent</span>
    <KbdGroup>
      <Kbd>⌥</Kbd>
      <Kbd>/</Kbd>
    </KbdGroup>
  </div>
);
