import {
  ArrowLeftRight,
  ArrowUpRight,
  Cloud,
  History,
  Laptop,
  Layers,
  RefreshCw,
} from "lucide-react";

import { Badge, Button, Callout } from "@tryatlas/design";
import { cn } from "@/lib/utils";

import type { CloudOrg } from "../../lib/capture-flow";
import type { Binding, CaptureHealth, Detection, ImportPreview } from "../../types";
import { StatusRow } from "../status-row";
import { GhostButton, PrimaryButton } from "./controls";
import { Detected, GitInitOffer, GitMissingBanner } from "./detected";
import { GROUP } from "./styles";

/** Already bound: state and the actions that change it, not another form. */
export function BoundStateView({
  binding,
  detection,
  gitAvailable,
  health,
  importPreview,
  cloudOrgs,
  cloudReason,
  busy,
  onGitInit,
  onRetryFailed,
  onPause,
  onResume,
  onReviewImport,
  onPromote,
  onSwitch,
}: {
  binding: Binding;
  detection: Detection | null;
  /** Is `git` on this machine? Not whether this directory is a repository. */
  gitAvailable: boolean;
  health: CaptureHealth | null;
  importPreview: ImportPreview | null | undefined;
  cloudOrgs: CloudOrg[];
  /** Non-null when Cloud is unavailable, and why. Hides Promote. */
  cloudReason: string | null;
  busy: boolean;
  onGitInit: () => void;
  onRetryFailed: () => void;
  onPause: () => void;
  /** Always re-enables as "local" — see `captureEnableLocal`. */
  onResume: () => void;
  onReviewImport: () => void;
  onPromote: () => void;
  /** Cloud only: sync this Project to a different Cloud Project. */
  onSwitch: () => void;
}) {
  const orgName =
    binding.orgId != null
      ? (cloudOrgs.find((org) => org.remoteId === binding.orgId)?.name ?? null)
      : null;
  const pending = health?.pendingRows ?? 0;
  const failed = health?.failedRows ?? 0;

  return (
    <div className="space-y-2">
      {binding.mode === "cloud" && binding.slug && (
        <div className={cn(GROUP, "space-y-1.5")}>
          <StatusRow
            icon={Layers}
            ok
            value={orgName ? `${orgName} / ${binding.slug}` : binding.slug}
            caption="shared as"
            mono={false}
          />
          {pending > 0 && (
            <StatusRow
              icon={History}
              ok={false}
              value={`${pending} pending — sends when online`}
              caption="queue"
              mono={false}
            />
          )}
        </div>
      )}

      <Detected detection={detection} importPreview={importPreview} />

      {/* Git is not required, and the offer says what it unlocks rather than
       *  demanding anything. Sessions are already being captured either way.
       *  With no git on the machine there is nothing to offer, only to state. */}
      {!gitAvailable ? (
        <GitMissingBanner />
      ) : (
        detection &&
        !detection.isGitRepository && <GitInitOffer busy={busy} onGitInit={onGitInit} />
      )}

      {/* A Cloud Project whose bulk import was never approved imports
       *  nothing, forever, on purpose. Say so where it can be resolved. */}
      {binding.mode === "cloud" && !binding.importApproved && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-element-active px-2.5 py-1.5">
          <span className="text-xs text-secondary-foreground">
            History import is waiting for your review.
          </span>
          <Button
            variant="link"
            size="xs"
            disabled={busy || !importPreview}
            onClick={onReviewImport}
          >
            Review
          </Button>
        </div>
      )}

      {/* Failed rows: the retry is a deliberate human action, never automatic. */}
      {failed > 0 && (
        <Callout
          tone="warning"
          icon={false}
          action={
            <Button variant="link" size="xs" disabled={busy} onClick={onRetryFailed}>
              <RefreshCw size={10} />
              Retry
            </Button>
          }
        >
          {failed} record{failed === 1 ? "" : "s"} could not be sent.
        </Callout>
      )}

      <div className="flex items-center gap-2 pt-1">
        {/* Where this Project's Sessions live. A label, not a control — the
         *  way to change it is the Sync button beside it. */}
        <span className="mr-auto">
          <Badge variant="outline" size="md">
            {binding.mode === "cloud" ? <Cloud size={10} /> : <Laptop size={10} />}
            {binding.mode === "cloud" ? "Cloud" : "Local"}
          </Badge>
        </span>

        {/* Promotion pushes to the same ingest service Create-Cloud and Connect
         *  use, so it is offered on exactly the same condition — and when that
         *  condition fails it stays on screen, disabled, rather than vanishing.
         *  A control that disappears reads as a feature that does not exist. */}
        {binding.mode === "local" &&
          (cloudReason ? (
            <Button variant="secondary" size="sm" disabled title={cloudReason}>
              <Cloud size={11} />
              Sync
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onPromote}>
              <ArrowUpRight size={11} />
              Sync
            </Button>
          ))}

        {/* The Cloud counterpart of Sync: the destination is a choice, not a
         *  fact, and the way to change it lives beside the label that states
         *  it. Same availability rule as Sync — it needs the server. */}
        {binding.mode === "cloud" &&
          (cloudReason ? (
            <Button variant="secondary" size="sm" disabled title={cloudReason}>
              <ArrowLeftRight size={11} />
              Change
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onSwitch}
              title="Sync to a different Project"
            >
              <ArrowLeftRight size={11} />
              Change
            </Button>
          ))}

        {binding.enabled ? (
          <GhostButton label="Pause capture" disabled={busy} onClick={onPause} />
        ) : (
          <PrimaryButton busy={busy} onClick={onResume} label="Resume capture" />
        )}
      </div>

      {!binding.enabled && (
        <p className="text-xs text-muted-foreground">
          Paused. Nothing already recorded has been deleted.
        </p>
      )}
    </div>
  );
}
