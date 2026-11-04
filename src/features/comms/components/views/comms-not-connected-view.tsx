import { MessageCircle, Rss } from "lucide-react";
import { Button, DitherField, EmptyState, Icon, Spinner } from "@tryatlas/design";

/**
 * What the chat panel shows when the active organisation is local-only: the
 * one explanation and the one action that fixes it, over the dither field.
 */
export function CommsNotConnectedView({
  orgName,
  signedIn,
  syncing,
  onConnect,
}: {
  /** `null` when no organisation is selected: no action to offer. */
  orgName: string | null;
  signedIn: boolean;
  syncing: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      data-view="comms-not-connected"
      className="relative flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden"
    >
      {/* Dots at the package defaults are the look this panel always had: the
          foreground at 16% on a 4px grid, hollow in the middle for the copy.
          Unlike the field it replaced, it holds still under reduced motion
          (one frame, no drift) and parks while off screen. */}
      <DitherField mode="dots" />
      {/* `relative` so the copy paints above the absolutely placed field. */}
      <div className="relative">
        <EmptyState
          icon={MessageCircle}
          title={orgName ? `${orgName} isn't connected` : "No organization selected"}
          description={
            orgName
              ? "Team chat needs this organization synced to your Atlas account."
              : "Select an organization to use team chat."
          }
          action={
            orgName ? (
              // Filled, not outline: a transparent button lets the dots
              // show through its label.
              <Button variant="secondary" size="lg" disabled={syncing} onClick={onConnect}>
                {syncing ? <Spinner size="sm" label="" /> : <Icon icon={Rss} size="sm" />}
                {syncing ? "Connecting…" : signedIn ? "Connect" : "Sign in to connect"}
              </Button>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
