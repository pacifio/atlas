import type { CloudOrg, SlugState } from "../../lib/capture-flow";
import { CloudFields } from "./cloud-fields";
import { GhostButton, PrimaryButton } from "./controls";

/** Promotion onto a NEW Project: the Cloud fields and Continue. */
export function PromoteCreateView({
  cloudOrgs,
  slug,
  onSlugChange,
  slugState,
  gitUrl,
  onGitUrlChange,
  restricted,
  onRestrictedChange,
  onConnectInstead,
  busy,
  ready,
  onCancel,
  onContinue,
}: {
  cloudOrgs: CloudOrg[];
  slug: string;
  onSlugChange: (slug: string) => void;
  slugState: SlugState;
  gitUrl: string;
  onGitUrlChange: (url: string) => void;
  restricted: boolean;
  onRestrictedChange: (restricted: boolean) => void;
  onConnectInstead?: () => void;
  busy: boolean;
  ready: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="atlas-fade-in space-y-2">
      <CloudFields
        cloudOrgs={cloudOrgs}
        slug={slug}
        onSlugChange={onSlugChange}
        slugState={slugState}
        gitUrl={gitUrl}
        onGitUrlChange={onGitUrlChange}
        restricted={restricted}
        onRestrictedChange={onRestrictedChange}
        onConnectInstead={onConnectInstead}
      />
      <div className="flex justify-end gap-2 pt-1">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton busy={busy} disabled={!ready} onClick={onContinue} label="Continue" />
      </div>
    </div>
  );
}
