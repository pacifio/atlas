// Session capture: the titlebar dot, the capture popover, the health banner.
//
// The base scenario answered `capture_health` with `off`, which is the one
// state that renders *nothing*: no radar, no banner, no queue row, no failed
// records, and a grey dot. Every affordance in the 1,400-line popover hangs off
// a binding that did not exist, so the surface could not be looked at at all.
//
// So the fakes are per project path, and the three seeded Projects are three
// different shapes on purpose:
//
//   acme-app          Local, capturing, degraded — flagged Sessions and failed
//                     records, so both warning affordances are on screen.
//   …-experiments     Cloud, connected, and the worst case: a dead git watcher
//                     (stopped) over a revoked sync (degraded), with a bulk
//                     import still waiting for review.
//   docs              Never enabled, and not a git repository — the unbound
//                     form plus the `git init` offer, with an empty preview.
//
// Health is *computed* from that state rather than stored, mirroring
// `atlas_checkpoint::health::evaluate` including its worst-first ordering and
// one-issue summary, so a mutation shows up in the dot and the banner the way
// it would in the real app: enabling flips the state off `off`, retrying moves
// failed records into the pending queue, retrying the watcher clears a
// `stopped` issue and leaves whatever else is wrong on screen.
//
// Cloud lands here in full: create, connect and promote are all reachable from
// the UI now that the ingest service serves its read endpoints, and Connect
// exercises the server's refusal-to-guess answer as well as the happy path.

import { emit } from "@tauri-apps/api/event";
import type { SessionSummary } from "@/features/artifacts/types";
import type {
  Binding,
  CaptureHealth,
  ConnectOptions,
  ConnectResult,
  Detection,
  HealthIssue,
  HealthState,
  ImportPreview,
  PromotionPreview,
  RemoteWorkspace,
  SlugAvailability,
} from "@/features/capture/types";
import type { TypedHandlers, Unread } from "../types";
import { ALL_PROJECTS, MOCK_PROJECT } from "../project";

/** Fixed "now", so seeded dates never drift between reloads. */
const NOW = "2026-09-18T11:30:00Z";

const plural = (count: number) => (count === 1 ? "" : "s");

/** Everything the capture commands read and write for one Project. */
interface ProjectCapture {
  binding: Binding | null;
  detection: Detection;
  preview: ImportPreview;
  /** Counts health reports; the popover's retry moves failed → pending. */
  flaggedSessions: number;
  failedRows: number;
  pendingRows: number;
  /** A watcher this Project expects but does not have — the `stopped` issue
   *  that `capture_retry_watcher` is allowed to heal. */
  watcherStopped: boolean;
  /** How many local rows a promotion would flip to `pending`. */
  localRows: number;
  secretsRedacted: number;
}

function binding(over: Partial<Binding> & { workspaceId: string; root: string }): Binding {
  return {
    mode: "local",
    slug: null,
    orgId: null,
    rootCommitSha: null,
    fingerprintIsShallow: false,
    gitUrl: null,
    enabled: true,
    // Local never discloses anything, so approval is implicit — only the Cloud
    // paths below leave this false.
    importApproved: true,
    drainState: "ok",
    remoteWorkspaceId: null,
    createdAt: "2026-07-04T10:02:00Z",
    ...over,
  };
}

const PROJECTS = new Map<string, ProjectCapture>([
  [
    MOCK_PROJECT.path,
    {
      binding: binding({
        workspaceId: MOCK_PROJECT.id,
        root: MOCK_PROJECT.path,
        rootCommitSha: "9f2c1ab4d7e6058c3b1f24a97de0c5b8ef31a204",
        gitUrl: "https://github.com/acme/acme-app.git",
      }),
      detection: {
        root: MOCK_PROJECT.path,
        isGitRepository: true,
        hasCommits: true,
        rootCommitSha: "9f2c1ab4d7e6058c3b1f24a97de0c5b8ef31a204",
        isShallow: false,
        gitUrl: "https://github.com/acme/acme-app.git",
        suggestedSlug: "acme-app",
      },
      // 41 transcripts on disk, 12 of them not yet imported: the two numbers
      // have to differ or the disclosure copy ("N sessions on disk") reads the
      // same whichever one it leads with.
      preview: {
        sessionCount: 41,
        newSessionCount: 12,
        earliest: "2026-06-02T09:14:00Z",
        latest: "2026-09-17T18:42:00Z",
        totalBytes: 48_210_944,
        isBulkDisclosure: false,
      },
      flaggedSessions: 2,
      failedRows: 3,
      pendingRows: 12,
      watcherStopped: false,
      localRows: 386,
      secretsRedacted: 7,
    },
  ],
  [
    ALL_PROJECTS[1].path,
    {
      binding: binding({
        workspaceId: ALL_PROJECTS[1].id,
        root: ALL_PROJECTS[1].path,
        mode: "cloud",
        slug: "platform-migration",
        orgId: "remote-org-acme",
        remoteWorkspaceId: "rw_8c41f20b",
        rootCommitSha: "3ad90f7c22b41e8d5a6790cf1b4e2d83a0c95716",
        gitUrl: "https://github.com/acme/platform-migration.git",
        // A shallow clone's fingerprint is a graft boundary, so Connect warns
        // about it even on a match — this is the binding that shows it.
        fingerprintIsShallow: true,
        // Never confirmed, so the "History import is waiting for your review"
        // row is reachable: this Project imports nothing until it is.
        importApproved: false,
        // Terminal until re-registration — the `degraded` issue underneath the
        // watcher one, which is what makes the banner a two-line stack.
        drainState: "not_authorized",
      }),
      detection: {
        root: ALL_PROJECTS[1].path,
        isGitRepository: true,
        hasCommits: true,
        rootCommitSha: "3ad90f7c22b41e8d5a6790cf1b4e2d83a0c95716",
        isShallow: true,
        gitUrl: "https://github.com/acme/platform-migration.git",
        suggestedSlug: "platform-migration",
      },
      preview: {
        sessionCount: 8,
        newSessionCount: 8,
        earliest: "2026-08-30T08:05:00Z",
        latest: "2026-09-16T21:58:00Z",
        totalBytes: 6_402_311,
        isBulkDisclosure: true,
      },
      flaggedSessions: 0,
      failedRows: 0,
      // A backlog large enough that the queue row is worth reading.
      pendingRows: 128,
      watcherStopped: true,
      localRows: 0,
      secretsRedacted: 0,
    },
  ],
  [
    ALL_PROJECTS[2].path,
    {
      // The state a new user actually opens Atlas in: nothing enabled, nothing
      // recorded, and no repository either.
      binding: null,
      detection: {
        root: ALL_PROJECTS[2].path,
        isGitRepository: false,
        hasCommits: false,
        rootCommitSha: null,
        isShallow: false,
        gitUrl: null,
        suggestedSlug: "docs",
      },
      preview: {
        sessionCount: 0,
        newSessionCount: 0,
        earliest: null,
        latest: null,
        totalBytes: 0,
        isBulkDisclosure: false,
      },
      flaggedSessions: 0,
      failedRows: 0,
      pendingRows: 0,
      watcherStopped: false,
      localRows: 0,
      secretsRedacted: 0,
    },
  ],
]);

/** Any other path — a cloned repo, say — reads as an ordinary unbound project. */
function unknownProject(root: string): ProjectCapture {
  return {
    binding: null,
    detection: {
      root,
      isGitRepository: true,
      hasCommits: true,
      rootCommitSha: "1b7e4409a5c3f8021d66be95470a3c2df8e1b640",
      isShallow: false,
      gitUrl: null,
      suggestedSlug: root.split("/").pop() ?? "workspace",
    },
    preview: {
      sessionCount: 0,
      newSessionCount: 0,
      earliest: null,
      latest: null,
      totalBytes: 0,
      isBulkDisclosure: false,
    },
    flaggedSessions: 0,
    failedRows: 0,
    pendingRows: 0,
    watcherStopped: false,
    localRows: 0,
    secretsRedacted: 0,
  };
}

function projectFor(projectPath: unknown): ProjectCapture {
  const root = String(projectPath ?? "");
  let project = PROJECTS.get(root);
  if (!project) {
    project = unknownProject(root);
    PROJECTS.set(root, project);
  }
  return project;
}

/** The worker's announcement. Payload-less in Rust; the board just re-reads. */
const captureChanged = () => void emit("atlas:capture-changed");

// ── Health ────────────────────────────────────────────────────────────────

const off = (summary: string): CaptureHealth => ({
  state: "off",
  summary,
  issues: [],
  flaggedSessions: 0,
  failedRows: 0,
  pendingRows: 0,
});

/**
 * Mirrors `atlas_checkpoint::health::evaluate`, including the parts that are
 * easy to get wrong by hand: `off` is not a fault (so a paused Project shows
 * no red), issues sort worst-first, and a single issue is summarised as itself
 * rather than as a count of one.
 */
function healthOf(project: ProjectCapture): CaptureHealth {
  const bound = project.binding;
  if (!bound) return off("Session capture is off");
  if (!bound.enabled) return off("Session capture is paused");

  const issues: HealthIssue[] = [];
  if (project.watcherStopped) {
    issues.push({
      state: "stopped",
      reason: "Git watcher stopped — commits aren't being linked.",
      nextStep: "Click to retry. Commits made meanwhile are still picked up.",
    });
  }
  if (bound.mode === "cloud" && bound.drainState === "not_authorized") {
    issues.push({
      state: "degraded",
      reason:
        "No longer authorized to sync with your Organization — new work stays on this machine.",
      nextStep:
        "Reconnect or re-register this Project to resume syncing. Capture itself continues.",
    });
  }
  if (project.flaggedSessions > 0) {
    issues.push({
      state: "degraded",
      reason: `${project.flaggedSessions} Session${plural(project.flaggedSessions)} could not be fully recorded.`,
      nextStep:
        "Open the Session to see what was flagged. Content that could not be scrubbed was not stored.",
    });
  }
  if (project.failedRows > 0) {
    issues.push({
      state: "degraded",
      reason: `${project.failedRows} record${plural(project.failedRows)} could not be sent to your Organization.`,
      nextStep: "They are skipped so the rest keep syncing. Retry from the sync status.",
    });
  }

  const state: HealthState = issues.some((issue) => issue.state === "stopped")
    ? "stopped"
    : issues.length > 0
      ? "degraded"
      : "ok";

  const summary =
    issues.length === 0
      ? project.pendingRows > 0
        ? `${project.pendingRows} pending`
        : "Synced"
      : issues.length === 1
        ? issues[0].reason
        : `${state === "stopped" ? "Capture stopped" : "Capture degraded"} — ${issues.length} issues need attention`;

  return {
    state,
    summary,
    issues,
    flaggedSessions: project.flaggedSessions,
    failedRows: project.failedRows,
    pendingRows: project.pendingRows,
  };
}

// ── Cloud ─────────────────────────────────────────────────────────────────

/**
 * What the Organisation would list back. One entry shares this repository's
 * root commit (so Connect can preselect it), the rest do not — a list where
 * everything matches never exercises the picker.
 */
const REMOTE_WORKSPACES: RemoteWorkspace[] = [
  {
    id: "rw_8c41f20b",
    slug: "platform-migration",
    rootCommitSha: "3ad90f7c22b41e8d5a6790cf1b4e2d83a0c95716",
    gitUrl: "https://github.com/acme/platform-migration.git",
    name: "Platform Migration",
    visibility: "org",
  },
  {
    id: "rw_1d55e903",
    slug: "acme-app",
    rootCommitSha: "9f2c1ab4d7e6058c3b1f24a97de0c5b8ef31a204",
    gitUrl: "https://github.com/acme/acme-app.git",
    name: "Acme App",
    visibility: "org",
  },
  {
    // No remote at all: binds fine, and the row has to render without the
    // second line the others get.
    id: "rw_44b0c7de",
    slug: "internal-scratch",
    rootCommitSha: null,
    gitUrl: null,
    // Registered before the server carried a display name, and members-only.
    name: null,
    visibility: "restricted",
  },
  {
    id: "rw_9ae62f10",
    slug: "acme-design-tokens-and-theme-primitives",
    rootCommitSha: "aa7c30991fe2b48d05c7361a9e84bb2f7d0c5514",
    gitUrl: "https://github.com/acme/design-tokens.git",
    name: "Design Tokens",
    visibility: "org",
  },
];

/** Slugs the server already holds, so the field can say "taken" for real. */
const TAKEN_SLUGS = new Set(["acme-app", "platform-migration", "docs", "atlas"]);

// ── Sessions ──────────────────────────────────────────────────────────────

/**
 * The persisted record behind the chat usage popup.
 *
 * Deliberately cache-heavy and with no input/output split worth speaking of:
 * that is what an ACP session actually looks like, and it is the case where
 * `totalTokens` is 0 while `contextUsed` is the only real figure — the split
 * the popup has to survive. The title is long enough to need truncating.
 */
function sessionSummary(sessionId: string): SessionSummary {
  return {
    id: sessionId,
    title:
      "Move every user read onto the /v2 endpoints, keep the old client working behind a flag, and write the migration note",
    agent: "claude-code",
    model: "claude-opus-4",
    source: "acp",
    startedAt: "2026-09-18T09:02:41Z",
    updatedAt: NOW,
    lastActivityAt: "2026-09-18T11:24:08Z",
    activeSeconds: 2_148,
    wallSeconds: 8_887,
    messageCount: 34,
    toolCallCount: 96,
    checkpointCount: 4,
    branches: ["feature/auth-v2", "main"],
    insertions: 612,
    deletions: 288,
    filesTouched: 19,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 148_220,
    cacheReadTokens: 2_914_006,
    contextUsed: 118_400,
    contextSize: 200_000,
    needsAttention: false,
    attentionReason: null,
  };
}

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface CaptureResponses {
  capture_binding: Binding | null;
  capture_detect: Detection;
  capture_import_preview: ImportPreview;
  capture_health: CaptureHealth;
  capture_activate: Unread;
  capture_session_summary: SessionSummary | null;
  capture_enable: Unread;
  capture_disable: Unread;
  capture_git_init: Unread;
  capture_git_available: boolean;
  capture_retry_failed: Unread;
  capture_retry_watcher: CaptureHealth;
  capture_import_confirm: Unread;
  capture_slug_available: SlugAvailability;
  capture_connect_options: ConnectOptions;
  capture_register_cloud: Unread;
  capture_connect: ConnectResult;
  capture_switch_project: ConnectResult;
  capture_promotion_preview: PromotionPreview;
  capture_promote: Unread;
}

export const captureHandlers: TypedHandlers<CaptureResponses> = {
  // ── Reads ───────────────────────────────────────────────────────────────
  capture_binding: ({ projectPath }): Binding | null => projectFor(projectPath).binding,
  capture_detect: ({ projectPath }): Detection => projectFor(projectPath).detection,
  capture_import_preview: ({ projectPath }): ImportPreview => projectFor(projectPath).preview,
  capture_health: ({ projectPath }): CaptureHealth => healthOf(projectFor(projectPath)),
  // Fire-and-forget on Project activation: the real one opens the store and
  // kicks the import, neither of which has an answer.
  capture_activate: (): null => null,
  // The harness runs on a machine that has git; the banner is exercised by
  // flipping this to `false` by hand.
  capture_git_available: (): boolean => true,

  // `None` when capture is off for the project — the popup then has no session
  // section at all, rather than a row of zeroes.
  capture_session_summary: ({ projectPath, sessionId }): SessionSummary | null =>
    projectFor(projectPath).binding ? sessionSummary(String(sessionId)) : null,

  // ── Enable / disable ────────────────────────────────────────────────────
  capture_enable: ({ projectPath, mode }): Binding => {
    // Rejected exactly as Rust rejects it: a Cloud Project must be settled
    // server-side first, or its rows queue forever with nowhere to go.
    if (String(mode) === "cloud") {
      throw new Error("Cloud requires registration — use capture_register_cloud");
    }
    const project = projectFor(projectPath);
    const root = String(projectPath);
    project.binding = project.binding
      ? { ...project.binding, enabled: true }
      : binding({
          workspaceId:
            ALL_PROJECTS.find((project) => project.path === root)?.id ?? `ws-${root.length}`,
          root,
          rootCommitSha: project.detection.rootCommitSha,
          gitUrl: project.detection.gitUrl,
          fingerprintIsShallow: project.detection.isShallow,
          createdAt: NOW,
        });
    captureChanged();
    return project.binding;
  },

  capture_disable: ({ projectPath }): null => {
    const project = projectFor(projectPath);
    // Pausing is about *new* records: nothing recorded is deleted and the
    // queue keeps draining, so only `enabled` moves.
    if (project.binding) project.binding = { ...project.binding, enabled: false };
    captureChanged();
    return null;
  },

  // ── Repair ──────────────────────────────────────────────────────────────
  capture_git_init: ({ projectPath }): Binding | null => {
    const project = projectFor(projectPath);
    // A fresh `git init` has no commits yet, so there is still no fingerprint —
    // the offer unlocks commit linkage, it does not backfill one.
    project.detection = { ...project.detection, isGitRepository: true, hasCommits: false };
    captureChanged();
    // Null for a Project that was never enabled: the real command refuses to
    // create `.atlas/` as a side effect of re-detection.
    return project.binding;
  },

  capture_retry_failed: ({ projectPath }): number => {
    const project = projectFor(projectPath);
    const retried = project.failedRows;
    project.failedRows = 0;
    // Retry is `failed → pending`, not `failed → sent`: the queue grows by
    // exactly what the warning was counting.
    project.pendingRows += retried;
    captureChanged();
    return retried;
  },

  capture_retry_watcher: ({ projectPath }): CaptureHealth => {
    const project = projectFor(projectPath);
    // The restart succeeds here, so the banner loses its `stopped` line and
    // keeps whatever else was wrong — which is the point of answering with the
    // health that *results* rather than clearing optimistically.
    project.watcherStopped = false;
    captureChanged();
    return healthOf(project);
  },

  // ── Bulk import ─────────────────────────────────────────────────────────
  capture_import_confirm: ({ projectPath }): null => {
    const project = projectFor(projectPath);
    if (project.binding) project.binding = { ...project.binding, importApproved: true };
    // The approved transcripts join the same queue as everything else.
    project.pendingRows += project.preview.newSessionCount;
    project.preview = { ...project.preview, newSessionCount: 0 };
    captureChanged();
    return null;
  },

  // ── Cloud ───────────────────────────────────────────────────────────────
  capture_slug_available: ({ slug }): SlugAvailability => {
    const wanted = String(slug).trim();
    if (TAKEN_SLUGS.has(wanted)) return "taken";
    // "Couldn't check" is a third state, not a nicer way of saying taken — any
    // slug naming the outage reproduces it on demand.
    if (wanted.includes("offline")) return "unknown";
    return "available";
  },

  capture_connect_options: ({ orgId }): ConnectOptions => {
    // An Organisation with nothing in it yet: the picker has its own empty
    // state and no other fixture reaches it.
    if (String(orgId).endsWith("-empty")) {
      return { workspaces: [], preselected: null, warning: null };
    }
    return {
      workspaces: REMOTE_WORKSPACES,
      preselected: "rw_8c41f20b",
      // Preselected *and* warned: a shallow clone's fingerprint is a graft
      // boundary, so even a match is worth flagging.
      warning: "This is a shallow clone, so its fingerprint is not authoritative.",
    };
  },

  capture_register_cloud: ({ projectPath, orgId, slug }): Binding => {
    const project = projectFor(projectPath);
    // Registration needs a binding to read fingerprints from; the popover's
    // Confirm runs enable-Local first for exactly this reason.
    if (!project.binding) throw new Error("enable capture for this Project first");
    project.binding = {
      ...project.binding,
      mode: "cloud",
      slug: String(slug),
      orgId: String(orgId),
      remoteWorkspaceId: `rw_${String(slug).slice(0, 8)}`,
      // Registration alone discloses nothing — `capture_import_confirm` is the
      // only thing that sets this.
      importApproved: false,
      drainState: "ok",
    };
    captureChanged();
    return project.binding;
  },

  // The server, not the client, decides whether a pick binds. `internal-scratch`
  // stands in for the refusal-to-guess answer so the popover's ambiguous branch
  // is reachable without two repositories that share a root commit.
  capture_connect: ({ projectPath, orgId, slug, workspaceId }): ConnectResult => {
    const project = projectFor(projectPath);
    if (!project.binding) throw new Error("enable capture for this Project first");
    if (String(slug) === "internal-scratch") {
      return {
        binding: null,
        candidates: REMOTE_WORKSPACES.slice(0, 2),
        matched: false,
        moved: 0,
      };
    }
    project.binding = {
      ...project.binding,
      mode: "cloud",
      slug: String(slug),
      orgId: String(orgId),
      remoteWorkspaceId: String(workspaceId),
      importApproved: false,
      drainState: "ok",
    };
    captureChanged();
    return { binding: project.binding, candidates: [], matched: true, moved: 0 };
  },

  // Cloud→Cloud. The server has no move, so the whole history is re-queued
  // for the new destination — the pending count jumps by everything sent.
  capture_switch_project: ({ projectPath, orgId, slug, workspaceId }): ConnectResult => {
    const project = projectFor(projectPath);
    if (!project.binding) throw new Error("enable capture for this Project first");
    if (project.binding.mode !== "cloud") {
      throw new Error("this Project is not on Cloud yet — promote it first");
    }
    if (String(slug) === "internal-scratch") {
      return {
        binding: null,
        candidates: REMOTE_WORKSPACES.slice(0, 2),
        matched: false,
        moved: 0,
      };
    }
    // Everything already sent plus what failed against the old destination.
    const moved = project.preview.newSessionCount + project.failedRows;
    project.pendingRows += moved;
    project.failedRows = 0;
    project.binding = {
      ...project.binding,
      slug: String(slug),
      orgId: String(orgId),
      remoteWorkspaceId: String(workspaceId),
      drainState: "ok",
    };
    captureChanged();
    return { binding: project.binding, candidates: [], matched: true, moved };
  },

  capture_promotion_preview: ({ projectPath }): PromotionPreview => {
    const project = projectFor(projectPath);
    if (!project.binding) throw new Error("enable capture for this Project first");
    return {
      sessionCount: project.preview.sessionCount,
      earliest: project.preview.earliest,
      latest: project.preview.latest,
      secretsRedacted: project.secretsRedacted,
    };
  },

  capture_promote: ({ projectPath, orgId, slug }): number => {
    const project = projectFor(projectPath);
    if (!project.binding) throw new Error("enable capture for this Project first");
    // Promotion *is* flipping local rows to pending — there is no separate
    // backfill — so the pending queue jumps by the whole accumulated history.
    const promoted = project.localRows;
    project.localRows = 0;
    project.pendingRows += promoted;
    project.binding = {
      ...project.binding,
      mode: "cloud",
      slug: String(slug),
      orgId: String(orgId),
      remoteWorkspaceId: `rw_${String(slug).slice(0, 8)}`,
    };
    captureChanged();
    return promoted;
  },
};
