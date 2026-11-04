// Floating slash-command picker. Same architecture as `mention-picker.tsx`:
// portal-anchored, imperative handle, no DOM focus. Opens when the trigger
// trigger (`components/composer/composer-triggers.ts`) reports a `/` preceded by whitespace or
// start-of-line, anywhere in the composer.
//
// Per ADR 0005, the bound agent's own ACP `available_commands_update` is the
// only source of commands — there is no local catalogue. `message-input.tsx`
// merges in a few host-handled guard rows (`/login`, `/skills`, and
// `/clear`/`/logout` dimmed-unavailable rows) alongside whatever the agent
// advertises.
//
// Files:
//  - this file — the container: the highlight, the imperative handle the
//    editor drives, click-outside, placement and the portal;
//  - `views/slash-command-picker-view.tsx` — the panel, from props alone;
//  - `../lib/slash-command-model.ts` — row types, ranking, highlighting,
//    stepping and placement, pure.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  rankCommands,
  slashPickerPosition,
  wrapIndex,
  type SlashCommand,
} from "../lib/slash-command-model";
import { SlashCommandPickerView } from "./views/slash-command-picker-view";

// ── Public API ──────────────────────────────────────────────────────────────

export type { SlashCommand, SlashCommandHandler } from "../lib/slash-command-model";
export { argsHint } from "../lib/slash-command-model";

export interface SlashCommandPickerHandle {
  moveDown(): void;
  moveUp(): void;
  commit(): boolean;
  goBack(): boolean;
  /** The currently-highlighted row, if any. Used by Tab-to-complete, which
   *  needs the full command name without sending. */
  activeCommand(): SlashCommand | null;
}

export interface SlashCommandPickerProps {
  open: boolean;
  query: string;
  anchor: { x: number; y: number } | null;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
  /** The bound agent's ACP-advertised commands, plus any host-handled guard
   *  rows the caller merges in. ADR 0005: there is no local fallback
   *  catalogue — ACP advertisement is the only source. */
  commands: SlashCommand[];
  /** True between session start and the first `available_commands_update` —
   *  renders a loading message instead of "no commands match". */
  loading?: boolean;
  /** Footer label (e.g. "Codex commands"). */
  footerLabel?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export const SlashCommandPicker = forwardRef<SlashCommandPickerHandle, SlashCommandPickerProps>(
  function SlashCommandPicker(
    { open, query, anchor, onSelect, onClose, commands, loading, footerLabel },
    ref,
  ) {
    const [active, setActive] = useState(0);

    useEffect(() => {
      if (open) setActive(0);
    }, [open, query]);

    const rows = useMemo(() => rankCommands(commands, query), [query, commands]);

    useEffect(() => {
      if (active >= rows.length) setActive(0);
    }, [active, rows.length]);

    const activeRow = rows[active];

    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useImperativeHandle(
      ref,
      (): SlashCommandPickerHandle => ({
        moveDown: () => setActive((a) => wrapIndex(a, 1, rows.length)),
        moveUp: () => setActive((a) => wrapIndex(a, -1, rows.length)),
        commit: () => {
          if (!activeRow) return false;
          onSelectRef.current(activeRow);
          return true;
        },
        goBack: () => false,
        activeCommand: () => activeRow ?? null,
      }),
      [activeRow, rows.length],
    );

    // Dismiss on click outside the picker AND outside the editor host.
    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest(".atlas-chat-composer")) return;
        if (target.closest(".atlas-slash-picker")) return;
        onCloseRef.current();
      };
      window.addEventListener("mousedown", handler);
      return () => window.removeEventListener("mousedown", handler);
    }, [open]);

    if (!open || !anchor) return null;

    return createPortal(
      <SlashCommandPickerView
        rows={rows}
        activeIndex={active}
        query={query}
        loading={!!loading}
        footerLabel={footerLabel ?? "Commands"}
        position={slashPickerPosition(anchor, {
          width: window.innerWidth,
          height: window.innerHeight,
        })}
        onHover={setActive}
        onSelect={(cmd) => onSelectRef.current(cmd)}
      />,
      document.body,
    );
  },
);
