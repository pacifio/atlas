import { useEffect, useState } from "react";

import { useSlugAvailability } from "../hooks/use-slug-availability";
import type { CloudDraft, CloudOrg, PromoteTab, RunAction } from "../lib/capture-flow";
import type { ConnectPick, Detection } from "../types";
import { ConnectTab } from "./connect-tab";
import { Tabs } from "./views/controls";
import { PromoteCreateView } from "./views/promote-create-view";

/** Promotion step one: pick the Organisation and Slug the history will live under. */
export function PromoteForm({
  projectPath,
  detection,
  cloudOrgs,
  cloudReason,
  tab,
  onTabChange,
  busy,
  run,
  onCancel,
  onContinue,
  onConnectContinue,
}: {
  projectPath: string;
  detection: Detection | null;
  cloudOrgs: CloudOrg[];
  cloudReason: string | null;
  tab: PromoteTab;
  onTabChange: (tab: PromoteTab) => void;
  busy: boolean;
  run: RunAction;
  onCancel: () => void;
  /** Create: a new Project under this Slug. */
  onContinue: (draft: CloudDraft) => void;
  /** Connect: an existing Project the Organisation already has. */
  onConnectContinue: (pick: ConnectPick) => void;
}) {
  const [orgId, setOrgId] = useState<string>(cloudOrgs[0]?.remoteId ?? "");
  const [slug, setSlug] = useState(detection?.suggestedSlug ?? "");
  const [gitUrl, setGitUrl] = useState(detection?.gitUrl ?? "");
  const [restricted, setRestricted] = useState(false);
  const slugState = useSlugAvailability(projectPath, orgId, slug);

  useEffect(() => {
    if (!orgId && cloudOrgs[0]) setOrgId(cloudOrgs[0].remoteId);
  }, [orgId, cloudOrgs]);
  const ready =
    !!orgId &&
    slug.trim().length > 0 &&
    slugState.kind !== "taken" &&
    slugState.kind !== "checking";

  // Same rule as the unbound form: Connect has nothing to show without the
  // Organisation's Project list, so it is disabled with the reason rather
  // than opened onto an error.
  const connectDisabled = !!cloudReason;
  const activeTab = connectDisabled ? "create" : tab;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-[var(--foreground)]">Promote to Cloud</p>
      <p className="text-xs text-[var(--muted-foreground)]">
        {activeTab === "create"
          ? "Everything captured here joins your Organization's timeline. You'll see exactly what before anything is sent."
          : "Attach this Project's history to a Project your Organization already has. You'll see exactly what before anything is sent."}
      </p>
      <Tabs
        tab={activeTab}
        onTabChange={onTabChange}
        connectDisabled={connectDisabled}
        connectReason={cloudReason}
        label="Promote to Cloud"
      />
      {activeTab === "create" ? (
        <PromoteCreateView
          key="create"
          cloudOrgs={cloudOrgs}
          slug={slug}
          onSlugChange={setSlug}
          slugState={slugState}
          gitUrl={gitUrl}
          onGitUrlChange={setGitUrl}
          restricted={restricted}
          onRestrictedChange={setRestricted}
          onConnectInstead={connectDisabled ? undefined : () => onTabChange("connect")}
          busy={busy}
          ready={ready}
          onCancel={onCancel}
          onContinue={() =>
            onContinue({ orgId, slug: slug.trim(), gitUrl: gitUrl.trim(), restricted })
          }
        />
      ) : (
        <div key="connect" className="atlas-fade-in">
          <ConnectTab
            projectPath={projectPath}
            cloudOrgs={cloudOrgs}
            cloudReason={cloudReason}
            busy={busy}
            run={run}
            onCancel={onCancel}
            onContinue={onConnectContinue}
          />
        </div>
      )}
    </div>
  );
}
