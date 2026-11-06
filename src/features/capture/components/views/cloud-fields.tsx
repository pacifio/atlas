import { useId } from "react";
import { Check, X } from "lucide-react";

import { Button, Checkbox, FieldLabel, Input, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";

import type { CloudOrg, SlugState } from "../../lib/capture-flow";
import { GROUP } from "./styles";

/** Org label + Slug, Repository URL and visibility, shared by Create-Cloud and Promote. */
export function CloudFields({
  cloudOrgs,
  slug,
  onSlugChange,
  slugState,
  gitUrl,
  onGitUrlChange,
  restricted,
  onRestrictedChange,
  onConnectInstead,
}: {
  cloudOrgs: CloudOrg[];
  slug: string;
  onSlugChange: (slug: string) => void;
  slugState: SlugState;
  /** Prefilled from the detected origin; editable, and legitimately empty. */
  gitUrl: string;
  onGitUrlChange: (url: string) => void;
  restricted: boolean;
  onRestrictedChange: (restricted: boolean) => void;
  onConnectInstead?: () => void;
}) {
  const slugId = useId();
  const gitUrlId = useId();

  return (
    <div className={cn(GROUP, "space-y-2")}>
      {/* A label, not a picker: the destination is the Organisation you have
       *  open. Choosing another one here would bind this repository into a
       *  tenant you are not looking at, and the mistake only shows up later in
       *  someone else's timeline. */}
      <div className="flex items-center gap-2">
        <span className="label w-[70px] shrink-0">Organization</span>
        <span className="truncate text-xs text-secondary-foreground">
          {cloudOrgs[0]?.name ?? "—"}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <FieldLabel htmlFor={slugId} className="w-[70px] shrink-0">
          Slug
        </FieldLabel>
        <Input
          id={slugId}
          size="sm"
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="my-project"
          className="flex-1 font-mono"
        />
      </div>

      <SlugStatus state={slugState} onConnectInstead={onConnectInstead} />

      {/* A URL and nothing more — it is what lets a teammate's desktop find
       *  this Project from their own checkout's origin. Prefilled from the
       *  detected remote, and cleared on purpose is a real answer. */}
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor={gitUrlId} className="w-[70px] shrink-0">
          Repository
        </FieldLabel>
        <Input
          id={gitUrlId}
          size="sm"
          value={gitUrl}
          onChange={(e) => onGitUrlChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="github.com/acme/my-project"
          className="flex-1 font-mono"
        />
      </div>

      <label className="flex cursor-pointer items-start gap-2">
        <span className="pt-px">
          <Checkbox checked={restricted} onCheckedChange={(next) => onRestrictedChange(next)} />
        </span>
        <span className="min-w-0">
          <span className="text-xs text-secondary-foreground">Restrict to named members</span>
          <span className="caption block">
            Otherwise every member of the Organization can read it and push to it. You can change
            this later.
          </span>
        </span>
      </label>
    </div>
  );
}

function SlugStatus({
  state,
  onConnectInstead,
}: {
  state: SlugState;
  /** Promote only: a taken Slug is usually the Project you meant to join. */
  onConnectInstead?: () => void;
}) {
  if (state.kind === "idle") return null;
  // Indented past the 70px label column and its gap, so the verdict sits under
  // the value it is about. Px like the column, not spacing steps: the rem
  // shrinks with the UI-scale setting and the label text does not.
  return (
    <p className="flex items-center gap-1 pl-[78px] text-2xs">
      {state.kind === "checking" && (
        <>
          <Spinner size="xs" label="" />
          <span className="text-muted-foreground">checking…</span>
        </>
      )}
      {state.kind === "available" && (
        <>
          <Check size={10} className="text-success" />
          <span className="text-success">available</span>
        </>
      )}
      {state.kind === "taken" && (
        <>
          <X size={10} className="text-error" />
          <span className="text-error">taken in this Organization</span>
          {onConnectInstead && (
            <Button variant="link" size="xs" onClick={onConnectInstead}>
              connect to it instead
            </Button>
          )}
        </>
      )}
      {state.kind === "unknown" && (
        <>
          <span className="text-warning">couldn't check</span>
          <Button variant="link" size="xs" onClick={state.retry}>
            retry
          </Button>
        </>
      )}
    </p>
  );
}
