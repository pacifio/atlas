import type { AgentDelta } from "@/types/agents";

/**
 * Paces bursty streamed text so it types out steadily instead of landing in
 * lumps.
 *
 * Why: the gateway forwards provider chunks faithfully, but Claude-via-Vertex
 * *emits* in ~400–650 ms bursts (measured on the live endpoint, 2026-09-05 —
 * see research/stream-smoothing.md). Every hop from engine to store is
 * per-delta, so the lumps reach the UI intact. This is the one deliberate
 * pacing stage, and it is presentation-only: it sits between the
 * `atlas:agents` listener and the RAF batcher in App.tsx, so the Rust-side
 * transcript record never sees it.
 *
 * Ordering contract (the same one the RAF buffer documents): deltas for a
 * session leave in exactly the order they arrived. Text/thinking chunks are
 * the only thing paced; every other delta becomes a *barrier* in the queue
 * that passes only once the text ahead of it has drained. `turn_finished`
 * rides as a barrier too, so the tail keeps typing after the turn ends and
 * the idle flip lands last. Exceptions, all deliberate:
 *  - `permission_request` / `permission_resolved` bypass entirely — the modal
 *    must open on the next tick, and permissions don't order against text.
 *  - A cancelled `turn_finished`, `turn_failed`, and `agent_disconnected`
 *    flush the queue synchronously first — stop must feel like stop, and an
 *    error must not type out leisurely.
 *
 * Drain model: budget is computed from *elapsed* time (not tick count), so
 * WebKit throttling timers to ~1 s while the window is unfocused degrades to
 * chunkier-but-current, never to a growing backlog. The rate targets clearing
 * the current backlog in `targetLagMs` and only ratchets *up* within a
 * continuous drain (rising mid-burst is invisible; slowing down is not), with
 * a floor so an already-smooth stream passes through at chunk speed.
 */

export interface StreamSmootherOptions {
  /** Drain-timer interval. Purely a scheduling grain — see elapsed-time note. */
  tickMs?: number;
  /** Aim to clear the standing backlog within this window. */
  targetLagMs?: number;
  /** Chars emitted per tick even when the backlog math says fewer. */
  minCharsPerTick?: number;
  /** Which sessions get paced; everything else passes through synchronously. */
  shouldSmooth?: (sessionId: string) => boolean;
}

type TextKind = "text_chunk" | "thinking_chunk";
type TextDelta = Extract<AgentDelta, { kind: TextKind }>;

type QueueEntry =
  | {
      type: "text";
      kind: TextKind;
      /** Template for synthetic emissions (message_id, agent_id, …). */
      env: TextDelta;
      text: string;
      /** Read cursor into `text` — avoids re-slicing the head on every tick. */
      cursor: number;
    }
  | { type: "barrier"; env: AgentDelta };

interface SessionQueue {
  entries: QueueEntry[];
  /** Ratcheted drain rate (chars/ms); reset when the queue empties. */
  rate: number;
}

const DEFAULT_TICK_MS = 33;
const DEFAULT_TARGET_LAG_MS = 450;
const DEFAULT_MIN_CHARS_PER_TICK = 2;

/** Cut point ≤ `at` that doesn't split a surrogate pair. */
const safeCut = (text: string, at: number): number => {
  if (at >= text.length) return text.length;
  const code = text.charCodeAt(at - 1);
  // High surrogate at the boundary → include its partner.
  if (code >= 0xd800 && code <= 0xdbff) return at + 1;
  return at;
};

export class StreamSmoother {
  private readonly sink: (env: AgentDelta) => void;
  private readonly tickMs: number;
  private readonly targetLagMs: number;
  private readonly minCharsPerTick: number;
  private readonly shouldSmooth: (sessionId: string) => boolean;

  private readonly queues = new Map<string, SessionQueue>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private disposed = false;

  constructor(sink: (env: AgentDelta) => void, opts: StreamSmootherOptions = {}) {
    this.sink = sink;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.targetLagMs = opts.targetLagMs ?? DEFAULT_TARGET_LAG_MS;
    this.minCharsPerTick = opts.minCharsPerTick ?? DEFAULT_MIN_CHARS_PER_TICK;
    this.shouldSmooth = opts.shouldSmooth ?? (() => true);
  }

  ingest(env: AgentDelta): void {
    if (this.disposed) {
      this.sink(env);
      return;
    }

    // Permissions never queue: the modal opens synchronously today and text
    // has no ordering relationship with the permission stack.
    if (env.kind === "permission_request" || env.kind === "permission_resolved") {
      this.sink(env);
      return;
    }

    const sessionId = "session_id" in env ? env.session_id : undefined;
    const queue = sessionId ? this.queues.get(sessionId) : undefined;

    // Stop/error/teardown: whatever is queued lands NOW, then the terminal
    // delta follows it — still in order, just all at once.
    const isCancelledFinish = env.kind === "turn_finished" && env.stop_reason === "cancelled";
    if (isCancelledFinish || env.kind === "turn_failed" || env.kind === "agent_disconnected") {
      if (sessionId) this.flushSession(sessionId);
      this.sink(env);
      return;
    }

    if (env.kind === "text_chunk" || env.kind === "thinking_chunk") {
      if (!sessionId || !this.shouldSmooth(sessionId)) {
        this.sink(env);
        return;
      }
      const q = this.queue(sessionId);
      const last = q.entries[q.entries.length - 1];
      if (
        last?.type === "text" &&
        last.kind === env.kind &&
        last.env.message_id === env.message_id
      ) {
        last.text += env.delta;
      } else {
        q.entries.push({ type: "text", kind: env.kind, env, text: env.delta, cursor: 0 });
      }
      this.ensureTimer();
      return;
    }

    // Any other delta: if text is queued ahead of it, it must wait its turn.
    if (queue && queue.entries.length > 0) {
      queue.entries.push({ type: "barrier", env });
      return;
    }
    this.sink(env);
  }

  /** Emit everything a session still holds, synchronously and in order. */
  flushSession(sessionId: string): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    this.queues.delete(sessionId);
    for (const entry of q.entries) {
      if (entry.type === "barrier") {
        this.sink(entry.env);
      } else if (entry.cursor < entry.text.length) {
        this.sink({ ...entry.env, delta: entry.text.slice(entry.cursor) });
      }
    }
    this.stopTimerIfIdle();
  }

  flushAll(): void {
    // Safe to mutate mid-iteration: flushSession only deletes the key in hand.
    for (const sessionId of this.queues.keys()) this.flushSession(sessionId);
  }

  dispose(): void {
    this.flushAll();
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private queue(sessionId: string): SessionQueue {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = { entries: [], rate: 0 };
      this.queues.set(sessionId, q);
    }
    return q;
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private stopTimerIfIdle(): void {
    if (this.timer !== null && this.queues.size === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    // Clamped: a first tick or a resumed throttled timer must not compute a
    // zero/negative or absurd window.
    const elapsed = Math.max(1, now - this.lastTickAt);
    this.lastTickAt = now;

    for (const [sessionId, q] of this.queues) {
      const backlog = q.entries.reduce(
        (n, e) => n + (e.type === "text" ? e.text.length - e.cursor : 0),
        0,
      );
      if (backlog === 0 && q.entries.length === 0) {
        this.queues.delete(sessionId);
        continue;
      }
      // Rate to clear the current backlog within the lag window; ratchet-up
      // only, so the reader never sees the drain visibly decelerate mid-burst.
      q.rate = Math.max(q.rate, backlog / this.targetLagMs);
      let budget = Math.max(this.minCharsPerTick, Math.ceil(q.rate * elapsed));

      while (q.entries.length > 0) {
        const head = q.entries[0];
        if (head.type === "barrier") {
          q.entries.shift();
          this.sink(head.env);
          continue; // barriers are free — keep draining this tick's budget
        }
        if (budget <= 0) break;
        const remaining = head.text.length - head.cursor;
        const take = safeCut(head.text, head.cursor + Math.min(budget, remaining));
        const piece = head.text.slice(head.cursor, take);
        head.cursor = take;
        budget -= piece.length;
        if (head.cursor >= head.text.length) q.entries.shift();
        if (piece.length > 0) this.sink({ ...head.env, delta: piece });
      }

      if (q.entries.length === 0) {
        // Fully drained: drop the ratchet so the next burst re-derives its
        // own rate instead of inheriting this one's.
        this.queues.delete(sessionId);
      }
    }
    this.stopTimerIfIdle();
  }
}
