import { useEffect, useState } from "react";

import { useSlugAvailability } from "../hooks/use-slug-availability";
import { captureEnableLocal, captureGitInit } from "../lib/capture-api";
import type { CloudDraft, CloudOrg, RunAction } from "../lib/capture-flow";
import type { Detection, ImportPreview, ProjectMode } from "../types";
import { ConnectTab } from "./connect-tab";
import { Tabs } from "./views/controls";
import { UnboundCreateView } from "./views/unbound-create-view";

/** Not yet bound: Create (Local one click / Cloud form) or Connect, as tabs. */
export function UnboundState({
  projectPath,
  detection,
  gitAvailable,
  importPreview,
  cloudReason,
  cloudOrgs,
  busy,
  run,
  onRetryPreview,
  onCancel,
  onCloudEnable,
}: {
  projectPath: string;
  detection: Detection | null;
  /** Is `git` on this machine? Not whether this directory is a repository. */
  gitAvailable: boolean;
  /** `undefined` = still loading, `null` = the read failed. */
  importPreview: ImportPreview | null | undefined;
  cloudReason: string | null;
  cloudOrgs: CloudOrg[];
  busy: boolean;
  run: RunAction;
  onRetryPreview: () => void;
  onCancel: () => void;
  onCloudEnable: (draft: CloudDraft) => void;
}) {
  const [tab, setTab] = useState<"create" | "connect">("create");
  const [mode, setMode] = useState<ProjectMode>("local");
  const [orgId, setOrgId] = useState<string>(cloudOrgs[0]?.remoteId ?? "");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitUrlDirty, setGitUrlDirty] = useState(false);
  const [restricted, setRestricted] = useState(false);

  // The org store can hydrate after this mounts (fresh sign-in) — default the
  // picker to the first linked Organisation once one exists.
  useEffect(() => {
    if (!orgId && cloudOrgs[0]) setOrgId(cloudOrgs[0].remoteId);
  }, [orgId, cloudOrgs]);

  // Prefill the Slug from the folder name once detection lands, until the
  // developer edits it themselves.
  useEffect(() => {
    if (!slugDirty && detection) setSlug(detection.suggestedSlug);
  }, [detection, slugDirty]);

  // Same rule for the Repository URL, prefilled from this checkout's origin.
  // `gitUrl` is nullable on a repository with no remote, and clearing the field
  // by hand is a deliberate answer we must not overwrite on the next read.
  useEffect(() => {
    if (!gitUrlDirty && detection) setGitUrl(detection.gitUrl ?? "");
  }, [detection, gitUrlDirty]);

  const slugState = useSlugAvailability(
    projectPath,
    mode === "cloud" ? orgId : "",
    mode === "cloud" ? slug : "",
  );

  // Cloud's Continue opens the disclosure step, which is built from the import
  // preview — without it there is nothing to disclose, so the button waits
  // (loading) or points at the retry (failed) instead of silently no-opping.
  const previewLoading = mode === "cloud" && importPreview === undefined;
  const cloudReady =
    mode === "local" ||
    (!!orgId &&
      slug.trim().length > 0 &&
      slugState.kind !== "taken" &&
      slugState.kind !== "checking" &&
      importPreview != null);

  // Connect is a purely server-backed flow — there is nothing it can show
  // without the Organisation's Project list, so it is disabled rather than
  // opened onto an error.
  const connectDisabled = !!cloudReason;
  const activeTab = connectDisabled ? "create" : tab;

  return (
    <div className="space-y-2">
      <Tabs
        tab={activeTab}
        onTabChange={setTab}
        connectDisabled={connectDisabled}
        connectReason={cloudReason}
      />

      {/* Keyed on the tab so a switch re-runs the fade — the two panels are
       *  different heights, and a hard swap reads as a flicker. */}
      {activeTab === "create" ? (
        <UnboundCreateView
          key="create"
          mode={mode}
          onModeChange={setMode}
          cloudReason={cloudReason}
          cloudOrgs={cloudOrgs}
          slug={slug}
          onSlugChange={(value) => {
            setSlugDirty(true);
            setSlug(value);
          }}
          slugState={slugState}
          gitUrl={gitUrl}
          onGitUrlChange={(value) => {
            setGitUrlDirty(true);
            setGitUrl(value);
          }}
          restricted={restricted}
          onRestrictedChange={setRestricted}
          detection={detection}
          importPreview={importPreview}
          gitAvailable={gitAvailable}
          busy={busy}
          previewLoading={previewLoading}
          cloudReady={cloudReady}
          onGitInit={() => void run(() => captureGitInit(projectPath))}
          onRetryPreview={onRetryPreview}
          onCancel={onCancel}
          onSubmit={() => {
            if (mode === "local") {
              void run(() => captureEnableLocal(projectPath));
            } else {
              // No mutation yet — the disclosure step owns all of them.
              onCloudEnable({
                orgId,
                slug: slug.trim(),
                gitUrl: gitUrl.trim(),
                restricted,
              });
            }
          }}
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
          />
        </div>
      )}
    </div>
  );
}
