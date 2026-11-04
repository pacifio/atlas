import { RefreshCw } from "lucide-react";

import { Button, Callout } from "@tryatlas/design";

import type { CloudOrg, SlugState } from "../../lib/capture-flow";
import type { Detection, ImportPreview, ProjectMode } from "../../types";
import { CloudFields } from "./cloud-fields";
import { GhostButton, ModeOption, PrimaryButton, rovingKeys } from "./controls";
import { Detected, GitInitOffer, GitMissingBanner } from "./detected";
import { TimelinePreview } from "./timeline-preview";

/** The unbound Create tab: Local in one click, or the Cloud form. */
export function UnboundCreateView({
  mode,
  onModeChange,
  cloudReason,
  cloudOrgs,
  slug,
  onSlugChange,
  slugState,
  gitUrl,
  onGitUrlChange,
  restricted,
  onRestrictedChange,
  detection,
  importPreview,
  gitAvailable,
  busy,
  previewLoading,
  cloudReady,
  onGitInit,
  onRetryPreview,
  onCancel,
  onSubmit,
}: {
  mode: ProjectMode;
  onModeChange: (mode: ProjectMode) => void;
  cloudReason: string | null;
  cloudOrgs: CloudOrg[];
  slug: string;
  onSlugChange: (slug: string) => void;
  slugState: SlugState;
  gitUrl: string;
  onGitUrlChange: (url: string) => void;
  restricted: boolean;
  onRestrictedChange: (restricted: boolean) => void;
  detection: Detection | null;
  /** `undefined` = still loading, `null` = the read failed. */
  importPreview: ImportPreview | null | undefined;
  /** Is `git` on this machine? Not whether this directory is a repository. */
  gitAvailable: boolean;
  busy: boolean;
  previewLoading: boolean;
  cloudReady: boolean;
  onGitInit: () => void;
  onRetryPreview: () => void;
  onCancel: () => void;
  /** Enable (Local) or Continue to the disclosure (Cloud). */
  onSubmit: () => void;
}) {
  return (
    <div className="atlas-fade-in space-y-2.5">
      <div>
        <span className="text-xs font-medium text-secondary-foreground">
          Where sessions are stored
        </span>
        <div
          role="radiogroup"
          aria-label="Where sessions are stored"
          className="mt-1 flex gap-1"
          onKeyDown={(e) => rovingKeys(e, "radio", true)}
        >
          <ModeOption
            selected={mode === "local"}
            disabled={false}
            // Local is always available, so it holds the Tab stop when a
            // chosen Cloud has become unavailable.
            tabStop={mode === "local" || !!cloudReason}
            label="Local"
            onSelect={() => onModeChange("local")}
          />
          <ModeOption
            selected={mode === "cloud"}
            disabled={!!cloudReason}
            reason={cloudReason}
            label="Cloud"
            onSelect={() => onModeChange("cloud")}
          />
        </div>
        {/* Describes the CHOSEN mode, and only that. Why Cloud is
         *  unavailable rides on the disabled pill itself (lock glyph +
         *  title) rather than as a line of prose under a selected Local,
         *  where it read as Local being the thing that was broken. */}
        <p className="caption mt-1">
          {mode === "cloud"
            ? "Shared with your Organization."
            : "This machine only — no account needed."}
        </p>
      </div>

      {mode === "cloud" && (
        <CloudFields
          cloudOrgs={cloudOrgs}
          slug={slug}
          onSlugChange={onSlugChange}
          slugState={slugState}
          gitUrl={gitUrl}
          onGitUrlChange={onGitUrlChange}
          restricted={restricted}
          onRestrictedChange={onRestrictedChange}
        />
      )}

      <Detected detection={detection} importPreview={importPreview} />

      {!gitAvailable ? (
        <GitMissingBanner />
      ) : (
        detection &&
        !detection.isGitRepository && <GitInitOffer busy={busy} onGitInit={onGitInit} />
      )}

      {/* The preview read failed: Continue has nothing to disclose, so say
       *  so where it blocks, with the retry right there. */}
      {mode === "cloud" && importPreview === null && (
        <Callout
          tone="warning"
          icon={false}
          action={
            <Button variant="link" size="xs" onClick={onRetryPreview}>
              <RefreshCw size={10} />
              Retry
            </Button>
          }
        >
          Couldn't read this Project's history.
        </Callout>
      )}

      {/* Create only. The Connect tab is a list of existing Projects —
       *  someone there has already been sold on the Timeline. */}
      <TimelinePreview />

      <div className="flex justify-end gap-2 pt-0.5">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton
          busy={busy || previewLoading}
          disabled={!cloudReady}
          onClick={onSubmit}
          label={mode === "cloud" ? "Continue" : "Enable"}
        />
      </div>
    </div>
  );
}
