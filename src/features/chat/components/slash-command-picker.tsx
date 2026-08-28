// Floating slash-command picker. Same architecture as `mention-picker.tsx`:
// portal-anchored, imperative handle, no DOM focus. Opens when the trigger
// plugin (`cm-slash-extension.ts`) reports a `/` preceded by whitespace or
// start-of-line, anywhere in the composer.
//
// Per ADR 0003, the bound agent's own ACP `available_commands_update` is the
// only source of commands — there is no local catalogue. `message-input.tsx`
// merges in a few host-handled guard rows (`/login`, `/skills`, and
// `/clear`/`/logout` dimmed-unavailable rows) alongside whatever the agent
// advertises.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Public API ──────────────────────────────────────────────────────────────

/** Where the command is dispatched.
 *
 * - `atlas-login` / `codex-login` — opens Atlas's own sign-in dialog for the
 *   bound agent (the ACP adapter filters `/login` from its slash list, so
 *   sending it as text is a no-op; we drive a host-side OAuth flow instead).
 * - `open-settings` — host-handled, opens Settings on a fixed section
 *   (currently only `/skills`).
 * - `unavailable` — host-handled guard row for a command the agent doesn't
 *   support (e.g. `/clear`/`/logout`, blocklisted by the ACP adapter).
 *   Selecting it just closes the picker.
 * - `passthrough` — sent verbatim as the user's next prompt. The agent
 *   (claude-agent-acp's SDK) processes it locally and emits the response
 *   as `<local-command-stdout>…</local-command-stdout>` blocks which flow
 *   through the normal `agent_message_chunk` pipeline and render in the
 *   chat thread alongside regular assistant output. */
/** Exactly two outcomes (S1): `/login` — the one command Atlas synthesizes —
 *  and passthrough for everything the agent advertises itself. The former
 *  per-agent login handlers, the `/skills` settings row and the dimmed
 *  "unavailable" guard rows are gone; Atlas renders what ACP gives, nothing
 *  else. */
export type SlashCommandHandler = "agent-login" | "passthrough";

export interface SlashCommand {
  /** Unique slug used both as the visible command name and matched query. */
  name: string;
  /** Signature shown next to the name, e.g. `/add-dir <path>`. */
  signature: string;
  description: string;
  handler: SlashCommandHandler;
}

/** True if the signature contains `<…>` (required args). The picker uses
 *  this to decide whether to auto-send the command or just insert it into
 *  the composer and let the user type arguments before pressing Enter. */
export function commandRequiresArgs(cmd: SlashCommand): boolean {
  return /<[^>]+>/.test(cmd.signature);
}

/** The agent's own word for what this command takes (P3.1).
 *
 *  `AvailableCommand.input.hint` is baked into the signature upstream, so it is
 *  read back out here. Showing the agent's hint — "branch", "file path" —
 *  instead of a generic "args" badge is the difference between the picker
 *  telling the user what to type and merely telling them that something is
 *  required. Falls back to "args" when the agent supplied no hint. */
export function argsHint(cmd: SlashCommand): string {
  return /<([^>]+)>/.exec(cmd.signature)?.[1] ?? "args";
}

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
   *  rows the caller merges in. ADR 0003: there is no local fallback
   *  catalogue — ACP advertisement is the only source. */
  commands: SlashCommand[];
  /** True between session start and the first `available_commands_update` —
   *  renders a loading message instead of "no commands match". */
  loading?: boolean;
  /** Footer label (e.g. "Codex commands"). */
  footerLabel?: string;
}

/** Highlight every case-insensitive occurrence of `query` in `text`. */
function highlightMatches(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-[var(--bg-selected)] text-[var(--text-primary)] rounded-[2px]">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

// ── Component ───────────────────────────────────────────────────────────────

const PICKER_WIDTH = 460;
const GAP = 6;

export const SlashCommandPicker = forwardRef<SlashCommandPickerHandle, SlashCommandPickerProps>(
  function SlashCommandPicker(
    { open, query, anchor, onSelect, onClose, commands, loading, footerLabel },
    ref,
  ) {
    const [active, setActive] = useState(0);

    useEffect(() => {
      if (open) setActive(0);
    }, [open, query]);

    // Tiered sort: exact name match, then name prefix, then name substring,
    // then description substring. Alphabetical within each tier. Unmatched
    // rows are dropped rather than kept in catalogue order, so a query
    // narrows the list instead of just reordering it.
    const rows = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return commands;
      const tierOf = (c: SlashCommand): number => {
        const name = c.name.toLowerCase();
        if (name === q) return 0;
        if (name.startsWith(q)) return 1;
        if (name.includes(q)) return 2;
        if (c.description.toLowerCase().includes(q)) return 3;
        return -1;
      };
      return commands
        .map((c) => ({ c, tier: tierOf(c) }))
        .filter((x) => x.tier >= 0)
        .sort((a, b) => a.tier - b.tier || a.c.name.localeCompare(b.c.name))
        .map((x) => x.c);
    }, [query, commands]);

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
        moveDown: () => {
          if (rows.length === 0) return;
          setActive((a) => (a + 1) % rows.length);
        },
        moveUp: () => {
          if (rows.length === 0) return;
          setActive((a) => (a - 1 + rows.length) % rows.length);
        },
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
        if (target.closest(".atlas-chat-cm-host")) return;
        if (target.closest(".atlas-slash-picker")) return;
        onCloseRef.current();
      };
      window.addEventListener("mousedown", handler);
      return () => window.removeEventListener("mousedown", handler);
    }, [open]);

    if (!open || !anchor) return null;

    const vw = window.innerWidth;
    const left = Math.max(8, Math.min(anchor.x, vw - PICKER_WIDTH - 8));
    const bottom = Math.max(8, window.innerHeight - anchor.y + GAP);

    return createPortal(
      <div
        className={cn(
          "atlas-slash-picker",
          "rounded-lg overflow-hidden",
          "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
          "shadow-[0_8px_24px_rgba(0,0,0,0.5)]",
          "flex flex-col",
        )}
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          left,
          bottom,
          width: PICKER_WIDTH,
          maxHeight: 360,
          zIndex: 9999,
        }}
      >
        <div className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--text-tertiary)] leading-snug">
              {loading ? "Loading commands…" : `No commands match "/${query}".`}
            </div>
          ) : (
            rows.map((cmd, i) => {
              const isActive = i === active;
              const needsArgs = commandRequiresArgs(cmd);
              return (
                <button
                  key={cmd.name}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectRef.current(cmd);
                  }}
                  className={cn(
                    "w-full text-left px-3 h-[26px] flex items-center gap-2 text-[11.5px]",
                    isActive
                      ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                  )}
                  title={cmd.description}
                >
                  <span className="font-mono text-[var(--text-primary)] shrink-0 min-w-[80px]">
                    /{highlightMatches(cmd.name, query)}
                  </span>
                  <span className="truncate text-[10.5px] text-[var(--text-tertiary)] min-w-0 flex-1">
                    {highlightMatches(cmd.description, query)}
                  </span>
                  {needsArgs && (
                    <span
                      className="shrink-0 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)] border border-[var(--border-default)] rounded-full px-1.5 py-px"
                      title="This command takes arguments — type them after the command, then press Enter."
                    >
                      {argsHint(cmd)}
                    </span>
                  )}
                </button>
              );
            })
          )}
          {/* `/login` is usually present (S1 left it as the only synthetic
              row), so the empty-state "Loading commands…" branch above rarely
              fires — this row makes the startup gap, when the agent has not
              advertised its commands yet, read as loading rather than as a
              list with just one entry. */}
          {loading && rows.length > 0 && (
            <div className="px-3 h-[24px] flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
              <Loader2 size={10} className="animate-spin shrink-0" />
              Loading agent commands…
            </div>
          )}
        </div>
        <div className="border-t border-[var(--border-default)] px-3 h-[24px] flex items-center justify-between text-[9px] text-[var(--text-tertiary)] uppercase tracking-wider shrink-0">
          <span>{footerLabel ?? "Commands"}</span>
          <span>↑↓ · ↵ run · ⎋ close</span>
        </div>
      </div>,
      document.body,
    );
  },
);
