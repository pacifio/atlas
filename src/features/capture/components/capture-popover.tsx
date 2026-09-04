import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpRight,
  Check,
  Cloud,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  History,
  Laptop,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";

import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";
import { cn } from "@/lib/utils";

import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";

import { CaptureDot } from "./capture-status";

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
 *
 * **Cloud follows the active Organisation, and only that one.** Capture is
 * per-project and a project belongs to the Organisation you are working in, so
 * offering a picker over every linked Organisation invites binding a repository
 * into a tenant you are not looking at — and the mistake is only visible later,
 * in a shared timeline. The Organisation row below is therefore a label, not a
 * choice.
 */

/**
 * Cloud capture is switched off in the client.
 *
 * The ingest service (`ingest.tryatlas.cc`) currently answers **405 method not
 * allowed to every GET** — `GET /workspaces` and `GET /workspaces/slug-available`
 * are not deployed, only the POST routes are. So Connect could never list
 * anything ("Could not reach the server"), the Slug check could only ever say
 * "couldn't check", and Create-Cloud would bind a Workspace whose drain has
 * nowhere to read back from. None of that is a client fault and none of it is
 * fixable here.
 *
 * Local capture is unaffected — it never touches the network, which is the whole
 * point of it being a real mode rather than a waiting room.
 *
 * Flip this to `true` when the ingest service serves its read endpoints; nothing
 * else needs to change.
 */
const CLOUD_CAPTURE_ENABLED = false;

/** Said wherever Cloud is offered, so the reason is on the control itself. */
const CLOUD_UNAVAILABLE_REASON = "Cloud capture isn't available yet";

/**
 * The house form language, shared with the create-organisation modal.
 *
 * Copied rather than extracted: there are two call sites, they are in different
 * features, and a shared "form kit" would have to absorb both sets of quirks to
 * earn its keep. If a third appears, extract then.
 */
const FIELD =
  "h-8 w-full rounded-lg border border-[#303030] bg-[#0C0C0C] px-2.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors focus:border-[#4a4a4a]";

/** Section heading above a group of controls. */
const SECTION_LABEL = "text-[11px] font-medium text-[var(--text-secondary)]";

/** Hint under a group — the sentence that explains what was just chosen. */
const HINT = "mt-1 text-[10px] leading-[14px] text-[var(--text-tertiary)]";

/** A read-only group of facts (detection, disclosure lines). */
const GROUP = "rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2";

/** Selectable pill — the Type/Region language from the organisation modal. */
function pillClass(state: "on" | "off" | "disabled") {
  return cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-none transition-colors",
    state === "disabled"
      ? "cursor-not-allowed border-[#242424] bg-[#0C0C0C] text-[var(--text-tertiary)] opacity-40"
      : state === "on"
        ? "cursor-pointer border-[#4a4a4a] bg-[#1f1f1f] text-[var(--text-primary)]"
        : "cursor-pointer border-[#303030] bg-[#0C0C0C] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
  );
}

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

export function CapturePopover({ projectPath, health, onChanged, onClose }: Props) {
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

  const [binding, setBinding] = useState<Binding | null>(null);
  /**
   * Has the first read landed?
   *
   * `binding` starts `null`, which is also what an unbound project reads as —
   * so the popover rendered the whole **Create** form for the frame before the
   * read resolved, then swapped to the bound state. On an enabled project that
   * is a visible flash of the wrong UI every single time it opens. Nothing at
   * all renders until the answer is in; the read is a local SQLite hit, so the
   * wait is imperceptible and the panel's enter animation simply starts a frame
   * later, fully formed.
   */
  const [loaded, setLoaded] = useState(false);
  const [detection, setDetection] = useState<Detection | null>(null);
  /** `undefined` while the read is in flight, `null` once it failed — the
   *  Cloud "Continue" button needs the difference to gate honestly. */
  const [importPreview, setImportPreview] = useState<ImportPreview | null | undefined>(undefined);
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
        invoke<ImportPreview>("capture_import_preview", { projectPath }).catch(() => null),
      ]);
      setBinding(current);
      setDetection(detected);
      setImportPreview(preview);
    } catch (e) {
      setError(String(e));
    } finally {
      // In `finally`, so a failed read still opens the panel — with the error
      // on it — rather than leaving a permanently empty popover.
      setLoaded(true);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-read just the preview — the retry for a failed preview load. */
  const retryPreview = useCallback(async () => {
    setImportPreview(undefined);
    try {
      setImportPreview(await invoke<ImportPreview>("capture_import_preview", { projectPath }));
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

  // Ordered most-actionable-last: the service being down is not something the
  // developer can fix, so it is stated first and the account-shaped reasons only
  // surface once it is back.
  const cloudReason = !CLOUD_CAPTURE_ENABLED
    ? CLOUD_UNAVAILABLE_REASON
    : !signedIn
      ? "Sign in to share with an Organisation"
      : cloudOrgs.length === 0
        ? `“${activeOrg?.name ?? "This Organisation"}” is local-only — sync it to use Cloud`
        : null;

  // See `loaded`: rendering before the first read flashes the wrong state.
  if (!loaded) return null;

  return (
    <div
      className={cn(
        "w-[352px] select-none overflow-hidden rounded-xl text-[12px]",
        // Border, translucent fill and blur all on THIS element — the same one
        // the enter animation transforms. Splitting them across a wrapper would
        // isolate the compositing layer and flatten the blur to flat
        // transparency (see the note beside the keyframes in globals.css).
        "border border-white/10 bg-[var(--bg-elevated)]/85 backdrop-blur-2xl",
        "atlas-panel-in-tl",
      )}
      style={{
        // Drop shadow only. The inset top hairline that used to be here landed
        // *on top of* the 1px border, so the top edge read twice as heavy as the
        // other three. No `will-change` — it would isolate the layer and kill
        // the blur.
        boxShadow: "0 16px 48px rgba(0,0,0,0.95)",
      }}
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
            <BoundState
              projectPath={projectPath}
              binding={binding}
              detection={detection}
              health={health}
              importPreview={importPreview}
              cloudOrgs={cloudOrgs}
              cloudReason={cloudReason}
              busy={busy}
              run={run}
              onReviewImport={() =>
                importPreview && setView({ kind: "import-confirm", preview: importPreview })
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
              const ok = await run(() => invoke("capture_import_confirm", { projectPath }));
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
                const preview = await invoke<PromotionPreview>("capture_promotion_preview", {
                  projectPath,
                });
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
          <p className="mt-2 rounded-lg bg-[var(--status-error-muted)] px-2.5 py-1.5 text-[11px] text-[var(--status-error)]">
            {error}
          </p>
        )}
      </div>
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
    <div className="atlas-fade-in space-y-2.5">
      <p className="text-[12px] font-medium text-[var(--text-primary)]">{title}</p>
      <ul className={cn(GROUP, "space-y-1")}>
        {lines.map((line) => (
          <li key={line} className="text-[11px] text-[var(--text-secondary)]">
            {line}
          </li>
        ))}
      </ul>
      <p className="text-[10px] leading-[14px] text-[var(--text-tertiary)]">
        This makes the above visible to your Organisation. Nothing is sent until you confirm.
      </p>
      <div className="flex justify-end gap-2 pt-0.5">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton busy={busy} onClick={onConfirm} label={confirmLabel} />
      </div>
    </div>
  );
}

/**
 * Why capture is degraded or stopped, and one click to try to fix it.
 *
 * Nothing renders while healthy or switched off — a permanent banner trains
 * people to stop reading the thing they are supposed to notice.
 *
 * **One line per issue.** It used to stack the reason over its `nextStep` as two
 * paragraphs, which turned a two-issue banner into four lines of red prose that
 * nobody finished reading. The reason is the line; the `nextStep` moves to the
 * title, so it is still reachable and no longer competing.
 *
 * **The banner is the retry.** Clicking it re-runs `capture_retry_watcher`,
 * which restarts the git watcher and answers with the health that *results* —
 * so the banner either clears or keeps saying what is still wrong, rather than
 * clearing optimistically and returning on the next poll. The retry is offered
 * for any unhealthy state rather than only the watcher issue: `HealthIssue`
 * carries prose, not a machine-readable code, and string-matching a sentence to
 * decide whether a button appears is the kind of thing that breaks silently the
 * next time the wording changes. Re-running health is harmless when the problem
 * was something else — it just tells the truth again.
 */
function HealthDetail({
  health,
  projectPath,
  onRetried,
}: {
  health: CaptureHealth | null;
  projectPath: string;
  /** Re-read after a retry. `health` is owned by the titlebar, so the banner
   *  updates by asking it to re-read rather than by holding a second copy. */
  onRetried: () => void;
}) {
  const [retrying, setRetrying] = useState(false);

  if (!health || health.issues.length === 0) return null;

  const stopped = health.state === "stopped";
  const tone = stopped ? "var(--status-error)" : "var(--status-warning)";

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await invoke<CaptureHealth>("capture_retry_watcher", {
        projectPath,
        workspaceId: activeWorkspaceId(),
      });
      onRetried();
    } catch {
      // The banner is already saying something is wrong; a failed retry does
      // not need a second, competing error.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void retry()}
      disabled={retrying}
      aria-label="Retry — restart capture for this project"
      className={cn(
        // The ants are drawn as background gradients, so the fill has to be a
        // background-COLOR or it would paint over them.
        "atlas-ants mb-2.5 block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-opacity",
        "hover:opacity-90 disabled:cursor-wait",
      )}
      style={{
        backgroundColor: stopped ? "var(--status-error-muted)" : "var(--status-warning-muted)",
        ["--atlas-ants-color" as string]: `color-mix(in oklab, ${tone} 55%, transparent)`,
      }}
    >
      <span className="flex flex-col gap-1">
        {health.issues.map((issue, index) => (
          // Index in the key: two issues can share their reason text.
          <span
            key={`${index}-${issue.reason}`}
            title={issue.nextStep || undefined}
            className={cn(
              "flex items-center gap-1.5 text-[11px]",
              issue.state === "stopped"
                ? "text-[var(--status-error)]"
                : "text-[var(--status-warning)]",
            )}
          >
            {index === 0 &&
              (retrying ? (
                <Loader2 size={10} className="shrink-0 animate-spin" />
              ) : (
                <RefreshCw size={10} className="shrink-0 opacity-70" />
              ))}
            <span className="min-w-0 flex-1 truncate">{issue.reason}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

/**
 * Radar geometry, in px inside the box.
 *
 * Everything is polar around one origin — the dish, at the bottom centre — and
 * that is the whole reason it reads as a scope. The first version positioned
 * the rings as *percentage-width* ellipses in a 112px-tall box, so the visible
 * slice of each was nearly a straight line; the box has to be tall enough for a
 * ring's radius to fit inside it or there is no curve to see.
 */
const RADAR_HEIGHT = 176;
const RADAR_ORIGIN_X = 176; // half of the 352px panel
const RADAR_RINGS = [56, 100, 144, 188];

/** Blips sit **on** the rings, like real contacts. `deg` is from the +x axis. */
const RADAR_BLIPS = [
  { r: 100, deg: 150 },
  { r: 144, deg: 118 },
  { r: 188, deg: 45 },
  { r: 56, deg: 42 },
  { r: 144, deg: 24 },
  { r: 100, deg: 74 },
  { r: 188, deg: 143 },
] as const;

function blipAt({ r, deg }: { r: number; deg: number }) {
  const rad = (deg * Math.PI) / 180;
  return {
    left: RADAR_ORIGIN_X + r * Math.cos(rad),
    top: RADAR_HEIGHT - r * Math.sin(rad),
  };
}

/**
 * The recorder, drawn.
 *
 * A bound project's panel opens onto this instead of a title bar. It says the
 * one thing a status line said in words — *something is listening* — and says
 * it in the half-second before anyone reads a label. The sweep wobbles rather
 * than spinning: a full rotation reads as a loading spinner, which is exactly
 * the wrong idea for something that never finishes.
 *
 * Drawn in CSS (rings are `border-t` on `rounded-full` boxes centred on the
 * dish, the sweep is one rotating radial gradient) rather than as an asset, so
 * it inherits the status colours and costs nothing to ship. Only the
 * highlighted blip needs state, and it only ticks while the popover is open.
 */
function CaptureRadar({ live, health }: { live: boolean; health: CaptureHealth | null }) {
  const [blip, setBlip] = useState(0);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setBlip((n) => (n + 1) % RADAR_BLIPS.length), 2400);
    return () => clearInterval(timer);
  }, [live]);

  const tone =
    health?.state === "stopped"
      ? "var(--status-error)"
      : health?.state === "degraded"
        ? "var(--status-warning)"
        : "var(--capture-live)";

  const active = blipAt(RADAR_BLIPS[blip]);

  return (
    <div
      className="relative overflow-hidden border-b border-white/5 bg-black/40"
      style={{ height: RADAR_HEIGHT }}
    >
      {/* Range rings: true circles centred on the dish. `border-t` draws only
          the upper arc, which is the half that is inside the box — a full
          border would leave two stray verticals down the left and right edges
          where the circle passes the origin's own row. */}
      {RADAR_RINGS.map((r) => (
        <span
          key={r}
          aria-hidden
          className="absolute rounded-full border-t border-dashed border-white/[0.07]"
          style={{
            width: r * 2,
            height: r * 2,
            left: RADAR_ORIGIN_X - r,
            top: RADAR_HEIGHT - r,
          }}
        />
      ))}

      {/* The sweep, radiating from the dish. */}
      {live && (
        <span
          aria-hidden
          className="atlas-radar-sweep pointer-events-none absolute bottom-0 h-[200px] w-[200px] origin-bottom-left"
          style={{
            left: RADAR_ORIGIN_X,
            background: `radial-gradient(circle at 0% 100%, color-mix(in oklab, ${tone} 22%, transparent) 5%, transparent 62%)`,
          }}
        />
      )}

      {RADAR_BLIPS.map((b, i) => {
        const at = blipAt(b);
        return (
          <span
            key={`${b.r}-${b.deg}`}
            aria-hidden
            className={cn(
              "absolute size-[4px] rounded-[1px] transition-colors duration-500",
              i === blip && live ? "" : "bg-white/20",
            )}
            style={{
              top: at.top - 2,
              left: at.left - 2,
              ...(i === blip && live
                ? {
                    backgroundColor: tone,
                    boxShadow: `0 0 10px 3px color-mix(in oklab, ${tone} 45%, transparent)`,
                  }
                : null),
            }}
          />
        );
      })}

      {/* The pulse ring, keyed on the blip so it restarts on each hop. */}
      {live && (
        <span
          key={blip}
          aria-hidden
          className="atlas-radar-ping absolute size-[16px] rounded-full border"
          style={{ top: active.top - 8, left: active.left - 8, borderColor: tone }}
        />
      )}

      {/* The dish the sweep radiates from — a disc bisected by the bottom edge,
          so the origin of every ring is visibly a thing rather than a corner. */}
      <span
        aria-hidden
        className="absolute size-[92px] rounded-full border border-white/[0.07] bg-[var(--bg-elevated)]"
        style={{ left: RADAR_ORIGIN_X - 46, top: RADAR_HEIGHT - 46 }}
      />

      <span className="absolute bottom-3 left-3.5 flex items-center gap-1.5">
        <CaptureDot live={live} tone={live ? "success" : "idle"} />
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-tertiary)]">
          {live ? "Capturing" : "Paused"}
        </span>
      </span>
    </div>
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
  cloudReason,
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
  /** Non-null when Cloud is unavailable, and why. Hides Promote. */
  cloudReason: string | null;
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
       *  demanding anything. Sessions are already being captured either way. */}
      {detection && !detection.isGitRepository && (
        <GitInitOffer
          busy={busy}
          onGitInit={() => void run(() => invoke("capture_git_init", { projectPath }))}
        />
      )}

      {/* A Cloud Workspace whose bulk import was never approved imports
       *  nothing, forever, on purpose. Say so where it can be resolved. */}
      {binding.mode === "cloud" && !binding.importApproved && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-white/[0.10] px-2.5 py-1.5">
          <span className="text-[11px] text-[var(--text-secondary)]">
            History import is waiting for your review.
          </span>
          <button
            type="button"
            disabled={busy || !importPreview}
            onClick={onReviewImport}
            className="shrink-0 cursor-pointer rounded-full px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review
          </button>
        </div>
      )}

      {/* Failed rows: the retry is a deliberate human action, never automatic. */}
      {failed > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--status-warning-muted)] px-2.5 py-1.5">
          <span className="text-[11px] text-[var(--status-warning)]">
            {failed} record{failed === 1 ? "" : "s"} could not be sent.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => invoke("capture_retry_failed", { projectPath }))}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={10} />
            Retry
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {/* Where this Workspace's Sessions live. A label, not a control — the
         *  way to change it is the Sync button beside it. */}
        <span className="mr-auto flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
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
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11px] text-[var(--text-tertiary)] opacity-40"
            >
              <Cloud size={11} />
              Sync
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onPromote}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.05] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpRight size={11} />
              Sync
            </button>
          ))}

        {binding.enabled ? (
          <GhostButton
            label="Pause capture"
            disabled={busy}
            onClick={() => void run(() => invoke("capture_disable", { projectPath }))}
          />
        ) : (
          <PrimaryButton
            busy={busy}
            // Always "local": the command rejects "cloud" outright, and an
            // existing Cloud binding keeps its mode on re-enable regardless.
            onClick={() => void run(() => invoke("capture_enable", { projectPath, mode: "local" }))}
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

  // Connect is a purely server-backed flow — there is nothing it can show
  // without the Organisation's Workspace list, so it is disabled rather than
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
        <div key="create" className="atlas-fade-in space-y-2.5">
          <div>
            <span className={SECTION_LABEL}>Where sessions are stored</span>
            <div
              role="radiogroup"
              aria-label="Where sessions are stored"
              className="mt-1 flex gap-1.5"
            >
              <ModeOption
                selected={mode === "local"}
                disabled={false}
                label="Local"
                onSelect={() => setMode("local")}
              />
              <ModeOption
                selected={mode === "cloud"}
                disabled={!!cloudReason}
                reason={cloudReason}
                label="Cloud"
                onSelect={() => setMode("cloud")}
              />
            </div>
            {/* Describes the CHOSEN mode, and only that. Why Cloud is
             *  unavailable rides on the disabled pill itself (lock glyph +
             *  title) rather than as a line of prose under a selected Local,
             *  where it read as Local being the thing that was broken. */}
            <p className={HINT}>
              {mode === "cloud"
                ? "Shared with your Organisation."
                : "This machine only — no account needed."}
            </p>
          </div>

          {mode === "cloud" && (
            <CloudFields
              cloudOrgs={cloudOrgs}
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
              onGitInit={() => void run(() => invoke("capture_git_init", { projectPath }))}
            />
          )}

          {/* The preview read failed: Continue has nothing to disclose, so say
           *  so where it blocks, with the retry right there. */}
          {mode === "cloud" && importPreview === null && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--status-warning-muted)] px-2.5 py-1.5">
              <span className="text-[11px] text-[var(--status-warning)]">
                Couldn't read this Workspace's history.
              </span>
              <button
                type="button"
                onClick={onRetryPreview}
                className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline"
              >
                <RefreshCw size={10} />
                Retry
              </button>
            </div>
          )}

          {/* Create only. The Connect tab is a list of existing Workspaces —
           *  someone there has already been sold on the Timeline. */}
          <TimelinePreview />

          <div className="flex justify-end gap-2 pt-0.5">
            <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
            <PrimaryButton
              busy={busy || previewLoading}
              disabled={!cloudReady}
              onClick={() => {
                if (mode === "local") {
                  void run(() => invoke("capture_enable", { projectPath, mode: "local" }));
                } else {
                  // No mutation yet — the disclosure step owns all of them.
                  onCloudEnable(orgId, slug.trim());
                }
              }}
              label={mode === "cloud" ? "Continue" : "Enable"}
            />
          </div>
        </div>
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

function Tabs({
  tab,
  onTabChange,
  connectDisabled,
  connectReason,
}: {
  tab: "create" | "connect";
  onTabChange: (tab: "create" | "connect") => void;
  connectDisabled: boolean;
  /** Shown on hover, so the disabled tab explains itself in place. */
  connectReason: string | null;
}) {
  // Pills rather than a segmented control: these are two *ways in*, not two
  // views of one thing, and the pill row is the same shape the feedback panel
  // uses for its categories.
  return (
    <div role="tablist" aria-label="Set up session capture" className="flex gap-1">
      {(
        [
          ["create", "Create"],
          ["connect", "Connect"],
        ] as const
      ).map(([id, label]) => {
        const disabled = id === "connect" && connectDisabled;
        const on = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={disabled}
            title={disabled ? (connectReason ?? undefined) : undefined}
            className={cn(
              "h-6 rounded-full border px-2.5 text-[11px] transition-colors",
              disabled
                ? "cursor-not-allowed border-white/[0.04] bg-white/[0.01] text-[var(--text-tertiary)] opacity-40"
                : on
                  ? "cursor-pointer border-white/15 bg-white/[0.10] text-[var(--text-primary)]"
                  : "cursor-pointer border-white/[0.06] bg-white/[0.02] text-[var(--text-tertiary)] hover:bg-white/[0.05] hover:text-[var(--text-secondary)]",
            )}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        );
      })}
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
function useSlugAvailability(projectPath: string, orgId: string, slug: string): SlugState {
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
          else setState({ kind: "unknown", retry: () => setNonce((n) => n + 1) });
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
  slug,
  onSlugChange,
  slugState,
}: {
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  slug: string;
  onSlugChange: (slug: string) => void;
  slugState: SlugState;
}) {
  return (
    <div className={cn(GROUP, "space-y-2")}>
      {/* A label, not a picker: the destination is the Organisation you have
       *  open. Choosing another one here would bind this repository into a
       *  tenant you are not looking at, and the mistake only shows up later in
       *  someone else's timeline. */}
      <div className="flex items-center gap-2">
        <span className="w-[70px] shrink-0 text-[11px] text-[var(--text-tertiary)]">
          Organisation
        </span>
        <span className="truncate text-[11px] text-[var(--text-secondary)]">
          {cloudOrgs[0]?.name ?? "—"}
        </span>
      </div>

      <label className="flex items-center gap-2">
        <span className="w-[70px] shrink-0 text-[11px] text-[var(--text-tertiary)]">Slug</span>
        <input
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="my-project"
          className={cn(FIELD, "h-7 flex-1 font-mono text-[11px]")}
        />
      </label>

      <SlugStatus state={slugState} />
    </div>
  );
}

function SlugStatus({ state }: { state: SlugState }) {
  if (state.kind === "idle") return null;
  return (
    <p className="flex items-center gap-1 pl-[78px] text-[10px]">
      {state.kind === "checking" && (
        <>
          <Loader2 size={10} className="animate-spin text-[var(--text-tertiary)]" />
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
          <span className="text-[var(--status-error)]">taken in this Organisation</span>
        </>
      )}
      {state.kind === "unknown" && (
        <>
          <span className="text-[var(--status-warning)]">couldn't check</span>
          <button
            type="button"
            onClick={state.retry}
            className="cursor-pointer text-[var(--text-secondary)] underline underline-offset-2 transition-colors duration-150 hover:text-[var(--text-primary)]"
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
  const [options, setOptions] = useState<ConnectOptions | null | undefined>(undefined);
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
      <p className={cn(GROUP, "flex items-start gap-1.5 text-[11px] text-[var(--text-tertiary)]")}>
        <Lock size={11} className="mt-px shrink-0" />
        {cloudReason}
      </p>
    );
  }

  const workspace = options?.workspaces.find((w) => w.id === selected);

  return (
    <div className="space-y-2">
      {options === undefined ? (
        <p className="flex items-center gap-1.5 py-2 text-[11px] text-[var(--text-tertiary)]">
          <Loader2 size={11} className="animate-spin" />
          Fetching this Organisation's Workspaces…
        </p>
      ) : options === null ? (
        <p className="rounded-lg bg-[var(--status-warning-muted)] px-2.5 py-1.5 text-[11px] text-[var(--status-warning)]">
          Could not reach the server. Check the connection and reopen this tab.
        </p>
      ) : options.workspaces.length === 0 ? (
        <p className={cn(GROUP, "text-[11px] text-[var(--text-tertiary)]")}>
          This Organisation has no Workspaces yet. Create one from the Create tab instead.
        </p>
      ) : (
        <>
          {options.warning && (
            <p className="rounded-lg bg-[var(--status-warning-muted)] px-2.5 py-1.5 text-[11px] text-[var(--status-warning)]">
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
                  "flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150",
                  selected === remote.id
                    ? "border-white/15 bg-white/[0.06]"
                    : "border-transparent hover:bg-white/[0.03]",
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
      <p className="text-[12px] font-medium text-[var(--text-primary)]">Promote to Cloud</p>
      <p className="text-[11px] text-[var(--text-tertiary)]">
        Everything captured here joins your Organisation's timeline. You'll see exactly what before
        anything is sent.
      </p>
      <CloudFields cloudOrgs={cloudOrgs} slug={slug} onSlugChange={setSlug} slugState={slugState} />
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
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] font-medium leading-none text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
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
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] font-medium leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

/**
 * One storage choice, as a pill.
 *
 * The explanation lives in a single hint line under the group rather than on
 * each option: two stacked cards each carrying their own sentence made the
 * first thing in the popover the tallest, and the choice is genuinely one line
 * of consequence, not two paragraphs.
 */
function ModeOption({
  selected,
  disabled,
  reason,
  label,
  onSelect,
}: {
  selected: boolean;
  disabled: boolean;
  /** Why it can't be picked — carried on the control itself, not just below it. */
  reason?: string | null;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      title={disabled ? (reason ?? undefined) : undefined}
      onClick={onSelect}
      className={pillClass(disabled ? "disabled" : selected ? "on" : "off")}
    >
      {disabled ? (
        <Lock size={10} />
      ) : (
        selected && <Check size={10} className="text-[var(--text-primary)]" />
      )}
      {label}
    </button>
  );
}

/**
 * What Atlas worked out about this directory.
 *
 * Shown rather than asked. None of it is required — it is displayed so the
 * developer can see what will be recorded, and so a wrong-looking origin is
 * caught before binding rather than after.
 *
 * Rendered as a **status list, not a definition list.** The label/value grid it
 * replaced was four rows of grey text with nothing to fix the eye on, and it
 * read as a dump rather than as findings. Each row now leads with an icon that
 * carries the verdict — green when the thing is there, dashed when it is
 * missing but harmless — so the shape of the answer is legible before any of it
 * is read.
 */
function Detected({
  detection,
  importPreview,
}: {
  detection: Detection | null;
  importPreview: ImportPreview | null | undefined;
}) {
  if (!detection) return null;

  const folder = detection.root.split("/").pop() ?? detection.root;
  const sessions = importPreview?.sessionCount ?? 0;

  return (
    <div className={cn(GROUP, "space-y-1.5")}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
        This project
      </p>

      <StatusRow icon={FolderGit2} ok value={folder} caption="folder" mono={false} />

      {detection.isGitRepository ? (
        <>
          <StatusRow
            icon={GithubIcon}
            ok
            value={detection.gitUrl?.replace(/^https?:\/\//, "") ?? "no remote"}
            caption={detection.gitUrl ? "origin" : "local only"}
          />
          {detection.rootCommitSha ? (
            <StatusRow
              icon={GitCommitHorizontal}
              ok
              value={detection.rootCommitSha.slice(0, 7)}
              caption={detection.isShallow ? "root · shallow" : "root commit"}
            />
          ) : (
            // Not a fault: a repository with no commits captures fine, it just
            // has nothing for a Checkpoint to attach to yet.
            <StatusRow
              icon={GitCommitHorizontal}
              ok={false}
              value="no commits yet"
              caption="root"
            />
          )}
        </>
      ) : (
        <StatusRow
          icon={GitBranch}
          ok={false}
          value="not a repository"
          caption="commits won't link"
        />
      )}

      <StatusRow
        icon={History}
        ok={sessions > 0}
        value={sessions > 0 ? `${sessions} session${sessions === 1 ? "" : "s"}` : "no history yet"}
        caption="on disk"
        mono={false}
      />
    </div>
  );
}

/** One finding: verdict icon, the value, and what the value is. */
function StatusRow({
  icon: Icon,
  ok,
  value,
  caption,
  mono = true,
}: {
  icon: typeof GitBranch;
  ok: boolean;
  value: string;
  caption: string;
  /** Paths, URLs and SHAs read better monospaced; counts and names do not. */
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon
        size={11}
        strokeWidth={1.75}
        className={cn("shrink-0", ok ? "text-[var(--text-secondary)]" : "text-[var(--text-ghost)]")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px]",
          mono && "font-mono",
          ok ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]",
        )}
      >
        {value}
      </span>
      <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-[var(--text-ghost)]">
        {caption}
      </span>
    </div>
  );
}

/**
 * A small mock of what capture is *for*.
 *
 * The form above answers "where do sessions go"; nothing on the screen answered
 * "and then what". This is the answer, at a glance: a prompt, the work, and the
 * commit it turned into, on one thread. It is an illustration rather than live
 * data on purpose — there is nothing recorded yet, and a real-looking empty
 * state would undersell the feature at the exact moment it is being sold.
 *
 * The pulse running the rail is what stops it reading as a screenshot.
 */
function TimelinePreview() {
  const rows = [
    { dot: "prompt", text: "Fix the parser panic", meta: "prompt" },
    { dot: "tool", text: "Edit src/parser.rs", meta: "3 files" },
    { dot: "commit", text: "a1b2c3d parser: guard empty input", meta: "checkpoint" },
  ] as const;

  return (
    <div className={cn(GROUP, "overflow-hidden")}>
      <div className="flex items-center gap-1.5">
        <Layers size={10} className="text-[var(--text-tertiary)]" />
        <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
          Timeline
        </span>
        <span className="ml-auto text-[9px] text-[var(--text-ghost)]">preview</span>
      </div>

      <div className="relative mt-2">
        {/* The rail sits behind the nodes, centred on them: the dots are 7px, so
            a 1px line at 3px is their axis. Insetting it top and bottom stops it
            poking out past the first and last node. The nodes themselves are
            laid out in flow — hand-positioning them meant re-deriving a magic
            offset every time the row height changed. */}
        <span className="absolute bottom-[7px] left-[3px] top-[7px] w-px bg-white/[0.08]" />
        <span
          className="atlas-timeline-beam absolute left-[2px] top-[3px] h-2.5 w-[3px] rounded-full bg-[var(--capture-live)]"
          style={{ "--atlas-beam-travel": "42px" } as React.CSSProperties}
        />

        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div
              key={row.text}
              className="atlas-timeline-row flex items-center gap-2"
              style={{ animationDelay: `${120 + i * 90}ms` }}
            >
              <span
                className={cn(
                  "relative size-[7px] shrink-0 rounded-full border",
                  row.dot === "commit"
                    ? "border-[var(--capture-live)] bg-[var(--capture-live)]"
                    : "border-white/20 bg-[var(--bg-elevated)]",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[10px]",
                  row.dot === "commit"
                    ? "font-mono text-[var(--text-secondary)]"
                    : "text-[var(--text-secondary)]",
                )}
              >
                {row.text}
              </span>
              <span className="shrink-0 text-[9px] text-[var(--text-ghost)]">{row.meta}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 text-[10px] leading-[14px] text-[var(--text-tertiary)]">
        Every prompt, tool call and commit, kept on one thread you can reopen months later.
      </p>
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
function GitInitOffer({ busy, onGitInit }: { busy: boolean; onGitInit: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-white/[0.10] px-2.5 py-2">
      <GitBranch size={12} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--text-secondary)]">
          Sessions are recorded here already. Initialise git to also link them to the commits they
          produce.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onGitInit}
          className="mt-1 cursor-pointer text-[11px] text-[var(--text-primary)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          Initialise git
        </button>
      </div>
    </div>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────────

function dateRange(earliest: string | null, latest: string | null): string | null {
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
