import { useState } from "react";
import { Loader2, MessageCircle, Rss } from "lucide-react";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";

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
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2.5 px-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-elevated text-text-secondary">
        <MessageCircle size={16} />
      </span>
      {/* Text hierarchy is one rung brighter than the chrome's default. This is
          the only content on the panel, so `--text-ghost` (#333) — the rung for
          decoration and disabled state — left the one explanation unreadable
          against the near-black surface. */}
      <div className="text-[12px] font-medium text-text-primary">
        {org ? `${org.name} isn't connected` : "No organisation selected"}
      </div>
      <p className="max-w-[220px] text-[11px] leading-relaxed text-text-secondary">
        {org
          ? "Team chat needs this organisation synced to your Atlas account."
          : "Select an organisation to use team chat."}
      </p>
      {org && (
        <button
          type="button"
          disabled={syncing}
          onClick={connect}
          className="mt-0.5 flex h-[28px] items-center gap-1.5 rounded-full bg-[var(--comms-connect)] px-4 text-[11.5px] font-medium text-white transition-colors hover:bg-[var(--comms-connect-hover)] disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
        >
          {syncing ? (
            <Loader2 size={12} className="shrink-0 animate-spin" />
          ) : (
            <Rss size={12} className="shrink-0" />
          )}
          {syncing ? "Connecting…" : signedIn ? "Connect" : "Sign in to connect"}
        </button>
      )}
    </div>
  );
}
