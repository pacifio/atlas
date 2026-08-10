/**
 * Tell both analytics sides which Organisation the user is working in.
 *
 * Atlas emits from two places — Rust for product events, `posthog-js` for
 * renderer crashes — and neither can infer the active org on its own. This is
 * the single funnel that keeps them agreeing, so an event is either grouped on
 * both sides or on neither.
 *
 * **Why this is not derived from sign-in.** The active Organisation is a local
 * fact: it switches with no auth transition, it exists while signed out, and a
 * local-only org has no server row to read it from. Attributing events by
 * whatever org the *auth snapshot* last reported meant local orgs produced
 * ungrouped "global" events and a switch kept filing work under the previous
 * tenant. See `crate::telemetry::TelemetryClient::set_active_org`.
 *
 * Only the id travels. Whether the org is synced, its name, and the user's role
 * in it are resolved in Rust, which is where the rule about what may leave the
 * machine belongs.
 */

import { invoke } from "@tauri-apps/api/core";

import { setOrgGroup } from "@/features/telemetry/posthog-client";

/**
 * Point analytics at `orgId` (or un-group with `null`).
 *
 * Fire-and-forget and never throws: analytics attribution must not be able to
 * fail an org switch. Both sides de-duplicate an unchanged org, so calling this
 * from every path that can change the active org is cheap and correct — the
 * startup seed and the store's first hydrate both fire on every launch.
 */
export function syncOrgTelemetry(orgId: string | null): void {
  void invoke("telemetry_set_org", { orgId }).catch(() => {});
  setOrgGroup(orgId);
}
