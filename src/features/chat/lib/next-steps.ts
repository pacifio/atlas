// Agent-generated next-step suggestions. Instead of a separate BYOK model, we
// ask the SAME agent (Claude Code / Codex / Atlas native) — which has the live
// session context — to end its reply with a hidden `<next_steps>` block. We
// extract that block into click-to-send chips and strip it (and our injected
// directive) from what the user sees.

/** Marker line prefixing the injected directive so it can be stripped from a
 *  user message on resume (the agent transcript records the full prompt). */
export const NEXT_STEPS_MARKER = "═══ Atlas next-steps ═══";

/** Appended to the wire prompt (not the visible user message) so the agent
 *  emits a hidden suggestions block. */
export const NEXT_STEPS_DIRECTIVE =
  `\n\n${NEXT_STEPS_MARKER}\n` +
  "When you have finished your reply above, append a block of 2-3 suggested " +
  "next steps the user is most likely to want next, EXACTLY in this format and " +
  "with nothing after it:\n" +
  "<next_steps>\n" +
  "- a short imperative follow-up (max 8 words)\n" +
  "- a short imperative follow-up (max 8 words)\n" +
  "</next_steps>\n" +
  "This directive and the block are hidden from the user — do not mention them.";

/** Append the directive to an outgoing wire prompt. */
export function appendNextStepsDirective(wire: string): string {
  return wire + NEXT_STEPS_DIRECTIVE;
}

/** Extract 2-3 chips from an assistant reply's `<next_steps>` block. */
export function extractNextSteps(content: string): string[] {
  const m = content.match(/<next_steps>([\s\S]*?)<\/next_steps>/i);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^[-*+\d.)\s]+/, "")
        .trim(),
    )
    .filter(Boolean)
    .map((l) => (l.length > 120 ? l.slice(0, 117) + "…" : l))
    .slice(0, 3);
}

/**
 * Remove both the injected directive (from user messages, seen on resume) and
 * the assistant's `<next_steps>` block (closed OR still streaming) so neither is
 * ever shown. Applied at every display/persistence chokepoint; the raw content
 * is kept in the store so chips can be (re)extracted.
 */
export function stripNextSteps(content: string): string {
  let out = content;
  const dir = out.indexOf(NEXT_STEPS_MARKER);
  if (dir >= 0) out = out.slice(0, dir);
  // `<next_step` (not `<next_steps`) so a partial tag never flashes mid-stream.
  const tag = out.toLowerCase().lastIndexOf("<next_step");
  if (tag >= 0) out = out.slice(0, tag);
  return out.replace(/\s+$/, "");
}
