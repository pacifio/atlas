// What a failed pull-request read means, and when to ask again.
//
// The native commands reject with `{ kind, message?, retryAt? }` (see
// `PrError`); `classifyPrError` also reads a bare string or an `Error`, so a
// rejection from anywhere lands in one of the same kinds.
//
// The gh gate: once `gh` is found missing or signed out, or GitHub refuses
// for its rate limit, every repository would hit the same wall, so further
// reads wait — for a bounded time, never for the session. Focusing the window
// clears the gate: that is when someone who just ran `gh auth login` in a
// terminal comes back.

import type { PrError, PrErrorKind } from "./pull-requests-types";

const KINDS: ReadonlySet<PrErrorKind> = new Set([
  "notInstalled",
  "notAuthenticated",
  "rateLimited",
  "network",
  "notFound",
  "unsupported",
  "invalid",
  "failed",
]);

/** Read any rejection as a `PrError`. */
export function classifyPrError(error: unknown): PrError {
  if (error && typeof error === "object" && "kind" in error) {
    const raw = error as { kind: unknown; message?: unknown; retryAt?: unknown };
    if (typeof raw.kind === "string" && KINDS.has(raw.kind as PrErrorKind)) {
      return {
        kind: raw.kind as PrErrorKind,
        ...(typeof raw.message === "string" ? { message: raw.message } : {}),
        ...(typeof raw.retryAt === "number" ? { retryAt: raw.retryAt } : {}),
      };
    }
  }
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("rate limit")) return { kind: "rateLimited", message };
  if (lower.includes("gh auth login") || lower.includes("not logged in")) {
    return { kind: "notAuthenticated", message };
  }
  if (lower.includes("timed out") || lower.includes("network") || lower.includes("connect")) {
    return { kind: "network", message };
  }
  return { kind: "failed", message };
}

export function isPrError(error: unknown): error is PrError {
  return (
    !!error &&
    typeof error === "object" &&
    "kind" in error &&
    KINDS.has((error as { kind: PrErrorKind }).kind)
  );
}

/** A sentence for a person, without the host's raw wording where a better one exists. */
export function prErrorMessage(error: PrError): string {
  switch (error.kind) {
    case "notInstalled":
      return "Install the GitHub CLI (gh) to see pull requests.";
    case "notAuthenticated":
      return "Sign in with `gh auth login` to see pull requests.";
    case "rateLimited":
      return error.retryAt
        ? `GitHub's rate limit was reached; try again after ${new Date(error.retryAt).toLocaleTimeString()}.`
        : "GitHub's rate limit was reached; try again in a minute.";
    case "network":
      return "GitHub could not be reached.";
    case "notFound":
      return "That pull request was not found.";
    default:
      return error.message ?? "Something went wrong talking to GitHub.";
  }
}

// ── retry ───────────────────────────────────────────────────────────────

/** Attempts after the first for a transient failure. */
const NETWORK_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Whether a failed read is worth repeating at once. Only a transient
 *  failure is: a missing or signed-out `gh`, a refusal, or a rate limit will
 *  fail the same way, and the gate handles waiting those out. */
export function shouldRetryPrError(failureCount: number, error: unknown): boolean {
  const { kind } = classifyPrError(error);
  if (kind === "network") return failureCount < NETWORK_RETRIES;
  return false;
}

/** Back-off before retry `attempt` (0-based): doubling, jittered, capped. */
export function prRetryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

// ── the gh gate ─────────────────────────────────────────────────────────

/** How long a missing or signed-out `gh` holds reads back when the window
 *  is not refocused in between. */
export const GH_UNAVAILABLE_FOR_MS = 5 * 60_000;
/** A rate limit that named no reset. */
export const RATE_LIMIT_FALLBACK_MS = 60_000;

interface Gate {
  until: number;
  reason: PrError;
}

let gate: Gate | null = null;
let focusListening = false;

function listenForFocus(): void {
  if (focusListening || typeof window === "undefined") return;
  focusListening = true;
  window.addEventListener("focus", () => {
    // A rate limit is GitHub's to lift, not the window's.
    if (gate && gate.reason.kind !== "rateLimited") gate = null;
  });
}

/** Note how a read ended: a wall every repository would hit closes the gate. */
export function noteGhOutcome(error: PrError | null, now = Date.now()): void {
  if (error === null) {
    if (gate && gate.reason.kind !== "rateLimited") gate = null;
    return;
  }
  listenForFocus();
  if (error.kind === "notInstalled" || error.kind === "notAuthenticated") {
    gate = { until: now + GH_UNAVAILABLE_FOR_MS, reason: error };
  } else if (error.kind === "rateLimited") {
    const until =
      error.retryAt && error.retryAt > now ? error.retryAt : now + RATE_LIMIT_FALLBACK_MS;
    gate = { until, reason: error };
  }
}

/** Why reads are held back right now, or `null` when they may go. */
export function ghGate(now = Date.now()): PrError | null {
  if (gate && gate.until <= now) gate = null;
  return gate?.reason ?? null;
}

/** Test seam: open the gate. */
export function resetGhGateForTests(): void {
  gate = null;
}
