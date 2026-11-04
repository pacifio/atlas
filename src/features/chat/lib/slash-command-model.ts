// The slash-command picker as data: what a row is, how a query ranks and
// highlights rows, how the keyboard steps the highlight, and where the panel
// sits. Pure, so it is tested without a DOM (`slash-command-model.test.ts`).

/** Exactly two outcomes (S1): `/login` — the one command Atlas synthesizes —
 *  and passthrough for everything the agent advertises itself. The former
 *  per-agent login handlers, the `/skills` settings row and the dimmed
 *  "unavailable" guard rows are gone; Atlas renders what ACP gives, nothing
 *  else.
 *
 *  - `agent-login` — opens Atlas's own sign-in dialog for the bound agent (the
 *    ACP adapter filters `/login` from its slash list, so sending it as text
 *    is a no-op; we drive a host-side OAuth flow instead).
 *  - `passthrough` — sent verbatim as the user's next prompt. The agent
 *    processes it locally and its response flows through the normal
 *    `agent_message_chunk` pipeline. */
export type SlashCommandHandler = "agent-login" | "fork" | "queue" | "passthrough";

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

/** Tiered sort: exact name match, then name prefix, then name substring, then
 *  description substring. Alphabetical within each tier. Unmatched rows are
 *  dropped rather than kept in catalogue order, so a query narrows the list
 *  instead of just reordering it. An empty query keeps the given order. */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
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
}

/** One run of text, matched or not. */
export interface MatchSegment {
  text: string;
  match: boolean;
}

/** Cut `text` at the first `max` case-insensitive occurrences of `query`.
 *
 *  Descriptions pass `max = 1`. A skill's description runs to a thousand
 *  characters, and a one-letter query (`/u`) occurs in it dozens of times:
 *  marking every occurrence across a few hundred rows built ~20k `<mark>`
 *  nodes per keystroke and froze the window, all for a span truncated to one
 *  line. An empty query, or no occurrence, is one unmatched segment. */
export function matchSegments(text: string, query: string, max = Infinity): MatchSegment[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return [{ text, match: false }];
  // `split` with a capture group alternates text, match, text, …; keep `max`
  // matches and fold the remainder back into one plain tail.
  if (parts.length > 2 * max + 1) {
    parts.splice(2 * max, parts.length, parts.slice(2 * max).join(""));
  }
  return parts.map((part, i) => ({ text: part, match: i % 2 === 1 }));
}

/** `active` moved by `delta`, wrapping at both ends. Unchanged for an empty
 *  list. */
export function wrapIndex(active: number, delta: number, length: number): number {
  if (length === 0) return active;
  return (((active + delta) % length) + length) % length;
}

export const SLASH_PICKER_WIDTH = 460;
export const SLASH_PICKER_MAX_HEIGHT = 360;
const GAP = 6;
const EDGE = 8;

/** Where the panel sits: always above the caret (the composer is flush with
 *  the bottom of the window), its left edge clamped inside the viewport. */
export function slashPickerPosition(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
): { left: number; bottom: number } {
  return {
    left: Math.max(EDGE, Math.min(anchor.x, viewport.width - SLASH_PICKER_WIDTH - EDGE)),
    bottom: Math.max(EDGE, viewport.height - anchor.y + GAP),
  };
}
