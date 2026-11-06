import { useState } from "react";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";
import { CommsNotConnectedView } from "./views/comms-not-connected-view";

/**
 * What the chat panel shows when the active organisation is local-only.
 *
 * Team chat is org-scoped and every route it uses names a **server** org id, so
 * an organisation with no `remoteId` has nothing to talk to — there is no
 * degraded mode to offer, only the one action that fixes it.
 *
 * Connecting is the org-wide "turn on sync" act, not a chat-specific one, so it
 * reuses `enableSync` rather than introducing a second path to the same state.
 * That action already knows what to do when signed out (open sign-in and return
 * immediately), which is why the spinner below is only armed when signed in.
 */
export function CommsNotConnected({ org }: { org: Organisation | null }) {
  const signedIn = useAuthStore.use.snapshot().status === "signed-in";
  const { enableSync } = useOrgStore.use.actions();
  const [syncing, setSyncing] = useState(false);

  const connect = () => {
    if (!org) return;
    if (!signedIn) {
      // Opens the sign-in dialog and returns at once — a spinner here would
      // hang until the browser round-trip finished somewhere else entirely.
      void enableSync(org.id);
      return;
    }
    setSyncing(true);
    void enableSync(org.id).finally(() => setSyncing(false));
  };

  return (
    <CommsNotConnectedView
      orgName={org?.name ?? null}
      signedIn={signedIn}
      syncing={syncing}
      onConnect={connect}
    />
  );
}
