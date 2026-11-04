import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";
import { cn } from "@/lib/utils";

import { useCapturePopover } from "../hooks/use-capture-popover";
import {
  captureConnect,
  captureDisable,
  captureEnableLocal,
  captureGitInit,
  captureImportConfirm,
  capturePromote,
  captureRegisterCloud,
  captureRetryFailed,
  captureSwitchProject,
} from "../lib/capture-api";
import { connectRefusal, disclosureLines, promotionLines } from "../lib/capture-format";
import type { CaptureHealth } from "../types";
import { HealthDetail } from "./health-detail";
import { PromoteForm } from "./promote-form";
import { SwitchForm } from "./switch-form";
import { UnboundState } from "./unbound-state";
import { BoundStateView } from "./views/bound-state-view";
import { CaptureRadar } from "./views/capture-radar";
import { DisclosureStep } from "./views/disclosure-step";

export type { CloudDraft } from "../lib/capture-flow";

/**
 * Session capture setup and status, opened from the titlebar project pill.
 *
 * The load-bearing decision is that **Local is a real mode, not a waiting room
 * for Cloud**: one click, no account, no network, and it produces the complete
 * product. Cloud and Connect sit one level deeper as tabs, disabled with a
 * stated reason when unavailable — the requirement is obvious before the form
 * is filled in rather than after.
 *
 * Two flows end in a **disclosure step with real numbers** (Cloud create's
 * history import, and Local→Cloud promotion), because each is one of the only
 * bulk-disclosure moments in the feature. Both are steps *inside* the popover
 * rather than modal dialogs, and both invoke nothing until Confirm — closing
 * the popover mid-flow is a true cancel because there is nothing to undo.
 *
 * Ordering inside the Cloud confirm matters and is not obvious:
 * `capture_register_cloud` requires an existing binding, so Confirm runs
 * enable-Local → register → import-confirm. Running enable *before* the
 * disclosure would leave a bound Project behind a Cancel, which is exactly
 * what "Cancel = nothing happens" forbids.
 *
 * **Cloud follows the active Organisation, and only that one.** Capture is
 * per-project and a project belongs to the Organisation you are working in, so
 * offering a picker over every linked Organisation invites binding a repository
 * into a tenant you are not looking at — and the mistake is only visible later,
 * in a shared timeline. The Organisation row below is therefore a label, not a
 * choice.
 *
 * This file is the container: it reads the stores, owns the step machine and
 * every confirm's mutation sequence. State and IPC bookkeeping live in
 * `useCapturePopover`; the flows' forms are `UnboundState`, `PromoteForm`,
 * `SwitchForm` and `ConnectTab`; everything under `views/` is props-only.
 */

/**
 * Cloud capture was gated off here for as long as the ingest service answered
 * 405 to every GET, which made Connect unable to list and the Slug check unable
 * to answer. Those read routes are deployed now, so the gate is gone and the
 * only remaining reasons are the ones the developer can act on — see
 * `cloudReason`.
 *
 * Local capture is unaffected either way: it never touches the network, which is
 * the whole point of it being a real mode rather than a waiting room.
 */

interface Props {
  projectPath: string;
  /** Why capture is degraded or stopped, if it is. */
  health: CaptureHealth | null;
  /** Told when the binding changes, so the surrounding tab can re-read. */
  onChanged: () => void;
  onClose: () => void;
  /**
   * Render without the panel chrome (border, fill, blur, shadow, enter
   * animation), for a host that already draws the surface — the session
   * context overlay shows this as one of its views. The width stays 352px:
   * the radar is laid out against it (`RADAR_ORIGIN_X`).
   */
  embedded?: boolean;
}

export function CapturePopover({
  projectPath,
  health,
  onChanged,
  onClose,
  embedded = false,
}: Props) {
  const signedIn = useAuthStore.use.snapshot().status === "signed-in";
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  // Scoped to the Organisation currently open, not every linked one — see the
  // module note. A local-only Organisation yields none, which is what turns
  // Cloud and Connect off with a reason rather than letting them fail later.
  // `syncEnabled && remoteId` is the same synced predicate the org switcher
  // uses; being signed in is checked separately, because signing out does not
  // move you out of a synced Organisation.
  const activeOrg = organisations.find((org) => org.id === activeOrganisationId) ?? null;
  const cloudOrgs =
    activeOrg?.remoteId && activeOrg.syncEnabled
      ? [activeOrg as Organisation & { remoteId: string }]
      : [];

  const {
    binding,
    loaded,
    detection,
    gitAvailable,
    importPreview,
    view,
    setView,
    busy,
    error,
    retryPreview,
    loadPromotionPreview,
    run,
  } = useCapturePopover(projectPath, onChanged);

  // Ordered most-actionable-last: a missing git is a machine-shaped problem the
  // developer fixes elsewhere, so it is stated first, and the account-shaped
  // reasons only surface once it is resolved.
  const cloudReason = !gitAvailable
    ? "Install git to share with an Organization"
    : !signedIn
      ? "Sign in to share with an Organization"
      : cloudOrgs.length === 0
        ? `“${activeOrg?.name ?? "This Organization"}” is local-only — sync it to use Cloud`
        : null;

  // See `loaded`: rendering before the first read flashes the wrong state.
  if (!loaded) return null;

  return (
    <div
      className={cn(
        "w-[352px] select-none overflow-hidden text-sm",
        // Border, translucent fill and blur all on THIS element — the same one
        // the enter animation transforms. Splitting them across a wrapper would
        // isolate the compositing layer and flatten the blur to flat
        // transparency (see the note beside the keyframes in globals.css).
        !embedded &&
          "rounded-xl border border-element-active bg-[var(--card)]/95 shadow-md backdrop-blur-2xl atlas-panel-in-tl",
      )}
    >
      {/* A bound project opens onto the radar rather than a title bar: the panel
          is a recorder, and "it is listening" is the one thing worth saying
          before any of the detail. Unbound, the form below already says what
          this is, so there is nothing for a header to add. */}
      {binding && <CaptureRadar live={binding.enabled} health={health} />}

      <div className="px-3.5 py-3">
        {view.kind === "main" && (
          <HealthDetail health={health} projectPath={projectPath} onRetried={onChanged} />
        )}

        {view.kind === "main" &&
          (binding ? (
            <BoundStateView
              binding={binding}
              detection={detection}
              gitAvailable={gitAvailable}
              health={health}
              importPreview={importPreview}
              cloudOrgs={cloudOrgs}
              cloudReason={cloudReason}
              busy={busy}
              onGitInit={() => void run(() => captureGitInit(projectPath))}
              onRetryFailed={() => void run(() => captureRetryFailed(projectPath))}
              onPause={() => void run(() => captureDisable(projectPath))}
              // Always "local": the command rejects "cloud" outright, and an
              // existing Cloud binding keeps its mode on re-enable regardless.
              onResume={() => void run(() => captureEnableLocal(projectPath))}
              onReviewImport={() =>
                importPreview && setView({ kind: "import-confirm", preview: importPreview })
              }
              onPromote={() => setView({ kind: "promote-form", tab: "create" })}
              onSwitch={() => setView({ kind: "switch-form" })}
            />
          ) : (
            <UnboundState
              projectPath={projectPath}
              detection={detection}
              gitAvailable={gitAvailable}
              importPreview={importPreview}
              cloudReason={cloudReason}
              cloudOrgs={cloudOrgs}
              busy={busy}
              run={run}
              onRetryPreview={() => void retryPreview()}
              onCancel={onClose}
              onCloudEnable={(draft) => {
                // Belt to the button's braces — Continue is disabled until the
                // preview is in, so this guard should never fire.
                if (!importPreview) return;
                setView({ kind: "cloud-confirm", draft, preview: importPreview });
              }}
            />
          ))}

        {view.kind === "cloud-confirm" && (
          <DisclosureStep
            title="Share this Project's history?"
            lines={disclosureLines(view.preview)}
            confirmLabel="Share and enable Cloud"
            busy={busy}
            onCancel={() => setView({ kind: "main" })}
            onConfirm={async () => {
              // Enable must precede registration (the server call needs a
              // binding to read fingerprints from), and both only run now —
              // after the disclosure — so Cancel left nothing behind.
              const ok = await run(async () => {
                await captureEnableLocal(projectPath);
                await captureRegisterCloud({
                  projectPath,
                  orgId: view.draft.orgId,
                  slug: view.draft.slug,
                  name: null,
                  visibility: view.draft.restricted ? "restricted" : "org",
                  gitUrl: view.draft.gitUrl,
                });
                await captureImportConfirm(projectPath);
              });
              if (ok) setView({ kind: "main" });
            }}
          />
        )}

        {view.kind === "import-confirm" && (
          <DisclosureStep
            title="Import this Project's history?"
            lines={disclosureLines(view.preview)}
            confirmLabel="Import and share"
            busy={busy}
            onCancel={() => setView({ kind: "main" })}
            onConfirm={async () => {
              const ok = await run(() => captureImportConfirm(projectPath));
              if (ok) setView({ kind: "main" });
            }}
          />
        )}

        {view.kind === "promote-form" && (
          <PromoteForm
            projectPath={projectPath}
            detection={detection}
            cloudOrgs={cloudOrgs}
            cloudReason={cloudReason}
            tab={view.tab}
            onTabChange={(tab) => setView({ kind: "promote-form", tab })}
            busy={busy}
            run={run}
            onCancel={() => setView({ kind: "main" })}
            onContinue={async (draft) => {
              const preview = await loadPromotionPreview();
              if (preview) setView({ kind: "promote-confirm", draft, preview });
            }}
            onConnectContinue={async (pick) => {
              const preview = await loadPromotionPreview();
              if (preview) setView({ kind: "promote-connect-confirm", pick, preview });
            }}
          />
        )}

        {view.kind === "promote-connect-confirm" && (
          <DisclosureStep
            title={`Publish this Project's history to “${view.pick.slug}”?`}
            lines={promotionLines(view.preview)}
            confirmLabel="Connect and sync"
            busy={busy}
            onCancel={() => setView({ kind: "promote-form", tab: "connect" })}
            onConfirm={async () => {
              // The binding already exists (this is a Local Project), so unlike
              // the unbound Connect tab there is no enable step first.
              const ok = await run(async () => {
                const result = await captureConnect({
                  projectPath,
                  orgId: view.pick.orgId,
                  slug: view.pick.slug,
                  workspaceId: view.pick.workspaceId,
                });
                // A refusal is not a failure, but it does need a new pick —
                // thrown so the error strip carries it back to the Connect tab.
                if (!result.matched) throw new Error(connectRefusal(result.candidates));
              });
              setView(ok ? { kind: "main" } : { kind: "promote-form", tab: "connect" });
            }}
          />
        )}

        {view.kind === "switch-form" && binding && (
          <SwitchForm
            projectPath={projectPath}
            binding={binding}
            cloudOrgs={cloudOrgs}
            cloudReason={cloudReason}
            busy={busy}
            run={run}
            onCancel={() => setView({ kind: "main" })}
            onContinue={async (pick) => {
              const preview = await loadPromotionPreview();
              if (preview) setView({ kind: "switch-confirm", pick, preview });
            }}
          />
        )}

        {view.kind === "switch-confirm" && (
          <DisclosureStep
            title={`Move this Project's sync to “${view.pick.slug}”?`}
            lines={[
              ...promotionLines(view.preview).map((line, i) =>
                i === 0 ? `${line} re-sent to the new Project` : line,
              ),
              // The server keeps one object per Project and has no move.
              `“${binding?.slug ?? "the current Project"}” keeps its copy; comments stay there`,
            ]}
            confirmLabel="Move sync"
            busy={busy}
            onCancel={() => setView({ kind: "switch-form" })}
            onConfirm={async () => {
              const ok = await run(async () => {
                const result = await captureSwitchProject({
                  projectPath,
                  orgId: view.pick.orgId,
                  slug: view.pick.slug,
                  workspaceId: view.pick.workspaceId,
                });
                if (!result.matched) throw new Error(connectRefusal(result.candidates));
              });
              setView(ok ? { kind: "main" } : { kind: "switch-form" });
            }}
          />
        )}

        {view.kind === "promote-confirm" && (
          <DisclosureStep
            title="Publish this Project to your Organization?"
            lines={promotionLines(view.preview)}
            confirmLabel="Promote to Cloud"
            busy={busy}
            onCancel={() => setView({ kind: "promote-form", tab: "create" })}
            onConfirm={async () => {
              const ok = await run(() =>
                capturePromote({
                  projectPath,
                  orgId: view.draft.orgId,
                  slug: view.draft.slug,
                  name: null,
                  visibility: view.draft.restricted ? "restricted" : "org",
                }),
              );
              if (ok) setView({ kind: "main" });
            }}
          />
        )}

        {error && (
          <p className="mt-2 rounded-lg bg-error-muted px-2.5 py-1.5 text-xs text-error">{error}</p>
        )}
      </div>
    </div>
  );
}
