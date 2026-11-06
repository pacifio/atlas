import { useEffect, useRef, useState } from "react";

import { captureConnect, captureConnectOptions, captureEnableLocal } from "../lib/capture-api";
import type { CloudOrg, RunAction } from "../lib/capture-flow";
import { connectRefusal } from "../lib/capture-format";
import type { ConnectOptions, ConnectPick } from "../types";
import { ConnectLockedView, ConnectPickerView } from "./views/connect-picker-view";

/**
 * Connect this repository to a Project the Organisation already has.
 *
 * Pre-selection is the server's judgement, not this component's: one confident
 * match arrives pre-picked, several matches arrive with **nothing** selected —
 * repositories created from the same template share a root commit, and a
 * confident wrong answer would pollute a shared timeline. Warnings are shown,
 * never blocking.
 */
export function ConnectTab({
  projectPath,
  cloudOrgs,
  cloudReason,
  busy,
  run,
  onCancel,
  onContinue,
  excludeId = null,
}: {
  projectPath: string;
  cloudOrgs: CloudOrg[];
  cloudReason: string | null;
  busy: boolean;
  run: RunAction;
  onCancel: () => void;
  /**
   * Promote mode. When set, the button hands the pick up instead of
   * connecting — a Local Project has history to disclose first, and the
   * disclosure step owns every mutation. Absent, the pick connects at once
   * (an unbound Project has nothing to disclose).
   */
  onContinue?: (pick: ConnectPick) => void;
  /** Hide this Project from the list — the one already synced to. */
  excludeId?: string | null;
}) {
  const [orgId, setOrgId] = useState<string>(cloudOrgs[0]?.remoteId ?? "");
  const [options, setOptions] = useState<ConnectOptions | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  /** Why the listing failed, as Rust reported it — a 403 and a dead network
   *  need different fixes, and one sentence for both sent people checking
   *  Wi-Fi for a permission problem. */
  const [listError, setListError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!orgId && cloudOrgs[0]) setOrgId(cloudOrgs[0].remoteId);
  }, [orgId, cloudOrgs]);

  useEffect(() => {
    if (cloudReason || !orgId) return;
    const mine = ++seq.current;
    setOptions(undefined);
    setSelected(null);
    setListError(null);
    captureConnectOptions(projectPath, orgId)
      .then((result) => {
        if (mine !== seq.current) return;
        setOptions(result);
        setSelected(result.preselected === excludeId ? null : result.preselected);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setOptions(null);
        setListError(String(e));
      });
  }, [projectPath, orgId, cloudReason, excludeId]);

  if (cloudReason) return <ConnectLockedView reason={cloudReason} />;

  const workspaces = options?.workspaces.filter((w) => w.id !== excludeId) ?? [];
  const project = workspaces.find((w) => w.id === selected);

  return (
    <ConnectPickerView
      options={options}
      listError={listError}
      workspaces={workspaces}
      project={project}
      selected={selected}
      excludeId={excludeId}
      busy={busy}
      primaryLabel={onContinue ? "Continue" : "Connect"}
      onSelect={setSelected}
      onCancel={onCancel}
      onSubmit={() => {
        if (!project) return;
        if (onContinue) {
          onContinue({ orgId, slug: project.slug, workspaceId: project.id });
          return;
        }
        void run(async () => {
          // Connect needs a binding row to attach the Cloud identity to.
          await captureEnableLocal(projectPath);
          const result = await captureConnect({
            projectPath,
            orgId,
            slug: project.slug,
            workspaceId: project.id,
          });
          // Enable just created the binding, so the popover is about to swap
          // this tab for the bound view; a refusal held here would unmount
          // unseen. Thrown so the popover's error strip carries it instead.
          if (!result.matched) throw new Error(connectRefusal(result.candidates));
        });
      }}
    />
  );
}
