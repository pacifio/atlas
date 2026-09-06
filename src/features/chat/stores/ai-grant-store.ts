// The native agent's AI-grant state, in its own store because TWO surfaces
// need the same answer and neither may probe the gateway independently.
//
// `AiGrantBar` explains the state; the composer is DISABLED by it. Left as
// local state in the bar (where it started) the composer could not see it, and
// giving each surface its own probe would ask the gateway the same question
// twice per org switch and let the two disagree mid-flight — a live composer
// under a bar saying the org cannot use AI, or worse the reverse.
//
// The probe is owned by exactly one caller (`useAiGrantProbe`, mounted in
// `message-input.tsx`) and everything else reads.

import { create } from "zustand";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { useAuthStore } from "@/features/auth/stores/auth-store";

/** What the gateway said about this account's AI access. */
export type Entitlement =
  | { state: "entitled"; models: string[] }
  | { state: "noGrant"; message: string }
  | { state: "unknown"; reason: string };

interface AiGrantState {
  /** `null` = not asked yet, or asked and we could not find out. */
  entitlement: Entitlement | null;
  /** The org the current answer is ABOUT. Guards against a stale answer being
   *  read as the new org's, and lets N mounted composers share one probe. */
  probedOrgId: string | null;
  /** A re-check is in flight (the bar's Refresh). */
  checking: boolean;
  /** The access request is in flight. */
  requesting: boolean;
  /** This org's ask has been recorded — reset when the org changes. */
  requested: boolean;
  /** The bar has been dismissed for this org. Does NOT re-enable the
   *  composer: hiding the notice does not create a grant. */
  dismissed: boolean;
  actions: {
    /** Ask the gateway. Returns the answer, or `null` when the probe itself
     *  failed — "we could not find out" is never rendered as a refusal. */
    probe: () => Promise<Entitlement | null>;
    /** Re-check on the user's command. Keeps the last known answer when the
     *  probe fails, so a dropped connection cannot read as "you have access". */
    refresh: () => Promise<boolean>;
    /** Record the ask with the team (PostHog `ai_access_requested`). */
    request: () => Promise<void>;
    dismiss: () => void;
    /** Drop every per-org bit. Called when the active org changes. */
    resetForOrg: () => void;
    /** Probe once per org, however many composers are mounted. */
    ensureProbed: (orgId: string | null) => void;
  };
}

/** The in-flight probe, shared by every caller so N mounted composers ask the
 *  gateway once. Module-level rather than store state: it is a promise, not
 *  something anything renders. */
let inFlight: Promise<Entitlement | null> | null = null;

export const useAiGrantStore = createSelectors(
  create<AiGrantState>()((set, get) => ({
    entitlement: null,
    probedOrgId: null,
    checking: false,
    requesting: false,
    requested: false,
    dismissed: false,
    actions: {
      probe: () => {
        if (inFlight) return inFlight;
        // The org this answer will be ABOUT, captured before the await.
        const askedFor = get().probedOrgId;
        const run = async (): Promise<Entitlement | null> => {
          try {
            const result = await invoke<Entitlement>("native_agent_entitlement");
            // The user can switch orgs mid-flight. A refusal that belongs to
            // org1 must never land on org2 and lock its composer.
            if (get().probedOrgId === askedFor) set({ entitlement: result });
            return result;
          } catch {
            // A probe that fails tells us nothing about the grant.
            return null;
          }
        };
        const started = run().finally(() => {
          // Only clear if a newer probe has not already replaced this one.
          if (inFlight === started) inFlight = null;
        });
        inFlight = started;
        return started;
      },
      refresh: async () => {
        set({ checking: true });
        const result = await get().actions.probe();
        set({ checking: false });
        return result !== null;
      },
      request: async () => {
        set({ requesting: true });
        try {
          await invoke("native_agent_request_access");
          set({ requested: true });
        } finally {
          set({ requesting: false });
        }
      },
      dismiss: () => set({ dismissed: true }),
      resetForOrg: () =>
        set({
          entitlement: null,
          probedOrgId: null,
          requested: false,
          dismissed: false,
          checking: false,
        }),
      ensureProbed: (orgId) => {
        const { probedOrgId, actions } = get();
        // Already answered (or answering) for this org — the second, third and
        // Nth composer just read what the first one fetched.
        if (probedOrgId === orgId) return;
        actions.resetForOrg();
        set({ probedOrgId: orgId });
        // Any probe still running is asking about the org we just left, so it
        // must not be reused as this org's answer.
        inFlight = null;
        void actions.probe();
      },
    },
  })),
);

/**
 * Drives the probe from the composer.
 *
 * Safe to mount N times — one per open chat tab, which split view and
 * background workspaces both produce. `ensureProbed` collapses them to a
 * single gateway call per org; without that, every tab would probe on mount
 * and each one's reset would wipe the answer the others just fetched.
 *
 * Re-probes on an ORG switch as well as sign-in: the grant belongs to the
 * organisation, so the answer for org1 says nothing about org2.
 */
export function useAiGrantProbe(): void {
  const snapshot = useAuthStore((s) => s.snapshot);
  const signedIn = snapshot.status === "signed-in";
  const activeOrgId = snapshot.status === "signed-in" ? (snapshot.activeOrgId ?? null) : null;

  useEffect(() => {
    const { resetForOrg, ensureProbed } = useAiGrantStore.getState().actions;
    // Signed out there is no token to ask with, and no grant to speak of.
    if (!signedIn) resetForOrg();
    else ensureProbed(activeOrgId);
  }, [signedIn, activeOrgId]);
}

/**
 * `true` only when the gateway gave a definite no.
 *
 * Not "we could not find out" and not "not asked yet" — both of those must
 * leave the composer alone. Offline is not a refusal.
 */
export function useNoAiGrant(): boolean {
  return useAiGrantStore((s) => s.entitlement?.state === "noGrant");
}
