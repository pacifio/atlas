// Floating slash-command picker. Same architecture as `mention-picker.tsx`:
// portal-anchored, imperative handle, no DOM focus. Opens when the trigger
// plugin (`cm-slash-extension.ts`) reports a `/` at the start of the line.
//
// Phase 1 wires only `/login` as an Atlas-handled command (opens the
// existing `ClaudeLoginDialog`). Every other command in the catalogue is
// marked `unsupported` and renders greyed out — the picker is primarily a
// discoverability surface for now.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// ── Public API ──────────────────────────────────────────────────────────────

/** Where the command is dispatched.
 *
 * - `atlas-login` — opens Atlas's own `ClaudeLoginDialog` (the adapter
 *   filters `/login` from its slash list, so sending it as text is a
 *   no-op; we drive a host-side OAuth flow instead).
 * - `passthrough` — sent verbatim as the user's next prompt. The agent
 *   (claude-agent-acp's SDK) processes it locally and emits the response
 *   as `<local-command-stdout>…</local-command-stdout>` blocks which flow
 *   through the normal `agent_message_chunk` pipeline and render in the
 *   chat thread alongside regular assistant output. */
export type SlashCommandHandler = "atlas-login" | "codex-login" | "passthrough";

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

export interface SlashCommandPickerHandle {
  moveDown(): void;
  moveUp(): void;
  commit(): boolean;
  goBack(): boolean;
}

export interface SlashCommandPickerProps {
  open: boolean;
  query: string;
  anchor: { x: number; y: number } | null;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
  /** Override the catalogue (e.g. Codex's ACP-reported commands). When absent
   *  the curated Claude Code list is used. */
  commands?: SlashCommand[];
  /** Footer label (e.g. "Codex commands"). */
  footerLabel?: string;
}

// ── Command catalogue ──────────────────────────────────────────────────────
//
// Curated from the Claude Code CLI command list. `/login` is the only
// host-handled command (opens Atlas's sign-in dialog); everything else is
// `passthrough` — the picker drops the command text into the composer
// and either auto-sends it (no args) or waits for the user to fill in
// arguments before pressing Enter. The agent (claude-agent-acp) handles
// the actual command logic and emits the response into the chat thread.

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "login",
    signature: "/login",
    description: "Sign in to your Anthropic account.",
    handler: "atlas-login",
  },
  {
    name: "logout",
    signature: "/logout",
    description: "Sign out from your Anthropic account.",
    handler: "passthrough",
  },
  {
    name: "agents",
    signature: "/agents",
    description: "Manage agent configurations.",
    handler: "passthrough",
  },
  {
    name: "add-dir",
    signature: "/add-dir <path>",
    description: "Add a working directory for file access in this session.",
    handler: "passthrough",
  },
  {
    name: "clear",
    signature: "/clear [name]",
    description: "Start a new conversation with empty context.",
    handler: "passthrough",
  },
  {
    name: "compact",
    signature: "/compact",
    description: "Summarize the conversation to free up context.",
    handler: "passthrough",
  },
  {
    name: "model",
    signature: "/model [model]",
    description: "Set the AI model for the current session.",
    handler: "passthrough",
  },
  {
    name: "effort",
    signature: "/effort [level]",
    description: "Set the model effort level (low/medium/high/xhigh/max).",
    handler: "passthrough",
  },
  {
    name: "context",
    signature: "/context",
    description: "Visualize current context usage.",
    handler: "passthrough",
  },
  {
    name: "memory",
    signature: "/memory",
    description: "Edit CLAUDE.md memory files and auto-memory entries.",
    handler: "passthrough",
  },
  {
    name: "resume",
    signature: "/resume [session]",
    description: "Resume a previous conversation.",
    handler: "passthrough",
  },
  {
    name: "rewind",
    signature: "/rewind",
    description: "Rewind the conversation or code to a previous point.",
    handler: "passthrough",
  },
  {
    name: "diff",
    signature: "/diff",
    description: "Open an interactive diff viewer for uncommitted changes.",
    handler: "passthrough",
  },
  {
    name: "permissions",
    signature: "/permissions",
    description: "Manage allow / ask / deny rules for tool permissions.",
    handler: "passthrough",
  },
  {
    name: "config",
    signature: "/config",
    description: "Open the Settings interface.",
    handler: "passthrough",
  },
  {
    name: "status",
    signature: "/status",
    description: "Show version, model, account, and connectivity.",
    handler: "passthrough",
  },
  {
    name: "usage",
    signature: "/usage",
    description: "Show session cost, plan usage limits, and activity stats.",
    handler: "passthrough",
  },
  {
    name: "doctor",
    signature: "/doctor",
    description: "Diagnose and verify your Claude Code installation.",
    handler: "passthrough",
  },
  {
    name: "mcp",
    signature: "/mcp",
    description: "Manage MCP server connections and OAuth.",
    handler: "passthrough",
  },
  {
    name: "hooks",
    signature: "/hooks",
    description: "View hook configurations for tool events.",
    handler: "passthrough",
  },
  {
    name: "ide",
    signature: "/ide",
    description: "Manage IDE integrations and show status.",
    handler: "passthrough",
  },
  {
    name: "init",
    signature: "/init",
    description: "Initialize project with a CLAUDE.md guide.",
    handler: "passthrough",
  },
  {
    name: "review",
    signature: "/review [PR]",
    description: "Review a pull request locally in the current session.",
    handler: "passthrough",
  },
  {
    name: "security-review",
    signature: "/security-review",
    description: "Analyze pending changes for security vulnerabilities.",
    handler: "passthrough",
  },
  {
    name: "feedback",
    signature: "/feedback",
    description: "Submit feedback, report a bug, or share the conversation.",
    handler: "passthrough",
  },
  {
    name: "help",
    signature: "/help",
    description: "Show help and available commands.",
    handler: "passthrough",
  },
];

// ── Component ───────────────────────────────────────────────────────────────

const PICKER_WIDTH = 460;
const GAP = 6;

export const SlashCommandPicker = forwardRef<
  SlashCommandPickerHandle,
  SlashCommandPickerProps
>(function SlashCommandPicker(
  { open, query, anchor, onSelect, onClose, commands, footerLabel },
  ref,
) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) setActive(0);
  }, [open, query]);

  // The agent's own commands when provided (Codex), else the curated Claude list.
  const catalogue = commands ?? SLASH_COMMANDS;

  // Filter by query against name + description. Cheap linear scan.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalogue;
    return catalogue.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [query, catalogue]);

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
            No commands match &ldquo;/{query}&rdquo;.
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
                  /{cmd.name}
                </span>
                <span className="truncate text-[10.5px] text-[var(--text-tertiary)] min-w-0 flex-1">
                  {cmd.description}
                </span>
                {needsArgs && (
                  <span
                    className="shrink-0 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)] border border-[var(--border-default)] rounded-full px-1.5 py-px"
                    title="This command takes arguments — type them after the command, then press Enter."
                  >
                    args
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      <div className="border-t border-[var(--border-default)] px-3 h-[24px] flex items-center justify-between text-[9px] text-[var(--text-tertiary)] uppercase tracking-wider shrink-0">
        <span>{footerLabel ?? "Claude Code commands"}</span>
        <span>↑↓ · ↵ run · ⎋ close</span>
      </div>
    </div>,
    document.body,
  );
});
