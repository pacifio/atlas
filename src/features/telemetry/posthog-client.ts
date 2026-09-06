/**
 * Frontend telemetry — `posthog-js` for **client-side failures only** (React
 * render errors, uncaught window errors, unhandled rejections). All product /
 * usage analytics is emitted from Rust (`crate::telemetry`); the JS side never
 * captures usage events, pageviews, autocapture, or session recordings.
 *
 * Consent + identity come from Rust via the `telemetry_config` command, so the
 * browser shares the same anonymous `distinct_id` and opt-in state. Nothing is
 * sent until the user has opted in AND a PostHog key resolved server-side.
 */
import posthog from "posthog-js";
import { invoke } from "@tauri-apps/api/core";

interface TelemetryConfig {
  enabled: boolean;
  host: string;
  /** Device-stable anonymous id (Rust's `device.json`). */
  anonId: string;
  /** Atlas account id when already signed in at boot, else null. */
  accountId: string | null;
  usingDefaultKey: boolean;
  /** Write-only project key, or null on an inert build (→ posthog never inits). */
  key: string | null;
}

/** The account a renderer-side `identify` should attribute crashes to. */
export interface TelemetryIdentity {
  /** Atlas user id — becomes the posthog distinct id. */
  distinctId: string;
  email?: string;
  name?: string;
  orgId?: string | null;
}

let initialized = false; // initTelemetry ran
let started = false; // posthog.init() called (a key resolved)
let enabled = false; // live opt-in gate
/**
 * An identity that arrived before posthog was ready.
 *
 * `initTelemetry()` is async and fire-and-forget from `main.tsx`, while the auth
 * restore broadcast can land first — so without this, a relaunch while signed in
 * would file that session's crashes against the anonymous device person.
 */
let pendingIdentity: TelemetryIdentity | null = null;

/**
 * Known-benign client errors we never report. These are common, undiagnosed,
 * and non-actionable across every Atlas build — sending them to PostHog just
 * burns event quota (they'd recur endlessly). Matched as substrings against the
 * error message + stack.
 *
 *  1. React's dev-only "state update on a not-yet-mounted component" warning —
 *     noise from async setState landing during mount; harmless, dev-only.
 *  2. `document`-not-defined ReferenceError from a bundled dependency that
 *     touches `document` off the main document context (e.g. a worker chunk).
 */
const IGNORED_ERROR_PATTERNS: string[] = [
  "state update on a component that hasn't mounted yet",
  "Can't find variable: document",
  "document is not defined",
];

function isIgnoredError(error: unknown): boolean {
  let text = "";
  if (error instanceof Error) {
    text = `${error.message}\n${error.stack ?? ""}`;
  } else if (typeof error === "string") {
    text = error;
  } else {
    text = safeString(error);
  }
  return IGNORED_ERROR_PATTERNS.some((p) => text.includes(p));
}

/**
 * Bootstrap from Rust once at startup. Initializes `posthog-js` with capturing
 * OFF, then opts in only if the user has enabled telemetry. Never throws.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  let cfg: TelemetryConfig;
  try {
    cfg = await invoke<TelemetryConfig>("telemetry_config");
  } catch {
    return; // command unavailable → stay dark
  }
  if (!cfg.key) return; // inert build → never load posthog

  try {
    posthog.init(cfg.key, {
      api_host: cfg.host,
      bootstrap: { distinctID: cfg.anonId },
      // Crash reporting only — disable every ambient capture surface.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      opt_out_capturing_by_default: true,
      persistence: "localStorage",
      // No feature flags, and — per the SDK docs — no remote config either.
      // Remote config is a <script> from us-assets.i.posthog.com with a fetch
      // fallback; the production CSP (script-src 'self', connect-src pinned to
      // the ingest host) refuses both, so in a packaged build every launch
      // logged two CSP violations for a feature this crash-only client never
      // used. Dev never showed it: Tauri applies no CSP to the Vite dev URL.
      advanced_disable_flags: true,
    });
    started = true;
    setEnabled(cfg.enabled);
    // Whichever arrived first wins: an identity pushed by the auth store while
    // we were still initialising, or the account Rust already knew about.
    const boot = pendingIdentity ?? (cfg.accountId ? { distinctId: cfg.accountId } : null);
    if (boot) identify(boot);
  } catch {
    /* posthog init failure must never break app boot */
  }
}

/**
 * Attribute subsequent renderer events (crashes) to an Atlas account, merging
 * the anonymous device person into it. Mirrors what Rust does for product
 * events — posthog-js keeps its own distinct id in localStorage, so the two
 * sides have to be told separately.
 *
 * Safe to call before init: the identity is queued and applied once ready.
 */
export function identify(id: TelemetryIdentity): void {
  if (!id.distinctId) return;
  pendingIdentity = id;
  if (!started || !enabled) return;
  try {
    posthog.identify(id.distinctId, {
      email: id.email,
      name: id.name,
      atlas_account: true,
      atlas_active_org_id: id.orgId ?? null,
    });
    if (id.orgId) posthog.group("organisation", id.orgId);
    pendingIdentity = null;
  } catch {
    /* never throw into the app */
  }
}

/**
 * Attribute subsequent renderer events to an Organisation.
 *
 * The mirror of Rust's `telemetry_set_org`: posthog-js keeps its own state, so
 * a crash reported from the renderer would otherwise land ungrouped even while
 * every Rust event carried the org. Registered as a super-property *as well as*
 * a group so it survives into `$exception` events, which is the only kind this
 * client sends.
 *
 * Called on every org change — including switches while signed out and to
 * local-only orgs, which is exactly the case sign-in-driven grouping missed.
 */
export function setOrgGroup(orgId: string | null): void {
  if (!started) return;
  try {
    if (orgId) {
      posthog.group("organisation", orgId);
      posthog.register({ atlas_org_id: orgId });
    } else {
      posthog.unregister("atlas_org_id");
    }
  } catch {
    /* never throw into the app */
  }
}

/**
 * Return to the anonymous device person on sign-out.
 *
 * Not optional: `persistence: "localStorage"` means the account's distinct id
 * outlives the session, so without this the next person to use the machine
 * would inherit it.
 */
export function resetIdentity(): void {
  pendingIdentity = null;
  if (!started) return;
  try {
    posthog.reset();
  } catch {
    /* ignore */
  }
}

/** Flip capturing on/off — mirrors the Settings toggle / first-run consent. */
export function setEnabled(on: boolean): void {
  enabled = on;
  if (!started) return;
  try {
    if (on) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
  } catch {
    /* ignore */
  }
  // Opting in is the first moment an identity held back by the consent gate can
  // actually be applied.
  if (on && pendingIdentity) identify(pendingIdentity);
}

/**
 * Report a client-side failure. No-op unless posthog is started and the user
 * has opted in. Swallows all errors so telemetry can never crash the app.
 */
export function captureClientError(error: unknown, context: Record<string, unknown> = {}): void {
  if (!started || !enabled) return;
  // Drop known-benign, non-actionable noise before it hits PostHog quota.
  if (isIgnoredError(error)) return;
  try {
    const raw = error instanceof Error ? error : new Error(safeString(error));
    // TELEMETRY.md's rule is "never send user content" — but a rejected
    // invoke's message routinely interpolates whatever the command touched:
    // absolute home paths, repo names, note ids, raw git/cargo stderr. Scrub
    // to shapes (paths → placeholders) rather than trusting each of ~365
    // command error strings to be clean, and cap the length so a stderr dump
    // cannot ride along.
    const err = new Error(scrubMessage(raw.message));
    err.name = raw.name;
    if (raw.stack) err.stack = scrubMessage(raw.stack);
    posthog.captureException(err, { $lib: "atlas-js", ...context });
  } catch {
    /* never throw into the app */
  }
}

/** Collapse identifying strings to their SHAPE. Order matters: home first.
 *  Exported for its test only. */
export function scrubMessage(text: string): string {
  return (
    text
      // Home directories, any user: `/Users/x/…` (mac), `/home/x/…` (linux).
      .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
      // Anything path-like that survives — keep the extension, drop the rest.
      .replace(/(?:~|\/)[\w.@-]+(?:\/[\w.@\-\u00C0-\uFFFF]+)+/g, (m) => {
        // Extension from the LEAF only \u2014 a dot in a middle segment is not one.
        const leaf = m.slice(m.lastIndexOf("/") + 1);
        const ext = leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".")) : "";
        return `<path${ext}>`;
      })
      // Bearer-ish tokens, defense in depth.
      .replace(/\b(?:ey[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{20,})\b/g, "<token>")
      .slice(0, 600)
  );
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}
