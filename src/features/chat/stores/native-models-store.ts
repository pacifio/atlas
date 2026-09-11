// The native agent's model-list refresh (ADR-0007), in its own store for the
// same reason the AI-grant probe is: every open composer shows the same
// picker, so a refresh started from one tab must show as in flight in all
// of them and land its result in all of them. Mirrors `ai-grant-store`.
//
// The list itself lives on the chat store's sessions (`acpAvailableModels`),
// which is what the picker reads; this store only owns the in-flight bit and
// the call.

import { create } from "zustand";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import { agents } from "../lib/agents-api";
import { errInfo } from "../lib/agent-signin";
import { useActiveGatewayOrgId } from "./ai-grant-store";
import { useChatStore } from "./chat-store";

/** The agent type whose list the refresh replaces. The native agent keeps
 *  the storage id it always had (D7) — see `CERSEI_AGENT_ID` on the Rust
 *  side. */
const NATIVE_AGENT_TYPE = "cersei";

interface NativeModelsState {
  /** A refresh is in flight. */
  refreshing: boolean;
  actions: {
    /** Ask the gateway for the list again and push it to every native
     *  session. Returns `true` when the gateway answered. Errors surface as
     *  a toast unless `silent` — the org-switch path, where the composer is
     *  already explaining the org change and a second toast would compete. */
    refresh: (opts?: { silent?: boolean }) => Promise<boolean>;
  };
}

/** The in-flight refresh, shared so N composers clicking at once make one
 *  call. A promise, not state: nothing renders it. */
let inFlight: Promise<boolean> | null = null;

export const useNativeModelsStore = createSelectors(
  create<NativeModelsState>()((set) => ({
    refreshing: false,
    actions: {
      refresh: (opts) => {
        if (inFlight) return inFlight;
        const run = async (): Promise<boolean> => {
          set({ refreshing: true });
          try {
            const result = await agents.refreshNativeModels();
            useChatStore.getState().actions.setAcpModelsForAgent(NATIVE_AGENT_TYPE, result.models);
            if (result.reconnected && !opts?.silent) {
              // The sessions themselves show the Restart affordance; this
              // just says why it appeared.
              toast.info(
                "Model list updated — open Atlas Agent chats will restart on their next message.",
              );
            }
            return true;
          } catch (err) {
            if (!opts?.silent) toast.error(errInfo(err).message);
            return false;
          } finally {
            set({ refreshing: false });
          }
        };
        const started = run().finally(() => {
          if (inFlight === started) inFlight = null;
        });
        inFlight = started;
        return started;
      },
    },
  })),
);

/**
 * Refreshes the list when the user switches to another synced organisation.
 *
 * The native agent's model list is entitled PER ORG (ADR-0007), and its
 * connection is not re-established on an org switch — so without this the
 * picker would keep the previous org's list until the next launch. Only a
 * switch from one synced org to another counts: the first org at mount is
 * covered by the connect-time fetch, and a local org has no list to refresh.
 *
 * Mounted from the composer next to `useAiGrantProbe`, so N open tabs mount
 * it N times; the store's in-flight promise collapses those to one call.
 */
export function useNativeModelsOrgRefresh(): void {
  const orgId = useActiveGatewayOrgId();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = orgId;
    if (!orgId || !before || before === orgId) return;
    void useNativeModelsStore.getState().actions.refresh({ silent: true });
  }, [orgId]);
}
