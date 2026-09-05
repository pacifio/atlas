import * as Y from "yjs";

/**
 * The cross-client contract for Prompt Draft documents. Every constant here
 * is fixed by the WEB editor's conventions (server `apps/web/src/lib/
 * drafts.ts`) — the server stores opaque bytes and enforces nothing, so the
 * clients only converge if they agree by discipline:
 *
 *   - text lives at the Y.Doc root key `prompt`;
 *   - remote applies are tagged with a REMOTE origin so `doc.on("update")`
 *     can skip echoing them back;
 *   - awareness is base64 UTF-8 `{"cursor": <int>}` — NOT y-protocols, which
 *     the web client would silently not understand.
 */
export const PROMPT_TEXT_KEY = "prompt";

/** Origin marker for applying server bytes — filtered out of the relay. */
export const REMOTE = Symbol("remote");

/** Web parity: batch local updates this long before sending. */
export const UPDATE_DEBOUNCE_MS = 100;
/** Web parity: cursor publish throttle / heartbeat / peer expiry. */
export const AWARENESS_INTERVAL_MS = 500;
export const AWARENESS_HEARTBEAT_MS = 5_000;
export const AWARENESS_TTL_MS = AWARENESS_HEARTBEAT_MS * 3;

/** Apply a `draft.opened` payload: snapshot first (may be null until the
 *  first compaction), then the update log in order. Malformed entries are
 *  skipped, not thrown — one corrupt update must not brick the document. */
export function applyContent(
  doc: Y.Doc,
  snapshot: string | null,
  updates: readonly string[],
): void {
  const parts = snapshot === null ? updates : [snapshot, ...updates];
  for (const part of parts) {
    const bytes = fromBase64(part);
    if (bytes === null || bytes.length === 0) continue;
    try {
      Y.applyUpdate(doc, bytes, REMOTE);
    } catch (e) {
      console.warn("comms: skipping malformed draft update:", e);
    }
  }
}

export interface DraftAwarenessState {
  cursor: number;
}

export function encodeAwareness(state: DraftAwarenessState): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(state)));
}

export function decodeAwareness(base64: string): DraftAwarenessState | null {
  const bytes = fromBase64(base64);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "cursor" in parsed &&
      typeof (parsed as { cursor: unknown }).cursor === "number" &&
      Number.isFinite((parsed as { cursor: number }).cursor)
    ) {
      return { cursor: Math.max(0, Math.trunc((parsed as { cursor: number }).cursor)) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Chunked at 0x8000: `String.fromCharCode(...bytes)` overflows the argument
 *  stack on a large snapshot (the web client hit this first). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
