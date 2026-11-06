import { useCallback, useState } from "react";
import { Cloud, CreditCard, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { isLocalOrg, useActiveOrganisation, useAiGrantStore } from "../stores/ai-grant-store";
import { ChatNoticeView } from "./views/chat-notice-view";

/**
 * The native agent's no-grant setup state (spec D15a, acceptance bar item 14).
 *
 * A signed-in user whose organisation has no AI grant is not having a failure,
 * they are having a **setup problem** — the gateway's own words. Shown as an
 * error it reads as something broken, and they go hunting for a switch to flip.
 * There is no such switch: a Free account has no Atlas Credits, so the bar
 * says that and offers the two things the user *can* do: re-check, or buy
 * credits on the billing page.
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

// Drawn as a tucked `ChatNoticeView`, the strip every composer notice shares
// (`removed-agent-bar.tsx`, `mode-restore-bar.tsx`…).

/** Where "Purchase" goes: the account's billing page, where credits are
 *  bought. A Free account has none to spend. */
const BILLING_URL = "https://app.tryatlas.cc/settings/billing";

/**
 * Whether the bar is on screen — the composer's other strips step aside
 * while it is (`message-input.tsx`): with no grant the native agent cannot
 * run at all, and a download offer or a mode notice above a dead input is
 * noise. Same conditions as the render below, read from the same stores.
 */
export function useAiGrantBarShown(turnRunning: boolean): boolean {
  const entitlement = useAiGrantStore.use.entitlement();
  const dismissed = useAiGrantStore.use.dismissed();
  const local = isLocalOrg(useActiveOrganisation());
  if (dismissed || turnRunning) return false;
  return (entitlement?.state === "localOrg" && local) || entitlement?.state === "noGrant";
}

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

  // Credits are bought on the web, not through a signal Atlas can send: the
  // gateway has no purchase endpoint. Open the billing page.
  const onPurchase = useCallback(() => {
    void openUrl(BILLING_URL).catch((e) => toast.error(String(e)));
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
      <ChatNoticeView
        placement="tucked"
        tone="neutral"
        data-testid="ai-grant-bar"
        title="Atlas Agent works with organizations synced to your account"
        action={{
          label: syncing ? "Syncing…" : "Turn on sync",
          icon: Cloud,
          title: account
            ? "Create this organization in your Atlas account"
            : "Sign in to sync this organization",
          busy: syncing,
          onClick: () => void onTurnOnSync(),
        }}
        onDismiss={() => dismiss()}
        dismissLabel="Dismiss"
      >
        <span className="font-semibold text-foreground">{orgName ?? "This organization"}</span> is
        local — sync it to use Atlas Agent
      </ChatNoticeView>
    );
  }

  if (entitlement?.state !== "noGrant") return null;

  return (
    <ChatNoticeView
      placement="tucked"
      tone="neutral"
      data-testid="ai-grant-bar"
      title={entitlement.message}
      action={{
        label: "Refresh",
        icon: RotateCw,
        title: "Check again",
        busy: checking,
        onClick: () => void onRefresh(),
      }}
      extraActions={[
        {
          label: "Purchase",
          icon: CreditCard,
          title: "Buy Atlas Credits on your account's billing page",
          onClick: onPurchase,
        },
      ]}
      onDismiss={() => dismiss()}
      dismissLabel="Dismiss"
    >
      <span className="font-semibold text-foreground">Atlas Credits</span> are not available for
      Free accounts
    </ChatNoticeView>
  );
}
