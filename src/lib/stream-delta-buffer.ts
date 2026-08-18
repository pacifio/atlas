/**
 * rAF-coalesced text-delta buffer for token streams — the same shape as the
 * agent-chat batcher in App.tsx, extracted for the side chats (Model Chat,
 * Memory Chat, Session Chat). Those stores used to apply one zustand `set()`
 * (full Record spread + subscriber notification + panel render + virtualizer
 * measure) PER STREAMED TOKEN: 100+ render/measure cycles a second at fast
 * providers, where the main chat caps at one per frame.
 *
 * Deltas accumulate per key (stream id) and flush in ONE call per animation
 * frame. The `setTimeout` backstop mirrors App.tsx: WebKit pauses rAF whenever
 * the window isn't frontmost — not just when hidden — and without the timer a
 * background window's stream would buffer forever and land as one giant catch-
 * up batch on wake.
 *
 * Call `flush()` before handling a terminal event (done/error) so the last
 * chunks are applied before the stream mapping is torn down and the session
 * persisted.
 */
export interface StreamDeltaBuffer {
  /** Queue `delta` under `key`; schedules a flush if none is pending. */
  push: (key: string, delta: string) => void;
  /** Apply everything now (cancels the scheduled drains). Safe to call idle. */
  flush: () => void;
}

const BACKSTOP_MS = 250;

export function createStreamDeltaBuffer(
  apply: (chunks: ReadonlyMap<string, string>) => void,
): StreamDeltaBuffer {
  const pending = new Map<string, string>();
  let rafId: number | null = null;
  let backstopId: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (backstopId !== null) {
      clearTimeout(backstopId);
      backstopId = null;
    }
    if (pending.size === 0) return;
    const chunks = new Map(pending);
    pending.clear();
    try {
      apply(chunks);
    } catch (e) {
      // The batch is lost either way; what must not happen is the exception
      // killing the rAF/timer scheduler (every later delta would then buffer
      // against a drain that never runs — the thread "freezes" mid-answer).
      console.error("stream delta flush failed; dropped", chunks.size, "streams:", e);
    }
  };

  const push = (key: string, delta: string) => {
    pending.set(key, (pending.get(key) ?? "") + delta);
    if (rafId === null) rafId = requestAnimationFrame(flush);
    if (backstopId === null) backstopId = setTimeout(flush, BACKSTOP_MS);
  };

  return { push, flush };
}
