import {
  ArrowLeftRight,
  ArrowUpRight,
  Cloud,
  History,
  Laptop,
  Layers,
  RefreshCw,
} from "lucide-react";

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
        <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-[var(--atlas-element-active)] px-2.5 py-1.5">
          <span className="text-xs text-[var(--secondary-foreground)]">
            History import is waiting for your review.
          </span>
          <button
            type="button"
            disabled={busy || !importPreview}
            onClick={onReviewImport}
            className="shrink-0 cursor-pointer rounded-full px-1.5 py-0.5 text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review
          </button>
        </div>
      )}

      {/* Failed rows: the retry is a deliberate human action, never automatic. */}
      {failed > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--atlas-status-warning-background)] px-2.5 py-1.5">
          <span className="text-xs text-[var(--atlas-status-warning-foreground)]">
            {failed} record{failed === 1 ? "" : "s"} could not be sent.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={onRetryFailed}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={10} />
            Retry
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {/* Where this Project's Sessions live. A label, not a control — the
         *  way to change it is the Sync button beside it. */}
        <span className="mr-auto flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
          {binding.mode === "cloud" ? <Cloud size={11} /> : <Laptop size={11} />}
          {binding.mode === "cloud" ? "Cloud" : "Local"}
        </span>

        {/* Promotion pushes to the same ingest service Create-Cloud and Connect
         *  use, so it is offered on exactly the same condition — and when that
         *  condition fails it stays on screen, disabled, rather than vanishing.
         *  A control that disappears reads as a feature that does not exist. */}
        {binding.mode === "local" &&
          (cloudReason ? (
            <button
              type="button"
              disabled
              title={cloudReason}
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--muted-foreground)] opacity-40"
            >
              <Cloud size={11} />
              Sync
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onPromote}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-selected)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpRight size={11} />
              Sync
            </button>
          ))}

        {/* The Cloud counterpart of Sync: the destination is a choice, not a
         *  fact, and the way to change it lives beside the label that states
         *  it. Same availability rule as Sync — it needs the server. */}
        {binding.mode === "cloud" &&
          (cloudReason ? (
            <button
              type="button"
              disabled
              title={cloudReason}
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--muted-foreground)] opacity-40"
            >
              <ArrowLeftRight size={11} />
              Change
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onSwitch}
              title="Sync to a different Project"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-selected)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeftRight size={11} />
              Change
            </button>
          ))}

        {binding.enabled ? (
          <GhostButton label="Pause capture" disabled={busy} onClick={onPause} />
        ) : (
          <PrimaryButton busy={busy} onClick={onResume} label="Resume capture" />
        )}
      </div>

      {!binding.enabled && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Paused. Nothing already recorded has been deleted.
        </p>
      )}
    </div>
  );
}
