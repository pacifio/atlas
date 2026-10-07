import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronDown,
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

import { activeProjectId } from "@/features/projects/lib/active-project";

import { CaptureDot } from "./capture-status";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

import type {
  Binding,
  CaptureHealth,
  ConnectOptions,
  ConnectPick,
  ConnectResult,
  Detection,
  ImportPreview,
  PromotionPreview,
  SlugAvailability,
  ProjectMode,
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
 * disclosure would leave a bound Project behind a Cancel, which is exactly
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
 * Cloud capture was gated off here for as long as the ingest service answered
 * 405 to every GET, which made Connect unable to list and the Slug check unable
 * to answer. Those read routes are deployed now, so the gate is gone and the
 * only remaining reasons are the ones the developer can act on — see
 * `cloudReason`.
 *
 * Local capture is unaffected either way: it never touches the network, which is
 * the whole point of it being a real mode rather than a waiting room.
 */

/**
 * The house form language, shared with the create-organisation modal.
 *
 * Copied rather than extracted: there are two call sites, they are in different
 * features, and a shared "form kit" would have to absorb both sets of quirks to
 * earn its keep. If a third appears, extract then.
 */
const FIELD =
  "h-8 w-full rounded-lg border border-border bg-panel-input px-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none transition-colors focus:border-border-strong";

/** Section heading above a group of controls. */
const SECTION_LABEL = "text-xs font-medium text-[var(--secondary-foreground)]";

/** Hint under a group — the sentence that explains what was just chosen. */
const HINT = "mt-1 text-2xs text-[var(--muted-foreground)]";

/** A read-only group of facts (detection, disclosure lines). */
const GROUP =
  "rounded-lg border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-2";

/** Selectable pill — the Type/Region language from the organisation modal. */
function pillClass(state: "on" | "off" | "disabled") {
  return cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-none transition-colors",
    state === "disabled"
      ? "cursor-not-allowed border-border bg-panel-input text-[var(--muted-foreground)] opacity-40"
      : state === "on"
        ? "cursor-pointer border-border-strong bg-accent text-[var(--foreground)]"
        : "cursor-pointer border-border bg-panel-input text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
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

/**
 * Everything a Cloud registration is created with.
 *
 * Carried as one value through the disclosure step rather than as four
 * parallel fields, so adding a fifth does not touch every signature between
 * the form and the confirm.
 */
export interface CloudDraft {
  orgId: string;
  slug: string;
  /** May be empty — a Project with no remote is legitimate. */
  gitUrl: string;
  restricted: boolean;
}

type View =
  | { kind: "main" }
  /** Cloud create: the import disclosure, with the registration still pending. */
  | {
      kind: "cloud-confirm";
      draft: CloudDraft;
      preview: ImportPreview;
    }
  /** Bound Cloud Project whose history import awaits approval. */
  | { kind: "import-confirm"; preview: ImportPreview }
  /** Local→Cloud promotion: pick the destination — a new Project, or an
   *  existing one. The tab is part of the view so a failed Continue lands
   *  back where the pick was made. */
  | { kind: "promote-form"; tab: PromoteTab }
  /** Local→Cloud promotion onto a NEW Project: the disclosure. */
  | {
      kind: "promote-confirm";
      draft: CloudDraft;
      preview: PromotionPreview;
    }
  /** Local→Cloud promotion onto an EXISTING Project: the disclosure. */
  | {
      kind: "promote-connect-confirm";
      pick: ConnectPick;
      preview: PromotionPreview;
    }
  /** Cloud→Cloud: pick a different Project in the same Organisation. */
  | { kind: "switch-form" }
  /** Cloud→Cloud: the disclosure — everything is re-sent, comments stay. */
  | {
      kind: "switch-confirm";
      pick: ConnectPick;
      preview: PromotionPreview;
    };

type PromoteTab = "create" | "connect";

/**
 * Why the server bound nothing, as one sentence the developer can act on.
 * Shared by the unbound Connect tab and the promote-onto-existing confirm.
 */
function connectRefusal(candidates: unknown[]): string {
  return candidates.length > 0
    ? `${candidates.length} Projects share this repository’s root commit. Pick the right one — repositories created from the same template look identical here.`
    : "The server did not recognize this pick. Reopen this tab to refresh the Project list.";
}

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
  /**
   * Is `git` on this machine at all?
   *
   * Assumed present until the probe says otherwise, so the common case never
   * flashes a banner. Distinct from `detection.isGitRepository`, which is about
   * *this directory* and is what the `git init` offer fixes — no amount of
   * `git init` helps a machine with no git.
   */
  const [gitAvailable, setGitAvailable] = useState(true);
  /** `undefined` while the read is in flight, `null` once it failed — the
   *  Cloud "Continue" button needs the difference to gate honestly. */
  const [importPreview, setImportPreview] = useState<ImportPreview | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [current, detected, preview, hasGit] = await Promise.all([
        invoke<Binding | null>("capture_binding", { projectPath }),
        invoke<Detection>("capture_detect", { projectPath }),
        // Read-only and cheap — the "history N sessions on disk" row and both
        // disclosure steps feed off it. A failure lands as `null`, which the
        // Cloud path surfaces with a retry instead of silently no-opping.
        invoke<ImportPreview>("capture_import_preview", { projectPath }).catch(() => null),
        // A failed probe reads as "git is there": a banner shown wrongly is
        // worse than one missed, because the machine that really has no git
        // finds out from the very next operation anyway.
        invoke<boolean>("capture_git_available").catch(() => true),
      ]);
      setBinding(current);
      setDetection(detected);
      setImportPreview(preview);
      setGitAvailable(hasGit);
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

  /**
   * The promote disclosure's numbers. Read-only — a failure lands in the error
   * strip and leaves the form where it was, so nothing is lost but a click.
   */
  const loadPromotionPreview = async (): Promise<PromotionPreview | null> => {
    setBusy(true);
    setError(null);
    try {
      return await invoke<PromotionPreview>("capture_promotion_preview", { projectPath });
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

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
      // pre-action state over a Project that changed is a lie. `load` never
      // clears `error` on success, so the failure stays visible.
      await load();
      onChanged();
      setBusy(false);
    }
  };

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
        "w-[352px] select-none overflow-hidden rounded-xl text-sm shadow-md",
        // Border, translucent fill and blur all on THIS element — the same one
        // the enter animation transforms. Splitting them across a wrapper would
        // isolate the compositing layer and flatten the blur to flat
        // transparency (see the note beside the keyframes in globals.css).
        "border border-[var(--atlas-element-active)] bg-[var(--card)]/95 backdrop-blur-2xl",
        "atlas-panel-in-tl",
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
            <BoundState
              projectPath={projectPath}
              binding={binding}
              detection={detection}
              gitAvailable={gitAvailable}
              health={health}
              importPreview={importPreview}
              cloudOrgs={cloudOrgs}
              cloudReason={cloudReason}
              busy={busy}
              run={run}
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
                await invoke("capture_enable", { projectPath, mode: "local" });
                await invoke("capture_register_cloud", {
                  projectPath,
                  orgId: view.draft.orgId,
                  slug: view.draft.slug,
                  name: null,
                  visibility: view.draft.restricted ? "restricted" : "org",
                  gitUrl: view.draft.gitUrl,
                });
                await invoke("capture_import_confirm", { projectPath });
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
                const result = await invoke<ConnectResult>("capture_connect", {
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
                const result = await invoke<ConnectResult>("capture_switch_project", {
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
                invoke("capture_promote", {
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
          <p className="mt-2 rounded-lg bg-[var(--atlas-status-error-background)] px-2.5 py-1.5 text-xs text-[var(--atlas-status-error-foreground)]">
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

/** What promotion publishes — the same three lines whether the destination is new or existing. */
function promotionLines(preview: PromotionPreview): string[] {
  return [
    `${preview.sessionCount} session${preview.sessionCount === 1 ? "" : "s"}`,
    dateRange(preview.earliest, preview.latest),
    `${preview.secretsRedacted} secret${preview.secretsRedacted === 1 ? "" : "s"} redacted before storage`,
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
      <p className="text-sm font-medium text-[var(--foreground)]">{title}</p>
      <ul className={cn(GROUP, "space-y-1")}>
        {lines.map((line) => (
          <li key={line} className="text-xs text-[var(--secondary-foreground)]">
            {line}
          </li>
        ))}
      </ul>
      <p className="text-2xs text-[var(--muted-foreground)]">
        This makes the above visible to your Organization. Nothing is sent until you confirm.
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
  const tone = stopped
    ? "var(--atlas-status-error-foreground)"
    : "var(--atlas-status-warning-foreground)";

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await invoke<CaptureHealth>("capture_retry_watcher", {
        projectPath,
        workspaceId: activeProjectId(),
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
        backgroundColor: stopped
          ? "var(--atlas-status-error-background)"
          : "var(--atlas-status-warning-background)",
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
              "flex items-center gap-1.5 text-xs",
              issue.state === "stopped"
                ? "text-[var(--atlas-status-error-foreground)]"
                : "text-[var(--atlas-status-warning-foreground)]",
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
      ? "var(--atlas-status-error-foreground)"
      : health?.state === "degraded"
        ? "var(--atlas-status-warning-foreground)"
        : "var(--atlas-status-success-foreground)";

  const active = blipAt(RADAR_BLIPS[blip]);

  return (
    <div
      className="relative overflow-hidden border-b border-[var(--atlas-element-hover)] bg-background/40"
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
          className="absolute rounded-full border-t border-dashed border-[var(--atlas-element-selected)]"
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
              "absolute size-[4px] rounded-full transition-colors duration-500",
              i === blip && live ? "" : "bg-foreground/20",
            )}
            style={{
              top: at.top - 2,
              left: at.left - 2,
              ...(i === blip && live
                ? {
                    backgroundColor: tone,
                    // The glow is the live capture tone, computed per render.
                    // ratchet-allow: a per-render hue has no static value to name.
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
        className="absolute size-[92px] rounded-full border border-[var(--atlas-element-selected)] bg-[var(--card)]"
        style={{ left: RADAR_ORIGIN_X - 46, top: RADAR_HEIGHT - 46 }}
      />

      <span className="absolute bottom-3 left-3.5 flex items-center gap-1.5">
        <CaptureDot live={live} tone={live ? "success" : "idle"} />
        <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
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
  gitAvailable,
  health,
  importPreview,
  cloudOrgs,
  cloudReason,
  busy,
  run,
  onReviewImport,
  onPromote,
  onSwitch,
}: {
  projectPath: string;
  binding: Binding;
  detection: Detection | null;
  /** Is `git` on this machine? Not whether this directory is a repository. */
  gitAvailable: boolean;
  health: CaptureHealth | null;
  importPreview: ImportPreview | null | undefined;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  /** Non-null when Cloud is unavailable, and why. Hides Promote. */
  cloudReason: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onReviewImport: () => void;
  onPromote: () => void;
  /** Cloud only: sync this Project to a different Cloud Project. */
  onSwitch: () => void;
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
       *  demanding anything. Sessions are already being captured either way.
       *  With no git on the machine there is nothing to offer, only to state. */}
      {!gitAvailable ? (
        <GitMissingBanner />
      ) : (
        detection &&
        !detection.isGitRepository && (
          <GitInitOffer
            busy={busy}
            onGitInit={() => void run(() => invoke("capture_git_init", { projectPath }))}
          />
        )
      )}

      {/* A Cloud Project whose bulk import was never approved imports
       *  nothing, forever, on purpose. Say so where it can be resolved. */}
      {binding.mode === "cloud" && !binding.importApproved && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-[var(--atlas-element-active)] px-2.5 py-1.5">
          <span className="text-xs text-[var(--secondary-foreground)]">
            History import is waiting for your review.
          </span>
          <button
            type="button"
            disabled={busy || !importPreview}
            onClick={onReviewImport}
            className="shrink-0 cursor-pointer rounded-full px-1.5 py-0.5 text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review
          </button>
        </div>
      )}

      {/* Failed rows: the retry is a deliberate human action, never automatic. */}
      {failed > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--atlas-status-warning-background)] px-2.5 py-1.5">
          <span className="text-xs text-[var(--atlas-status-warning-foreground)]">
            {failed} record{failed === 1 ? "" : "s"} could not be sent.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => invoke("capture_retry_failed", { projectPath }))}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={10} />
            Retry
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {/* Where this Project's Sessions live. A label, not a control — the
         *  way to change it is the Sync button beside it. */}
        <span className="mr-auto flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
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
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--muted-foreground)] opacity-40"
            >
              <Cloud size={11} />
              Sync
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onPromote}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-selected)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpRight size={11} />
              Sync
            </button>
          ))}

        {/* The Cloud counterpart of Sync: the destination is a choice, not a
         *  fact, and the way to change it lives beside the label that states
         *  it. Same availability rule as Sync — it needs the server. */}
        {binding.mode === "cloud" &&
          (cloudReason ? (
            <button
              type="button"
              disabled
              title={cloudReason}
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--muted-foreground)] opacity-40"
            >
              <ArrowLeftRight size={11} />
              Change
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onSwitch}
              title="Sync to a different Project"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-1 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-selected)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeftRight size={11} />
              Change
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
        <p className="text-xs text-[var(--muted-foreground)]">
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
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
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
                ? "Shared with your Organization."
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
              gitUrl={gitUrl}
              onGitUrlChange={(value) => {
                setGitUrlDirty(true);
                setGitUrl(value);
              }}
              restricted={restricted}
              onRestrictedChange={setRestricted}
            />
          )}

          <Detected detection={detection} importPreview={importPreview} />

          {!gitAvailable ? (
            <GitMissingBanner />
          ) : (
            detection &&
            !detection.isGitRepository && (
              <GitInitOffer
                busy={busy}
                onGitInit={() => void run(() => invoke("capture_git_init", { projectPath }))}
              />
            )
          )}

          {/* The preview read failed: Continue has nothing to disclose, so say
           *  so where it blocks, with the retry right there. */}
          {mode === "cloud" && importPreview === null && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--atlas-status-warning-background)] px-2.5 py-1.5">
              <span className="text-xs text-[var(--atlas-status-warning-foreground)]">
                Couldn't read this Project's history.
              </span>
              <button
                type="button"
                onClick={onRetryPreview}
                className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline"
              >
                <RefreshCw size={10} />
                Retry
              </button>
            </div>
          )}

          {/* Create only. The Connect tab is a list of existing Projects —
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
                  onCloudEnable({
                    orgId,
                    slug: slug.trim(),
                    gitUrl: gitUrl.trim(),
                    restricted,
                  });
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
  label = "Set up session capture",
}: {
  tab: PromoteTab;
  onTabChange: (tab: PromoteTab) => void;
  connectDisabled: boolean;
  /** Shown on hover, so the disabled tab explains itself in place. */
  connectReason: string | null;
  label?: string;
}) {
  // Pills rather than a segmented control: these are two *ways in*, not two
  // views of one thing, and the pill row is the same shape the feedback panel
  // uses for its categories.
  return (
    <div role="tablist" aria-label={label} className="flex gap-1">
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
              "h-6 rounded-full border px-2.5 text-xs transition-colors",
              disabled
                ? "cursor-not-allowed border-[var(--atlas-element-hover)] bg-[var(--atlas-element-hover)] text-[var(--muted-foreground)] opacity-40"
                : on
                  ? "cursor-pointer border-[var(--atlas-element-active)] bg-[var(--atlas-element-active)] text-[var(--foreground)]"
                  : "cursor-pointer border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-selected)] hover:text-[var(--secondary-foreground)]",
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

/** Org label + Slug, Repository URL and visibility, shared by Create-Cloud and Promote. */
function CloudFields({
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
  cloudOrgs: Array<Organisation & { remoteId: string }>;
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

/**
 * Connect this repository to a Project the Organisation already has.
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
  onContinue,
  excludeId = null,
}: {
  projectPath: string;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  cloudReason: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
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
  /** The server's reason for binding nothing, if it declined. */
  const [refused, setRefused] = useState<string | null>(null);
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
    setRefused(null);
    setListError(null);
    invoke<ConnectOptions>("capture_connect_options", { projectPath, orgId })
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

  if (cloudReason) {
    return (
      <p className={cn(GROUP, "flex items-start gap-1.5 text-xs text-[var(--muted-foreground)]")}>
        <Lock size={11} className="mt-px shrink-0" />
        {cloudReason}
      </p>
    );
  }

  const workspaces = options?.workspaces.filter((w) => w.id !== excludeId) ?? [];
  const project = workspaces.find((w) => w.id === selected);

  return (
    <div className="space-y-2">
      {options === undefined ? (
        <p className="flex items-center gap-1.5 py-2 text-xs text-[var(--muted-foreground)]">
          <Loader2 size={11} className="animate-spin" />
          Fetching this Organization's Projects…
        </p>
      ) : options === null ? (
        <p className="rounded-lg bg-[var(--atlas-status-warning-background)] px-2.5 py-1.5 text-xs text-[var(--atlas-status-warning-foreground)]">
          {listError
            ? `Could not list this Organization's Projects: ${listError}`
            : "Could not reach the server. Check the connection and reopen this tab."}
        </p>
      ) : workspaces.length === 0 ? (
        <p className={cn(GROUP, "text-xs text-[var(--muted-foreground)]")}>
          {excludeId
            ? "This Organization has no other Projects to sync to."
            : "This Organization has no Projects yet. Create one from the Create tab instead."}
        </p>
      ) : (
        <>
          {options.warning && (
            <p className="rounded-lg bg-[var(--atlas-status-warning-background)] px-2.5 py-1.5 text-xs text-[var(--atlas-status-warning-foreground)]">
              {options.warning}
            </p>
          )}
          {/* A dropdown rather than an inline list: the Organisation's Project
           *  count is unbounded and unpaged, and a scroller of them pushed the
           *  Connect button off the popover. The trigger states the current
           *  pick, which is the only part that has to be visible at rest. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                FIELD,
                "flex cursor-pointer items-center justify-between gap-2 text-left",
              )}
              aria-label="Project to connect to"
            >
              <span className="min-w-0 flex-1 truncate">
                {project ? (
                  <span className="font-mono text-xs text-[var(--foreground)]">{project.slug}</span>
                ) : (
                  <span className="text-xs text-[var(--muted-foreground)]">Choose a Project…</span>
                )}
              </span>
              <ChevronDown size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[220px] w-(--anchor-width)">
              {workspaces.map((remote) => (
                <DropdownMenuItem
                  key={remote.id}
                  onClick={() => setSelected(remote.id)}
                  className="items-start gap-2"
                >
                  <Check
                    size={11}
                    className={cn(
                      "mt-0.5 shrink-0",
                      selected === remote.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{remote.slug}</span>
                    {remote.gitUrl && (
                      <span className="block truncate text-2xs text-[var(--muted-foreground)]">
                        {remote.gitUrl}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {/* The server declined to bind. Not an error — several Projects share
       *  this repository's root commit, or none does — so the pick is handed
       *  back rather than reported as a failure. */}
      {refused && (
        <p className="rounded-lg bg-[var(--atlas-status-warning-background)] px-2.5 py-1.5 text-xs text-[var(--atlas-status-warning-foreground)]">
          {refused}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton
          busy={busy}
          disabled={!project}
          onClick={() => {
            if (!project) return;
            if (onContinue) {
              onContinue({ orgId, slug: project.slug, workspaceId: project.id });
              return;
            }
            setRefused(null);
            void run(async () => {
              // Connect needs a binding row to attach the Cloud identity to.
              await invoke("capture_enable", { projectPath, mode: "local" });
              const result = await invoke<ConnectResult>("capture_connect", {
                projectPath,
                orgId,
                slug: project.slug,
                workspaceId: project.id,
              });
              if (result.matched) return;
              setRefused(connectRefusal(result.candidates));
            });
          }}
          label={onContinue ? "Continue" : "Connect"}
        />
      </div>
    </div>
  );
}

/**
 * Cloud→Cloud step one: which other Project this one should sync to.
 *
 * The Connect picker in its no-mutation mode, minus the Project already synced
 * to. Nothing here changes anything — the disclosure step owns the move.
 */
function SwitchForm({
  projectPath,
  binding,
  cloudOrgs,
  cloudReason,
  busy,
  run,
  onCancel,
  onContinue,
}: {
  projectPath: string;
  binding: Binding;
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  cloudReason: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onCancel: () => void;
  onContinue: (pick: ConnectPick) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-[var(--foreground)]">Change Project</p>
      <p className="text-xs text-[var(--muted-foreground)]">
        Currently syncing to{" "}
        <span className="font-mono text-[var(--secondary-foreground)]">{binding.slug ?? "—"}</span>.
        Everything captured here will be re-sent to the Project you pick.
      </p>
      <ConnectTab
        projectPath={projectPath}
        cloudOrgs={cloudOrgs}
        cloudReason={cloudReason}
        busy={busy}
        run={run}
        onCancel={onCancel}
        onContinue={onContinue}
        excludeId={binding.remoteWorkspaceId}
      />
    </div>
  );
}

/** Promotion step one: pick the Organisation and Slug the history will live under. */
function PromoteForm({
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
  cloudOrgs: Array<Organisation & { remoteId: string }>;
  cloudReason: string | null;
  tab: PromoteTab;
  onTabChange: (tab: PromoteTab) => void;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
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
        <div key="create" className="atlas-fade-in space-y-2">
          <CloudFields
            cloudOrgs={cloudOrgs}
            slug={slug}
            onSlugChange={setSlug}
            slugState={slugState}
            gitUrl={gitUrl}
            onGitUrlChange={setGitUrl}
            restricted={restricted}
            onRestrictedChange={setRestricted}
            onConnectInstead={connectDisabled ? undefined : () => onTabChange("connect")}
          />
          <div className="flex justify-end gap-2 pt-1">
            <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
            <PrimaryButton
              busy={busy}
              disabled={!ready}
              onClick={() =>
                onContinue({ orgId, slug: slug.trim(), gitUrl: gitUrl.trim(), restricted })
              }
              label="Continue"
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
            onContinue={onConnectContinue}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The one affirmative action per view.
 *
 * Atlas has no accent *background* token — `--primary` is white, meant
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
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] disabled:cursor-not-allowed disabled:opacity-40"
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
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium leading-none text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
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
        selected && <Check size={10} className="text-[var(--foreground)]" />
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
      <p className="text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
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
        className={cn(
          "shrink-0",
          ok ? "text-[var(--secondary-foreground)]" : "text-[var(--atlas-text-disabled)]",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          mono && "font-mono",
          ok ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
        )}
      >
        {value}
      </span>
      <span className="shrink-0 text-3xs uppercase tracking-[0.08em] text-[var(--atlas-text-disabled)]">
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
        <Layers size={10} className="text-[var(--muted-foreground)]" />
        <span className="text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
          Timeline
        </span>
        <span className="ml-auto text-3xs text-[var(--atlas-text-disabled)]">preview</span>
      </div>

      <div className="relative mt-2">
        {/* The rail sits behind the nodes, centred on them: the dots are 7px, so
            a 1px line at 3px is their axis. Insetting it top and bottom stops it
            poking out past the first and last node. The nodes themselves are
            laid out in flow — hand-positioning them meant re-deriving a magic
            offset every time the row height changed. */}
        <span className="absolute bottom-[7px] left-[3px] top-[7px] w-px bg-[var(--atlas-element-active)]" />
        <span
          className="atlas-timeline-beam absolute left-[2px] top-[3px] h-2.5 w-[3px] rounded-full bg-[var(--atlas-status-success-foreground)]"
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
                    ? "border-[var(--atlas-status-success-foreground)] bg-[var(--atlas-status-success-foreground)]"
                    : "border-border-strong bg-[var(--card)]",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-2xs",
                  row.dot === "commit"
                    ? "font-mono text-[var(--secondary-foreground)]"
                    : "text-[var(--secondary-foreground)]",
                )}
              >
                {row.text}
              </span>
              <span className="shrink-0 text-3xs text-[var(--atlas-text-disabled)]">
                {row.meta}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 text-2xs text-[var(--muted-foreground)]">
        Every prompt, tool call and commit, kept on one thread you can reopen months later.
      </p>
    </div>
  );
}

/**
 * Git is not on this machine at all.
 *
 * Stated, not actionable: installing git is not something the popover can do,
 * and offering a button that opens a download page from inside a capture panel
 * would be a worse lie than saying nothing. Shown *instead of* `GitInitOffer`,
 * which would otherwise offer to run a binary that is not there.
 */
function GitMissingBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-[var(--atlas-status-warning-foreground)]/40 px-2.5 py-2">
      <GitBranch
        size={12}
        className="mt-0.5 shrink-0 text-[var(--atlas-status-warning-foreground)]"
      />
      <p className="min-w-0 text-xs text-[var(--secondary-foreground)]">
        Git is not installed on this machine. Sessions are still recorded, but they cannot be linked
        to commits and cannot be shared with an Organization.
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
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-[var(--atlas-element-active)] px-2.5 py-2">
      <GitBranch size={12} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
      <div className="min-w-0">
        <p className="text-xs text-[var(--secondary-foreground)]">
          Sessions are recorded here already. Initialize git to also link them to the commits they
          produce.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onGitInit}
          className="mt-1 cursor-pointer text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          Initialize git
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
