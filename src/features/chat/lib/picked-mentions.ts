// Which of a message's file mentions the user actually picked.
//
// A composer chip can come from the picker or a drop (`pickedChip`), or be
// rebuilt from text: a draft restore, a paste, or a prefill such as a pull
// request handoff, whose prompt quotes text the pull request's author wrote
// (a CI check name can read `@file:/tmp/x/setup.terminal`). Rebuilt chips
// look the same, and inside the project that is fine. Outside it, a sent
// bubble's chip is clickable only for a path the user picked
// (`ChatMessage.trustedMentionPaths`), so the pick has to survive the trip
// from the chip to the send.
//
// `mentionOf` strips the composer's `picked` flag before a mention leaves the
// composer (the mention goes to Rust as-is), so the flag rides here instead,
// keyed by the mention object the send receives. Weak, so it holds nothing
// alive; a mention that loses its identity on the way (the queue, a draft
// restore) loses its trust, which only makes its chip inert.

import { isAbsolutePath } from "@/lib/file-links";
import type { MentionData } from "./mentions";

const picked = new WeakSet<MentionData>();

/** Record that `mention` came from a chip the user picked or dropped. */
export function markPicked(mention: MentionData): void {
  picked.add(mention);
}

/** The absolute `@file:`/`@folder:` values among `mentions` that the user
 *  picked: what `toShortForm` wrote into the prose for them, which is what the
 *  transcript's renderer will read back. */
export function trustedMentionPaths(mentions: readonly MentionData[]): string[] | undefined {
  const out: string[] = [];
  for (const m of mentions) {
    if ((m.kind === "file" || m.kind === "folder") && picked.has(m)) {
      if (isAbsolutePath(m.displayName)) out.push(m.displayName);
    }
  }
  return out.length ? out : undefined;
}
