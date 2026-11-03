import { Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";

import type { CloudOrg, SlugState } from "../../lib/capture-flow";
import { FIELD, GROUP } from "./styles";

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
  return (
    <div className={cn(GROUP, "space-y-2")}>
      {/* A label, not a picker: the destination is the Organisation you have
       *  open. Choosing another one here would bind this repository into a
       *  tenant you are not looking at, and the mistake only shows up later in
       *  someone else's timeline. */}
      <div className="flex items-center gap-2">
        <span className="w-[70px] shrink-0 text-xs text-[var(--muted-foreground)]">
          Organization
        </span>
        <span className="truncate text-xs text-[var(--secondary-foreground)]">
          {cloudOrgs[0]?.name ?? "—"}
        </span>
      </div>

      <label className="flex items-center gap-2">
        <span className="w-[70px] shrink-0 text-xs text-[var(--muted-foreground)]">Slug</span>
        <input
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="my-project"
          className={cn(FIELD, "h-7 flex-1 font-mono text-xs")}
        />
      </label>

      <SlugStatus state={slugState} onConnectInstead={onConnectInstead} />

      {/* A URL and nothing more — it is what lets a teammate's desktop find
       *  this Project from their own checkout's origin. Prefilled from the
       *  detected remote, and cleared on purpose is a real answer. */}
      <label className="flex items-center gap-2">
        <span className="w-[70px] shrink-0 text-xs text-[var(--muted-foreground)]">Repository</span>
        <input
          value={gitUrl}
          onChange={(e) => onGitUrlChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="github.com/acme/my-project"
          className={cn(FIELD, "h-7 flex-1 font-mono text-xs")}
        />
      </label>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={restricted}
          onChange={(e) => onRestrictedChange(e.target.checked)}
          className="mt-0.5 size-3 shrink-0 cursor-pointer accent-[var(--primary)]"
        />
        <span className="min-w-0">
          <span className="text-xs text-[var(--secondary-foreground)]">
            Restrict to named members
          </span>
          <span className="block text-2xs text-[var(--muted-foreground)]">
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
  return (
    <p className="flex items-center gap-1 pl-[78px] text-2xs">
      {state.kind === "checking" && (
        <>
          <Loader2 size={10} className="animate-spin text-[var(--muted-foreground)]" />
          <span className="text-[var(--muted-foreground)]">checking…</span>
        </>
      )}
      {state.kind === "available" && (
        <>
          <Check size={10} className="text-[var(--secondary-foreground)]" />
          <span className="text-[var(--secondary-foreground)]">available</span>
        </>
      )}
      {state.kind === "taken" && (
        <>
          <X size={10} className="text-[var(--atlas-status-error-foreground)]" />
          <span className="text-[var(--atlas-status-error-foreground)]">
            taken in this Organization
          </span>
          {onConnectInstead && (
            <button
              type="button"
              onClick={onConnectInstead}
              className="cursor-pointer text-[var(--secondary-foreground)] underline underline-offset-2 transition-colors duration-150 hover:text-[var(--foreground)]"
            >
              connect to it instead
            </button>
          )}
        </>
      )}
      {state.kind === "unknown" && (
        <>
          <span className="text-[var(--atlas-status-warning-foreground)]">couldn't check</span>
          <button
            type="button"
            onClick={state.retry}
            className="cursor-pointer text-[var(--secondary-foreground)] underline underline-offset-2 transition-colors duration-150 hover:text-[var(--foreground)]"
          >
            retry
          </button>
        </>
      )}
    </p>
  );
}
