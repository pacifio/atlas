/**
 * A client-side deadline on an IPC hop that may never settle.
 *
 * The bind path (`agents_spawn`, `agents_new_session`) awaits Rust futures
 * that, before PR 2 of the stalled-start plan, had no timeout of their own: an
 * `npm install` against a black-hole registry, or a `session/new` into a
 * wedged app-server, simply never answered. An `await` with no deadline left
 * the panel's `pending` flag set for the life of the app, which silently
 * disabled every retry path (focus, sign-in, silent) — the "Starting Codex"
 * that never ends. This makes the hop REJECT instead, so the ordinary failure
 * path runs: the held message goes back to the queue chip, the status drops to
 * idle, the failure is logged and reported.
 *
 * Rejection only — the underlying promise is not cancelled (a JS promise
 * cannot be). Callers that need the backend to give up too kill the plugin.
 */

export const BIND_TIMEOUT_CODE = "bind-timeout" as const;

export class DeadlineError extends Error {
  readonly code = BIND_TIMEOUT_CODE;
  /** Structured `kind` so `errInfo` reads it like a backend rejection. */
  readonly kind = "timeout";
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

/** True when `err` is a deadline expiry from [`withDeadline`]. */
export function isDeadlineError(err: unknown): err is DeadlineError {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === BIND_TIMEOUT_CODE;
}

/** Human-readable duration for the error text: "3 minutes", "90 seconds". */
export function describeMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const s = Math.round(ms / 1000);
  return `${s} second${s === 1 ? "" : "s"}`;
}

/**
 * Await `promise`, but reject with a [`DeadlineError`] after `ms`.
 *
 * `label` names the hop for the error text — "Codex has not answered
 * `session/new` in 3 minutes" — so the report says WHICH step hung. The timer
 * is cleared as soon as the promise settles either way, so a fast hop leaves
 * nothing behind.
 *
 * `stillWorking`, when given, is asked each time the deadline passes: while it
 * answers true the hop is visibly making progress (an install reporting
 * status), so the deadline re-arms for another `ms` instead of rejecting.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  stillWorking?: () => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (stillWorking?.()) arm();
        else reject(new DeadlineError(`${label} in ${describeMs(ms)}`));
      }, ms);
    };
    arm();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A `stillWorking` that answers true only while `read()` keeps CHANGING.
 *
 * The bind used to pass `() => !!status`, which re-armed the deadline for as
 * long as any status string existed. An install that reported "Installing …"
 * once and then wedged kept that string forever, so the deadline never fired
 * and the chat read "Installing …" for the life of the app. The backend's
 * install jobs now restate their status with the elapsed time while they run,
 * so "changed since last asked" is a liveness signal: a job that is alive
 * moves, a wedged one does not.
 */
export function progressSince(read: () => string | undefined): () => boolean {
  let last = read();
  return () => {
    const now = read();
    const moved = !!now && now !== last;
    last = now;
    return moved;
  };
}
