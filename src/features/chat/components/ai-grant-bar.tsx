import { useCallback, useState } from "react";
import { Cloud, MoveUpRight, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { isLocalOrg, useActiveOrganisation, useAiGrantStore } from "../stores/ai-grant-store";
import { COMPOSER_STRIP, COMPOSER_STRIP_ACTION } from "./composer-strip";

/**
 * The native agent's no-grant setup state (spec D15a, acceptance bar item 14).
 *
 * A signed-in user whose organisation has no AI grant is not having a failure,
 * they are having a **setup problem** — the gateway's own words. Shown as an
 * error it reads as something broken, and they go hunting for a switch to flip.
 * There is no such switch; an admin has to grant it, so the bar says that and
 * offers the two things the user *can* do: re-check, or ask to be counted.
 *
 * The composer below it is disabled while this shows (see `message-input.tsx`),
 * so this bar is the explanation for a dead input — which is why the strip is
 * attached to the composer rather than floating somewhere near it, and why
 * dismissing it does not re-enable anything.
 *
 * It was a centred floating pill until 2026-08-31. Two problems with that: it
 * shared the `z-20` floating row with "Scroll to bottom" (they overlapped when
 * both showed), and it rendered the gateway's raw sentence — which names the
 * organisation by *id*, a 26-character opaque string the user has never seen.
 * The org NAME is right there in the auth snapshot.
 */

// The strip itself lives in `composer-strip.ts`, shared with every other
// notice that tucks into the composer (`removed-agent-bar.tsx`).
const STRIP = COMPOSER_STRIP;
const ACTION = COMPOSER_STRIP_ACTION;

/** Where "Request" goes. The one place that can actually issue a grant. */
const GRANT_REQUEST_URL = "https://credits.tryatlas.cc/";

export function AiGrantBar({ turnRunning = false }: { turnRunning?: boolean }) {
  const snapshot = useAuthStore((s) => s.snapshot);
  // `AuthSnapshot` is a discriminated union — the orgs only exist on the
  // signed-in arm, which is also the only arm this bar renders under.
  const account = snapshot.status === "signed-in" ? snapshot : null;
  const activeOrgId = account?.activeOrgId ?? null;
  // The desktop's active org names the bar. The auth snapshot only knows the
  // account's CLOUD orgs, so it is the fallback, never the source — for a
  // local org it would name whichever cloud org the account last used.
  const org = useActiveOrganisation();
  const orgName = org?.name ?? account?.orgs?.find((o) => o.id === activeOrgId)?.name ?? null;
  const local = isLocalOrg(org);

  const entitlement = useAiGrantStore.use.entitlement();
  const checking = useAiGrantStore.use.checking();
  const dismissed = useAiGrantStore.use.dismissed();
  const { refresh, dismiss } = useAiGrantStore.use.actions();
  // The switcher's "Turn on sync for {org}…" item, offered here as well so the
  // one action that unlocks the agent is beside the notice that names it.
  const enableSync = useOrgStore((s) => s.actions.enableSync);
  const [syncing, setSyncing] = useState(false);
  const onTurnOnSync = useCallback(async () => {
    if (!org) return;
    // Signed out, `enableSync` opens sign-in and returns at once — no spinner
    // to show. Signed in it round-trips: hold the syncing state until it
    // settles (success → the bar goes away with the probe; failure → the
    // store's own toast).
    if (!account) {
      void enableSync(org.id);
      return;
    }
    setSyncing(true);
    try {
      await enableSync(org.id);
    } finally {
      setSyncing(false);
    }
  }, [account, enableSync, org]);

  const onRefresh = useCallback(async () => {
    // A failed re-check leaves the bar exactly as it was rather than clearing
    // it — vanishing on a dropped connection would read as "you have access now".
    if (!(await refresh())) toast.error("Could not reach the gateway.");
  }, [refresh]);

  // Requesting a grant is a page on the web, not a signal Atlas can send: the
  // gateway has no access-request endpoint, and the PostHog `ai_access_requested`
  // event this button used to fire told the user's own team nothing — it landed
  // in Atlas's analytics, where nobody could act on it. Open the credits page
  // and let the user ask somewhere that answers.
  const onRequest = useCallback(() => {
    void openUrl(GRANT_REQUEST_URL).catch((e) => toast.error(String(e)));
  }, []);

  if (dismissed) return null;
  // A running turn was admitted before the answer said no; the bar and the
  // composer lock wait for it to end (`grantLocksComposer` says why).
  if (turnRunning) return null;

  // A local organisation: not a grant that is missing, a link that is. The
  // native agent bills an org the gateway knows, and this one only exists on
  // this machine — so the only action is turning on sync, which lives in the
  // org switcher, not here.
  if (entitlement?.state === "localOrg" && local) {
    return (
      <div
        data-testid="ai-grant-bar"
        className={STRIP}
        title="Atlas Agent works with organizations synced to your account"
      >
        <span className="min-w-0 truncate">
          <span className="font-semibold text-[var(--foreground)]">
            {orgName ?? "This organization"}
          </span>
          <span className="text-[var(--muted-foreground)]">
            {" "}
            is local — sync it to use Atlas Agent
          </span>
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void onTurnOnSync()}
            disabled={syncing}
            title={
              account
                ? "Create this organization in your Atlas account"
                : "Sign in to sync this organization"
            }
            className={cn(ACTION, syncing ? "cursor-default" : "cursor-pointer")}
          >
            <Cloud size={11} className={cn(syncing && "animate-pulse")} />
            {syncing ? "Syncing…" : "Turn on sync"}
          </button>
          <Hint label="Dismiss" side="top">
            <button
              type="button"
              onClick={() => dismiss()}
              className="shrink-0 cursor-pointer rounded p-0.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              <X size={12} />
            </button>
          </Hint>
        </div>
      </div>
    );
  }

  if (entitlement?.state !== "noGrant") return null;

  return (
    <div data-testid="ai-grant-bar" className={STRIP} title={entitlement.message}>
      <span className="min-w-0 truncate">
        <span className="font-semibold text-[var(--foreground)]">
          {orgName ?? "This organization"}
        </span>
        <span className="text-[var(--muted-foreground)]"> doesn&apos;t have AI grants</span>
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={checking}
          title="Check again"
          className={cn(ACTION, checking ? "cursor-default" : "cursor-pointer")}
        >
          <RotateCw size={11} className={cn(checking && "animate-spin")} />
          Refresh
        </button>

        <button
          type="button"
          onClick={onRequest}
          title="Request AI credits for your organization"
          className={cn(ACTION, "cursor-pointer")}
        >
          <MoveUpRight size={11} />
          Request
        </button>

        <Hint label="Dismiss" side="top">
          <button
            type="button"
            onClick={() => dismiss()}
            className="shrink-0 cursor-pointer rounded p-0.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <X size={12} />
          </button>
        </Hint>
      </div>
    </div>
  );
}
