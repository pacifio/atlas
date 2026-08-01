import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpRight,
  Check,
  CircleDot,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";

import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";
import { cn } from "@/lib/utils";

import type {
  Binding,
  CaptureHealth,
  ConnectOptions,
  Detection,
  ImportPreview,
  PromotionPreview,
  SlugAvailability,
  WorkspaceMode,
} from "../types";

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
 * disclosure would leave a bound Workspace behind a Cancel, which is exactly
 * what "Cancel = nothing happens" forbids.
 */

interface Props {
  projectPath: string;
  /** Why capture is degraded or stopped, if it is. */
  health: CaptureHealth | null;
  /** Told when the binding changes, so the surrounding tab can re-read. */
  onChanged: () => void;
  onClose: () => void;
}

type View =
  | { kind: "main" }
  /** Cloud create: the import disclosure, with the registration still pending. */
  | {
      kind: "cloud-confirm";
      orgId: string;
      slug: string;
      preview: ImportPreview;
    }
  /** Bound Cloud Workspace whose history import awaits approval. */
  | { kind: "import-confirm"; preview: ImportPreview }
  /** Local→Cloud promotion: pick the destination. */
  | { kind: "promote-form" }
  /** Local→Cloud promotion: the disclosure. */
  | {
      kind: "promote-confirm";
      orgId: string;
      slug: string;
      preview: PromotionPreview;
    };

export function CapturePopover({
  projectPath,
  health,
  onChanged,
  onClose,
}: Props) {
  const signedIn = useAuthStore.use.snapshot().status === "signed-in";
  const organisations = useOrgStore.use.organisations();
  // Cloud talks to the server, so only server-linked Organisations qualify.
  const cloudOrgs = organisations.filter(
    (org): org is Organisation & { remoteId: string } => !!org.remoteId,
  );

  const [binding, setBinding] = useState<Binding | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  /** `undefined` while the read is in flight, `null` once it failed — the
   *  Cloud "Continue" button needs the difference to gate honestly. */
  const [importPreview, setImportPreview] = useState<
    ImportPreview | null | undefined
  >(undefined);
  const [view, setView] = useState<View>({ kind: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [current, detected, preview] = await Promise.all([
        invoke<Binding | null>("capture_binding", { projectPath }),
        invoke<Detection>("capture_detect", { projectPath }),
        // Read-only and cheap — the "history N sessions on disk" row and both
        // disclosure steps feed off it. A failure lands as `null`, which the
        // Cloud path surfaces with a retry instead of silently no-opping.
        invoke<ImportPreview>("capture_import_preview", { projectPath }).catch(
          () => null,
        ),
      ]);
      setBinding(current);
      setDetection(detected);
      setImportPreview(preview);
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-read just the preview — the retry for a failed preview load. */
  const retryPreview = useCallback(async () => {
    setImportPreview(undefined);
    try {
      setImportPreview(
        await invoke<ImportPreview>("capture_import_preview", { projectPath }),
      );
    } catch {
      setImportPreview(null);
    }
  }, [projectPath]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      // Always re-read, success or not: a multi-step action (Cloud confirm,
      // Connect) can fail after its first mutation landed, and showing the
      // pre-action state over a Workspace that changed is a lie. `load` never
      // clears `error` on success, so the failure stays visible.
      await load();
      onChanged();
      setBusy(false);
    }
  };

  const cloudReason = !signedIn
    ? "Sign in to share with an Organisation"
    : cloudOrgs.length === 0
      ? "Create or join an Organisation to use Cloud"
      : null;

  return (
    <div className="w-[340px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 text-[12px] shadow-[var(--shadow-overlay)]">
      <header className="flex items-center justify-between pb-2">
        <span className="font-medium text-[var(--text-primary)]">
          Session capture
        </span>
        <StatusPill binding={binding} />
      </header>

      {view.kind === "main" && <HealthDetail health={health} />}

      {view.kind === "main" &&
        (binding ? (
          <BoundState
            projectPath={projectPath}
            binding={binding}
            detection={detection}
            health={health}
            importPreview={importPreview}
            cloudOrgs={cloudOrgs}
            signedIn={signedIn}
            busy={busy}
            run={run}
            onReviewImport={() =>
              importPreview &&
              setView({ kind: "import-confirm", preview: importPreview })
            }
            onPromote={() => setView({ kind: "promote-form" })}
          />
        ) : (
          <UnboundState
            projectPath={projectPath}
            detection={detection}
            importPreview={importPreview}
            cloudReason={cloudReason}
            cloudOrgs={cloudOrgs}
            busy={busy}
            run={run}
            onRetryPreview={() => void retryPreview()}
            onCancel={onClose}
            onCloudEnable={(orgId, slug) => {
              // Belt to the button's braces — Continue is disabled until the
              // preview is in, so this guard should never fire.
              if (!importPreview) return;
              setView({
                kind: "cloud-confirm",
                orgId,
                slug,
                preview: importPreview,
              });
            }}
          />
        ))}

      {view.kind === "cloud-confirm" && (
        <DisclosureStep
          title="Share this Workspace's history?"
          lines={disclosureLines(view.preview)}
          confirmLabel="Share and enable Cloud"
          busy={busy}
          onCancel={() => setView({ kind: "main" })}
          onConfirm={async () => {
            // Enable must precede registration (the server call needs a
            // binding to read fingerprints from), and both only run now —
            // after the disclosure — so Cancel left nothing behind.
            const ok = await run(async () => {
              await invoke("capture_enable", { projectPath, mode: "local" });
              await invoke("capture_register_cloud", {
                projectPath,
                orgId: view.orgId,
                slug: view.slug,
              });
              await invoke("capture_import_confirm", { projectPath });
            });
            if (ok) setView({ kind: "main" });
          }}
        />
      )}

      {view.kind === "import-confirm" && (
        <DisclosureStep
          title="Import this Workspace's history?"
          lines={disclosureLines(view.preview)}
          confirmLabel="Import and share"
          busy={busy}
          onCancel={() => setView({ kind: "main" })}
          onConfirm={async () => {
            const ok = await run(() =>
              invoke("capture_import_confirm", { projectPath }),
            );
            if (ok) setView({ kind: "main" });
          }}
        />
      )}

      {view.kind === "promote-form" && (
        <PromoteForm
          projectPath={projectPath}
          detection={detection}
          cloudOrgs={cloudOrgs}
          busy={busy}
          onCancel={() => setView({ kind: "main" })}
          onContinue={async (orgId, slug) => {
            setBusy(true);
            setError(null);
            try {
              const preview = await invoke<PromotionPreview>(
                "capture_promotion_preview",
                {
                  projectPath,
                },
              );
              setView({ kind: "promote-confirm", orgId, slug, preview });
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {view.kind === "promote-confirm" && (
        <DisclosureStep
          title="Publish this Workspace to your Organisation?"
          lines={[
            `${view.preview.sessionCount} session${view.preview.sessionCount === 1 ? "" : "s"}`,
            dateRange(view.preview.earliest, view.preview.latest),
            `${view.preview.secretsRedacted} secret${view.preview.secretsRedacted === 1 ? "" : "s"} redacted before storage`,
          ].filter((line): line is string => line !== null)}
          confirmLabel="Promote to Cloud"
          busy={busy}
          onCancel={() => setView({ kind: "main" })}
          onConfirm={async () => {
            const ok = await run(() =>
              invoke("capture_promote", {
                projectPath,
                orgId: view.orgId,
                slug: view.slug,
              }),
            );
            if (ok) setView({ kind: "main" });
          }}
        />
      )}

      {error && (
        <p className="mt-2 rounded bg-[var(--status-error-muted)] px-2 py-1 text-[11px] text-[var(--status-error)]">
          {error}
        </p>
      )}
    </div>
  );
}

function disclosureLines(preview: ImportPreview): string[] {
  if (preview.newSessionCount === 0) {
    return ["No existing history to import — new sessions sync from now on."];
  }
  return [
    `${preview.newSessionCount} session${preview.newSessionCount === 1 ? "" : "s"} on disk`,
    dateRange(preview.earliest, preview.latest),
    `${formatBytes(preview.totalBytes)} of transcripts, secrets scrubbed on the way in`,
  ].filter((line): line is string => line !== null);
}

/**
 * The bulk-disclosure step: real numbers, then a genuine choice.
 *
 * Cancel invokes nothing — every mutation belongs to Confirm.
 */
function DisclosureStep({
  title,
  lines,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-medium text-[var(--text-primary)]">
        {title}
      </p>
      <ul className="space-y-0.5 rounded bg-[var(--bg-raised)] px-2 py-1.5">
        {lines.map((line) => (
          <li key={line} className="text-[11px] text-[var(--text-secondary)]">
            {line}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-[var(--text-tertiary)]">
        This makes the above visible to your Organisation. Nothing is sent until
        you confirm.
      </p>
      <div className="flex justify-end gap-2 pt-1">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton busy={busy} onClick={onConfirm} label={confirmLabel} />
      </div>
    </div>
  );
}

/**
 * Why capture is degraded or stopped.
 *
 * Nothing renders while healthy or switched off — a permanent banner trains
 * people to stop reading the thing they are supposed to notice.
 */
function HealthDetail({ health }: { health: CaptureHealth | null }) {
  if (!health || health.issues.length === 0) return null;

  const stopped = health.state === "stopped";
  return (
    <ul
      className={cn(
        "mb-2 space-y-1.5 rounded px-2 py-1.5",
        stopped
          ? "bg-[var(--status-error-muted)]"
          : "bg-[var(--status-warning-muted)]",
      )}
    >
      {health.issues.map((issue, index) => (
        // Index in the key: two issues can share their reason text.
        <li key={`${index}-${issue.reason}`} className="text-[11px]">
          <p
            className={
              issue.state === "stopped"
                ? "text-[var(--status-error)]"
                : "text-[var(--status-warning)]"
            }
          >
            {issue.reason}
          </p>
          {issue.nextStep && (
            <p className="text-[var(--text-tertiary)]">{issue.nextStep}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Capturing / paused / off, at a glance. */
function StatusPill({ binding }: { binding: Binding | null }) {
  if (!binding) {
    return <span className="text-[11px] text-[var(--text-tertiary)]">Off</span>;
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
      <CircleDot
        size={11}
        className={
          binding.enabled
            ? "text-[var(--status-info)]"
            : "text-[var(--text-tertiary)]"
        }
      />
      {binding.enabled ? "Capturing" : "Paused"} ·{" "}
      {binding.mode === "cloud" ? "Cloud" : "Local"}
    </span>
  );
}

/** Already bound: state and the actions that change it, not another form. */
function BoundState({
  projectPath,
  binding,
  detection,
  health,
  importPreview,
  cloudOrgs,
  signedIn,
  busy,
  run,
  onReviewImport,
  onPromote,
}: {
  projectPath: string;
  binding: Binding;
  detection: Detection | null;
  health: CaptureHealth | null;
  importPreview: ImportPreview | null | undefined;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  signedIn: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onReviewImport: () => void;
  onPromote: () => void;
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
        <dl className="space-y-0.5 rounded bg-[var(--bg-raised)] px-2 py-1.5 text-[11px]">
          <Row
            label="Shared as"
            value={orgName ? `${orgName} / ${binding.slug}` : binding.slug}
          />
          {pending > 0 && (
            <Row
              label="Queue"
              value={`${pending} pending — sends when online`}
            />
          )}
        </dl>
      )}

      <Detected detection={detection} importPreview={importPreview} />

      {/* Git is not required, and the offer says what it unlocks rather than
       *  demanding anything. Sessions are already being captured either way. */}
      {detection && !detection.isGitRepository && (
        <GitInitOffer
          busy={busy}
          onGitInit={() =>
            void run(() => invoke("capture_git_init", { projectPath }))
          }
        />
      )}

      {/* A Cloud Workspace whose bulk import was never approved imports
       *  nothing, forever, on purpose. Say so where it can be resolved. */}
      {binding.mode === "cloud" && !binding.importApproved && (
        <div className="flex items-center justify-between gap-2 rounded border border-dashed border-[var(--border-default)] px-2 py-1.5">
          <span className="text-[11px] text-[var(--text-secondary)]">
            History import is waiting for your review.
          </span>
          <button
            type="button"
            disabled={busy || !importPreview}
            onClick={onReviewImport}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.97] disabled:opacity-50"
          >
            Review
          </button>
        </div>
      )}

      {/* Failed rows: the retry is a deliberate human action, never automatic. */}
      {failed > 0 && (
        <div className="flex items-center justify-between gap-2 rounded bg-[var(--status-warning-muted)] px-2 py-1.5">
          <span className="text-[11px] text-[var(--status-warning)]">
            {failed} record{failed === 1 ? "" : "s"} could not be sent.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => invoke("capture_retry_failed", { projectPath }))
            }
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.97] disabled:opacity-50"
          >
            <RefreshCw size={10} />
            Retry
          </button>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {binding.mode === "local" && signedIn && cloudOrgs.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={onPromote}
            className="mr-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.97] disabled:opacity-50"
          >
            <ArrowUpRight size={11} />
            Promote to Cloud
          </button>
        )}
        {binding.enabled ? (
          <GhostButton
            label="Pause capture"
            disabled={busy}
            onClick={() =>
              void run(() => invoke("capture_disable", { projectPath }))
            }
          />
        ) : (
          <PrimaryButton
            busy={busy}
            // Always "local": the command rejects "cloud" outright, and an
            // existing Cloud binding keeps its mode on re-enable regardless.
            onClick={() =>
              void run(() =>
                invoke("capture_enable", { projectPath, mode: "local" }),
              )
            }
            label="Resume capture"
          />
        )}
      </div>

      {!binding.enabled && (
        <p className="text-[11px] text-[var(--text-tertiary)]">
          Paused. Nothing already recorded has been deleted.
        </p>
      )}
    </div>
  );
}

/** Not yet bound: Create (Local one click / Cloud form) or Connect, as tabs. */
function UnboundState({
  projectPath,
  detection,
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
  /** `undefined` = still loading, `null` = the read failed. */
  importPreview: ImportPreview | null | undefined;
  cloudReason: string | null;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onRetryPreview: () => void;
  onCancel: () => void;
  onCloudEnable: (orgId: string, slug: string) => void;
}) {
  const [tab, setTab] = useState<"create" | "connect">("create");
  const [mode, setMode] = useState<WorkspaceMode>("local");
  const [orgId, setOrgId] = useState<string>(cloudOrgs[0]?.remoteId ?? "");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);

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

  return (
    <div className="space-y-2">
      <Tabs tab={tab} onTabChange={setTab} />

      {tab === "create" ? (
        <>
          <div
            role="radiogroup"
            aria-label="Where sessions are stored"
            className="space-y-1"
          >
            <ModeOption
              selected={mode === "local"}
              disabled={false}
              label="Local"
              hint="This machine only — no account needed"
              onSelect={() => setMode("local")}
            />
            <ModeOption
              selected={mode === "cloud"}
              disabled={!!cloudReason}
              label="Cloud"
              hint={cloudReason ?? "Share with your Organisation"}
              onSelect={() => setMode("cloud")}
            />
          </div>

          {mode === "cloud" && (
            <CloudFields
              cloudOrgs={cloudOrgs}
              orgId={orgId}
              onOrgChange={setOrgId}
              slug={slug}
              onSlugChange={(value) => {
                setSlugDirty(true);
                setSlug(value);
              }}
              slugState={slugState}
            />
          )}

          <Detected detection={detection} importPreview={importPreview} />

          {detection && !detection.isGitRepository && (
            <GitInitOffer
              busy={busy}
              onGitInit={() =>
                void run(() => invoke("capture_git_init", { projectPath }))
              }
            />
          )}

          {/* The preview read failed: Continue has nothing to disclose, so say
           *  so where it blocks, with the retry right there. */}
          {mode === "cloud" && importPreview === null && (
            <div className="flex items-center justify-between gap-2 rounded bg-[var(--status-warning-muted)] px-2 py-1.5">
              <span className="text-[11px] text-[var(--status-warning)]">
                Couldn't read this Workspace's history.
              </span>
              <button
                type="button"
                onClick={onRetryPreview}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.97]"
              >
                <RefreshCw size={10} />
                Retry
              </button>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
            <PrimaryButton
              busy={busy || previewLoading}
              disabled={!cloudReady}
              onClick={() => {
                if (mode === "local") {
                  void run(() =>
                    invoke("capture_enable", { projectPath, mode: "local" }),
                  );
                } else {
                  // No mutation yet — the disclosure step owns all of them.
                  onCloudEnable(orgId, slug.trim());
                }
              }}
              label={mode === "cloud" ? "Continue" : "Enable"}
            />
          </div>
        </>
      ) : (
        <ConnectTab
          projectPath={projectPath}
          cloudOrgs={cloudOrgs}
          cloudReason={cloudReason}
          busy={busy}
          run={run}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function Tabs({
  tab,
  onTabChange,
}: {
  tab: "create" | "connect";
  onTabChange: (tab: "create" | "connect") => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Set up session capture"
      className="flex gap-1 rounded bg-[var(--bg-raised)] p-0.5"
    >
      {(["create", "connect"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          onClick={() => onTabChange(id)}
          className={cn(
            "flex-1 rounded px-2 py-1 text-[11px] capitalize transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.98]",
            tab === id
              ? "bg-[var(--bg-overlay)] font-medium text-[var(--text-primary)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
          )}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

type SlugState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "unknown"; retry: () => void };

/**
 * Debounced three-state Slug availability.
 *
 * `unknown` is deliberately distinct from `taken`: telling a developer their
 * name is gone when the network merely blinked is a lie they will act on — so
 * it reads as "couldn't check" with a retry, and it never blocks submitting.
 */
function useSlugAvailability(
  projectPath: string,
  orgId: string,
  slug: string,
): SlugState {
  const [state, setState] = useState<SlugState>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const trimmed = slug.trim();
    if (!orgId || !trimmed) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "checking" });
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      invoke<SlugAvailability>("capture_slug_available", {
        projectPath,
        orgId,
        slug: trimmed,
      })
        .then((availability) => {
          if (mine !== seq.current) return;
          if (availability === "available") setState({ kind: "available" });
          else if (availability === "taken") setState({ kind: "taken" });
          else
            setState({ kind: "unknown", retry: () => setNonce((n) => n + 1) });
        })
        .catch(() => {
          if (mine === seq.current) {
            setState({ kind: "unknown", retry: () => setNonce((n) => n + 1) });
          }
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [projectPath, orgId, slug, nonce]);

  return state;
}

/** Org picker + Slug field, shared by Create-Cloud and Promote. */
function CloudFields({
  cloudOrgs,
  orgId,
  onOrgChange,
  slug,
  onSlugChange,
  slugState,
}: {
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  orgId: string;
  onOrgChange: (id: string) => void;
  slug: string;
  onSlugChange: (slug: string) => void;
  slugState: SlugState;
}) {
  return (
    <div className="space-y-1.5 rounded bg-[var(--bg-raised)] px-2 py-2">
      {cloudOrgs.length > 1 ? (
        <label className="flex items-center gap-2">
          <span className="w-[70px] shrink-0 text-[11px] text-[var(--text-tertiary)]">
            Organisation
          </span>
          <select
            value={orgId}
            onChange={(e) => onOrgChange(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
          >
            {cloudOrgs.map((org) => (
              <option key={org.remoteId} value={org.remoteId}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="flex items-center gap-2">
          <span className="w-[70px] shrink-0 text-[11px] text-[var(--text-tertiary)]">
            Organisation
          </span>
          <span className="truncate text-[11px] text-[var(--text-secondary)]">
            {cloudOrgs[0]?.name ?? "—"}
          </span>
        </div>
      )}

      <label className="flex items-center gap-2">
        <span className="w-[70px] shrink-0 text-[11px] text-[var(--text-tertiary)]">
          Slug
        </span>
        <input
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="my-project"
          className="min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1.5 py-1 font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-focus)]"
        />
      </label>

      <SlugStatus state={slugState} />
    </div>
  );
}

function SlugStatus({ state }: { state: SlugState }) {
  if (state.kind === "idle") return null;
  return (
    <p className="flex items-center gap-1 pl-[78px] text-[11px]">
      {state.kind === "checking" && (
        <>
          <Loader2
            size={10}
            className="animate-spin text-[var(--text-tertiary)]"
          />
          <span className="text-[var(--text-tertiary)]">checking…</span>
        </>
      )}
      {state.kind === "available" && (
        <>
          <Check size={10} className="text-[var(--text-secondary)]" />
          <span className="text-[var(--text-secondary)]">available</span>
        </>
      )}
      {state.kind === "taken" && (
        <>
          <X size={10} className="text-[var(--status-error)]" />
          <span className="text-[var(--status-error)]">
            taken in this Organisation
          </span>
        </>
      )}
      {state.kind === "unknown" && (
        <>
          <span className="text-[var(--status-warning)]">couldn't check</span>
          <button
            type="button"
            onClick={state.retry}
            className="text-[var(--text-secondary)] underline underline-offset-2 transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
          >
            retry
          </button>
        </>
      )}
    </p>
  );
}

/**
 * Connect this repository to a Workspace the Organisation already has.
 *
 * Pre-selection is the server's judgement, not this component's: one confident
 * match arrives pre-picked, several matches arrive with **nothing** selected —
 * repositories created from the same template share a root commit, and a
 * confident wrong answer would pollute a shared timeline. Warnings are shown,
 * never blocking.
 */
function ConnectTab({
  projectPath,
  cloudOrgs,
  cloudReason,
  busy,
  run,
  onCancel,
}: {
  projectPath: string;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  cloudReason: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [orgId, setOrgId] = useState<string>(cloudOrgs[0]?.remoteId ?? "");
  const [options, setOptions] = useState<ConnectOptions | null | undefined>(
    undefined,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!orgId && cloudOrgs[0]) setOrgId(cloudOrgs[0].remoteId);
  }, [orgId, cloudOrgs]);

  useEffect(() => {
    if (cloudReason || !orgId) return;
    const mine = ++seq.current;
    setOptions(undefined);
    setSelected(null);
    invoke<ConnectOptions>("capture_connect_options", { projectPath, orgId })
      .then((result) => {
        if (mine !== seq.current) return;
        setOptions(result);
        setSelected(result.preselected);
      })
      .catch(() => {
        if (mine === seq.current) setOptions(null);
      });
  }, [projectPath, orgId, cloudReason]);

  if (cloudReason) {
    return (
      <p className="flex items-start gap-1.5 rounded bg-[var(--bg-raised)] px-2 py-2 text-[11px] text-[var(--text-tertiary)]">
        <Lock size={11} className="mt-px shrink-0" />
        {cloudReason}
      </p>
    );
  }

  const workspace = options?.workspaces.find((w) => w.id === selected);

  return (
    <div className="space-y-2">
      {cloudOrgs.length > 1 && (
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
            Organisation
          </span>
          <select
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
          >
            {cloudOrgs.map((org) => (
              <option key={org.remoteId} value={org.remoteId}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {options === undefined ? (
        <p className="flex items-center gap-1.5 py-2 text-[11px] text-[var(--text-tertiary)]">
          <Loader2 size={11} className="animate-spin" />
          Fetching this Organisation's Workspaces…
        </p>
      ) : options === null ? (
        <p className="rounded bg-[var(--status-warning-muted)] px-2 py-1.5 text-[11px] text-[var(--status-warning)]">
          Could not reach the server. Check the connection and reopen this tab.
        </p>
      ) : options.workspaces.length === 0 ? (
        <p className="rounded bg-[var(--bg-raised)] px-2 py-2 text-[11px] text-[var(--text-tertiary)]">
          This Organisation has no Workspaces yet. Create one from the Create
          tab instead.
        </p>
      ) : (
        <>
          {options.warning && (
            <p className="rounded bg-[var(--status-warning-muted)] px-2 py-1.5 text-[11px] text-[var(--status-warning)]">
              {options.warning}
            </p>
          )}
          <div
            role="radiogroup"
            aria-label="Workspace to connect to"
            className="max-h-[180px] space-y-0.5 overflow-y-auto"
          >
            {options.workspaces.map((remote) => (
              <button
                key={remote.id}
                type="button"
                role="radio"
                aria-checked={selected === remote.id}
                onClick={() => setSelected(remote.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]",
                  selected === remote.id
                    ? "bg-[var(--bg-selected)]"
                    : "hover:bg-[var(--bg-hover)]",
                )}
              >
                <span className="shrink-0">
                  {selected === remote.id ? (
                    <Check size={11} className="text-[var(--text-primary)]" />
                  ) : (
                    <span className="block h-[11px] w-[11px] rounded-full border border-[var(--border-strong)]" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-[var(--text-primary)]">
                    {remote.slug}
                  </span>
                  {remote.gitUrl && (
                    <span className="block truncate text-[10px] text-[var(--text-tertiary)]">
                      {remote.gitUrl}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton
          busy={busy}
          disabled={!workspace}
          onClick={() => {
            if (!workspace) return;
            void run(async () => {
              // Connect needs a binding row to attach the Cloud identity to.
              await invoke("capture_enable", { projectPath, mode: "local" });
              await invoke("capture_connect", {
                projectPath,
                orgId,
                slug: workspace.slug,
                workspaceId: workspace.id,
              });
            });
          }}
          label="Connect"
        />
      </div>
    </div>
  );
}

/** Promotion step one: pick the Organisation and Slug the history will live under. */
function PromoteForm({
  projectPath,
  detection,
  cloudOrgs,
  busy,
  onCancel,
  onContinue,
}: {
  projectPath: string;
  detection: Detection | null;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  busy: boolean;
  onCancel: () => void;
  onContinue: (orgId: string, slug: string) => void;
}) {
  const [orgId, setOrgId] = useState<string>(cloudOrgs[0]?.remoteId ?? "");
  const [slug, setSlug] = useState(detection?.suggestedSlug ?? "");
  const slugState = useSlugAvailability(projectPath, orgId, slug);

  useEffect(() => {
    if (!orgId && cloudOrgs[0]) setOrgId(cloudOrgs[0].remoteId);
  }, [orgId, cloudOrgs]);
  const ready =
    !!orgId &&
    slug.trim().length > 0 &&
    slugState.kind !== "taken" &&
    slugState.kind !== "checking";

  return (
    <div className="space-y-2">
      <p className="text-[12px] font-medium text-[var(--text-primary)]">
        Promote to Cloud
      </p>
      <p className="text-[11px] text-[var(--text-tertiary)]">
        Everything captured here joins your Organisation's timeline. You'll see
        exactly what before anything is sent.
      </p>
      <CloudFields
        cloudOrgs={cloudOrgs}
        orgId={orgId}
        onOrgChange={setOrgId}
        slug={slug}
        onSlugChange={setSlug}
        slugState={slugState}
      />
      <div className="flex justify-end gap-2 pt-1">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton
          busy={busy}
          disabled={!ready}
          onClick={() => onContinue(orgId, slug.trim())}
          label="Continue"
        />
      </div>
    </div>
  );
}

/**
 * The one affirmative action per view.
 *
 * Atlas has no accent *background* token — `--accent-primary` is white, meant
 * for text and rules — so the primary action inverts, matching the app.
 */
function PrimaryButton({
  busy,
  disabled,
  onClick,
  label,
}: {
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded bg-[var(--accent-primary)] px-2 py-1 text-[11px] font-medium text-[var(--text-inverse)] transition-transform duration-150 hover:bg-[var(--accent-primary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.97] disabled:opacity-50"
    >
      {busy && <Loader2 size={11} className="animate-spin" />}
      {label}
    </button>
  );
}

function GhostButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.97] disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function ModeOption({
  selected,
  disabled,
  label,
  hint,
  onSelect,
}: {
  selected: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
        disabled
          ? "cursor-not-allowed opacity-60"
          : selected
            ? "bg-[var(--bg-selected)]"
            : "hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)]",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {disabled ? (
          <Lock size={11} className="text-[var(--text-tertiary)]" />
        ) : selected ? (
          <Check size={11} className="text-[var(--text-primary)]" />
        ) : (
          <span className="block h-[11px] w-[11px] rounded-full border border-[var(--border-strong)]" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[var(--text-primary)]">{label}</span>
        <span className="block text-[11px] text-[var(--text-tertiary)]">
          {hint}
        </span>
      </span>
    </button>
  );
}

/**
 * What Atlas worked out about this directory.
 *
 * Shown rather than asked. None of it is required — it is displayed so the
 * developer can see what will be recorded, and so a wrong-looking origin is
 * caught before binding rather than after.
 */
function Detected({
  detection,
  importPreview,
}: {
  detection: Detection | null;
  importPreview: ImportPreview | null | undefined;
}) {
  if (!detection) return null;

  return (
    <dl className="space-y-0.5 rounded bg-[var(--bg-raised)] px-2 py-1.5 text-[11px]">
      <Row
        label="Folder"
        value={detection.root.split("/").pop() ?? detection.root}
      />
      {detection.gitUrl && <Row label="Origin" value={detection.gitUrl} />}
      {detection.rootCommitSha && (
        <Row
          label="Root"
          value={`${detection.rootCommitSha.slice(0, 7)}${detection.isShallow ? " (shallow)" : ""}`}
        />
      )}
      {!detection.isGitRepository && (
        <Row label="Git" value="not a repository" />
      )}
      {detection.isGitRepository && !detection.hasCommits && (
        <Row label="Git" value="no commits yet" />
      )}
      {importPreview && importPreview.sessionCount > 0 && (
        <Row
          label="History"
          value={`${importPreview.sessionCount} session${importPreview.sessionCount === 1 ? "" : "s"} on disk`}
        />
      )}
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[52px] shrink-0 text-[var(--text-tertiary)]">{label}</dt>
      <dd className="min-w-0 truncate text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

/**
 * The inline `git init` offer.
 *
 * Framed as unlocking commit linkage, not as a requirement — because it is not
 * one. Sessions are captured in any directory; git is what lets a commit be
 * traced back to the Session that produced it.
 */
function GitInitOffer({
  busy,
  onGitInit,
}: {
  busy: boolean;
  onGitInit: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded border border-dashed border-[var(--border-default)] px-2 py-1.5">
      <GitBranch
        size={12}
        className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
      />
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--text-secondary)]">
          Sessions are recorded here already. Initialise git to also link them
          to the commits they produce.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onGitInit}
          className="mt-1 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.98] disabled:opacity-50"
        >
          Initialise git
        </button>
      </div>
    </div>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────────

function dateRange(
  earliest: string | null,
  latest: string | null,
): string | null {
  if (!earliest || !latest) return null;
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  };
  const from = new Date(earliest).toLocaleDateString(undefined, options);
  const to = new Date(latest).toLocaleDateString(undefined, options);
  return from === to ? from : `${from} – ${to}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
