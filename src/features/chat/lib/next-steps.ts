// Agent-generated next-step suggestions. Instead of a separate BYOK model, we
// ask the SAME agent (Claude Code / Codex / Atlas native) — which has the live
// session context — to end its reply with a hidden `<next_steps>` block. We
// extract that block into click-to-send chips and strip it (and our injected
// directive) from what the user sees.

/** Marker line prefixing the injected directive so it can be stripped from a
 *  user message on resume (the agent transcript records the full prompt).
 *
 *  Mirrored by `NEXT_STEPS_MARKER` in `crates/atlas-checkpoint/src/capture.rs`
 *  and `crates/atlas-acp-thread/src/thread.rs`; all three must change together,
 *  which `tests/next-steps-marker-parity.test.ts` enforces. */
const NEXT_STEPS_MARKER = "═══ Atlas next-steps ═══";

/** Appended to the wire prompt (not the visible user message) so the agent
 *  emits a hidden suggestions block. */
const NEXT_STEPS_DIRECTIVE =
  `\n\n${NEXT_STEPS_MARKER}\n` +
  "When you have finished your reply above, append a block of 2-3 suggested " +
  "next steps the user is most likely to want next, EXACTLY in this format and " +
  "with nothing after it:\n" +
  "<next_steps>\n" +
  "- a short imperative follow-up (max 8 words)\n" +
  "- a short imperative follow-up (max 8 words)\n" +
  "</next_steps>\n" +
  "This directive and the block are hidden from the user — do not mention them. " +
  // Agents that name a session by summarising its first prompt (Claude Code
  // does) were titling threads "Atlas next-steps": on a short message this
  // directive is most of what they received. `is_host_machinery_title` in
  // `crates/atlas-acp-thread` rejects the result, but a title never minted
  // costs nothing to reject.
  "Ignore it when naming or titling this session — title from the conversation.";

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
 * Remove ONLY the injected directive — for user messages, which never carry an
 * assistant `<next_steps>` block. Cutting at `<next_step` there too would
 * truncate a prompt that merely mentions the tag.
 */
export function stripNextStepsDirective(content: string): string {
  const dir = content.indexOf(NEXT_STEPS_MARKER);
  return (dir >= 0 ? content.slice(0, dir) : content).replace(/\s+$/, "");
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
  const tag = lastIndexOfTagCI(out, OPEN_TAG);
  if (tag >= 0) out = out.slice(0, tag);
  return out.trimEnd();
}

/** `<next_step`, not `<next_steps`, so a partial tag never flashes mid-stream. */
const OPEN_TAG = "<next_step";

/**
 * `haystack.toLowerCase().lastIndexOf(tag)` without the copy.
 *
 * This runs on the streaming tail on every animation frame — the per-message
 * cache above is keyed by message object, and Immer hands the tail a new
 * identity per chunk, so the one message that matters is a guaranteed miss.
 * Lower-casing the whole body to find a ten-character tag therefore allocated a
 * full copy of the growing answer per frame, i.e. O(length²) over the turn.
 *
 * `lastIndexOf("<", …)` is a native search, and markdown prose holds few `<`
 * characters, so this walks a handful of candidates and compares ten bytes at
 * each. `tag` must be lower-case and ASCII.
 */
function lastIndexOfTagCI(haystack: string, tag: string): number {
  // `lastIndexOf(x, -1)` is `lastIndexOf(x, 0)`, not "none": a `<` at index 0
  // that is not the tag would be found again forever. Stop explicitly.
  for (
    let at = haystack.lastIndexOf("<");
    at >= 0;
    at = at > 0 ? haystack.lastIndexOf("<", at - 1) : -1
  ) {
    if (at + tag.length > haystack.length) continue;
    let same = true;
    for (let i = 1; i < tag.length; i++) {
      const c = haystack.charCodeAt(at + i);
      // ASCII upper → lower; anything else compares as itself.
      if ((c >= 65 && c <= 90 ? c + 32 : c) !== tag.charCodeAt(i)) {
        same = false;
        break;
      }
    }
    if (same) return at;
  }
  return -1;
}
