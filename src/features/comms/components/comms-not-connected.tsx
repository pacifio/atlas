import { useState } from "react";
import { Loader2, MessageCircle, Rss } from "lucide-react";
import { DitherField } from "@tryatlas/design";
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
    <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-2.5 overflow-hidden px-8 text-center">
      {/* Dots at the package defaults are the look this panel always had: the
          foreground at 16% on a 4px grid, hollow in the middle for the copy.
          Unlike the field it replaced, it holds still under reduced motion
          (one frame, no drift) and parks while off screen. */}
      <DitherField mode="dots" />
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-card text-secondary-foreground">
        <MessageCircle size={16} />
      </span>
      {/* Text hierarchy is one rung brighter than the chrome's default. This is
          the only content on the panel, so `--text-disabled` — the dim rung for
          decoration and disabled state — left the one explanation unreadable
          against the near-black surface. */}
      <div className="relative text-sm font-medium text-foreground">
        {org ? `${org.name} isn't connected` : "No organization selected"}
      </div>
      <p className="relative max-w-[220px] text-xs leading-relaxed text-secondary-foreground">
        {org
          ? "Team chat needs this organization synced to your Atlas account."
          : "Select an organization to use team chat."}
      </p>
      {org && (
        <button
          type="button"
          disabled={syncing}
          onClick={connect}
          // The iOS frosted pill: translucent monochrome fill + backdrop blur
          // softening the dither behind it, hairline top light. Static blur on
          // one element — the vibrant-panel rule bans transform ANIMATION near
          // blur, not a still frosted control (the drop overlay already blurs
          // inside this panel).
          className="relative mt-1 flex h-control-lg items-center gap-1.5 rounded-full border border-border-strong bg-element-active px-4 text-sm font-medium text-foreground inset-highlight backdrop-blur-md transition-colors hover:bg-[var(--element-emphasis)] disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
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
